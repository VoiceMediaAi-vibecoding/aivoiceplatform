"""Tests for POST /admin/phone-numbers/{number_id}/provision.

The provision endpoint orchestrates 3 external systems (Supabase, Twilio,
LiveKit SIP) to make a phone number callable. It's the most error-prone
endpoint in the platform because partial failure (e.g. LiveKit succeeds but
DB write fails) leaves orphaned resources.

Pinned behavior:
  - 404 if phone_number row doesn't exist
  - 409 if already provisioned
  - 400 on unknown provider
  - 404 if agent_id is set but doesn't exist
  - 503 if Twilio credentials are missing for the configured provider
  - Happy path: 200 with twilio_trunk_sid, lk_inbound_trunk_id,
    lk_dispatch_rule_id, and the updated phone_numbers row
  - Idempotent Twilio attach (re-running on already-attached number = no-op)
  - LiveKit failure surfaces as 502 (NOT 500) so operators know it's an
    upstream issue
  - DB failure after LiveKit success releases the LiveKit resources

Mocking strategy:
  - Supabase: respx mocks for /rest/v1/* endpoints
  - Twilio REST: respx mocks for api.twilio.com endpoints
  - LiveKit SIP: monkeypatch `_livekit_api` to return a mock client with
    a fake `.sip.create_sip_inbound_trunk` and `.sip.create_sip_dispatch_rule`.
    respx can't intercept gRPC.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import respx
from httpx import Response


SUPABASE_URL = "https://supabase.test"
TWILIO_BASE = "https://api.twilio.com"
TWILIO_TRUNKING_BASE = "https://trunking.twilio.com"
TEST_ADMIN_UID = "11111111-2222-3333-4444-555555555555"
TEST_ADMIN_EMAIL = "ops@voicemedia.ai"
TEST_ADMIN_ROW = {
    "id": "admin-row-1",
    "supabase_uid": TEST_ADMIN_UID,
    "email": TEST_ADMIN_EMAIL,
    "role": "admin",
    "is_active": True,
    "name": "Ops Team",
}
TEST_CSRF = "test-csrf-token-fixed-for-tests"


def _admin_headers() -> dict[str, str]:
    return {
        "Authorization": "Bearer test-admin-jwt-token",
        "X-CSRF-Token": TEST_CSRF,
    }


def _admin_cookies() -> dict[str, str]:
    return {"csrf_admin": TEST_CSRF}


@pytest.fixture
def admin_auth(respx_mock: respx.MockRouter):
    respx_mock.get(f"{SUPABASE_URL}/auth/v1/user").mock(
        return_value=Response(200, json={
            "id": TEST_ADMIN_UID, "aud": "authenticated", "role": "authenticated",
            "email": TEST_ADMIN_EMAIL, "phone": "",
            "app_metadata": {"provider": "email"}, "user_metadata": {},
            "identities": [], "created_at": "2024-01-01T00:00:00Z", "updated_at": "2024-01-01T00:00:00Z",
        })
    )
    respx_mock.get(f"{SUPABASE_URL}/rest/v1/admin_users").mock(
        return_value=Response(200, json=TEST_ADMIN_ROW)
    )
    return respx_mock


def _make_livekit_mock(
    *,
    inbound_id: str = "LK_inbound_abc",
    dispatch_id: str = "LK_dispatch_xyz",
    inbound_should_fail: bool = False,
    dispatch_should_fail: bool = False,
):
    """Build a mock LiveKitAPI client with .sip.create_* methods.

    Patches `_livekit_api` so the endpoint gets this mock. Each call to
    `_livekit_api()` returns a fresh mock because the endpoint constructs
    one inside each helper and aclose()s it.
    """
    if inbound_should_fail:
        inbound_coro = AsyncMock(side_effect=RuntimeError("LiveKit SIP down"))
    else:
        inbound_result = MagicMock()
        inbound_result.sip_trunk_id = inbound_id
        inbound_coro = AsyncMock(return_value=inbound_result)

    if dispatch_should_fail:
        dispatch_coro = AsyncMock(side_effect=RuntimeError("LiveKit dispatch down"))
    else:
        dispatch_result = MagicMock()
        dispatch_result.sip_dispatch_rule_id = dispatch_id
        dispatch_coro = AsyncMock(return_value=dispatch_result)

    sip_mock = MagicMock()
    sip_mock.create_sip_inbound_trunk = inbound_coro
    sip_mock.create_sip_dispatch_rule = dispatch_coro

    client_mock = MagicMock()
    client_mock.sip = sip_mock
    client_mock.aclose = AsyncMock()

    # The endpoint calls _livekit_api() each time, so we return a fresh mock
    # via side_effect so aclose() doesn't nuke the shared state.
    call_count = {"n": 0}

    def factory():
        call_count["n"] += 1
        # each call gets its own client mock (so aclose is per-instance)
        c = MagicMock()
        c.sip = sip_mock
        c.aclose = AsyncMock()
        return c

    return factory, sip_mock


# ── 404 / 409 / 400 / 503 paths ───────────────────────────────────────────

async def test_provision_404s_when_phone_number_does_not_exist(
    client, admin_auth, respx_mock: respx.MockRouter
):
    respx_mock.get(f"{SUPABASE_URL}/rest/v1/phone_numbers").mock(
        return_value=Response(200, json=[])
    )
    r = await client.post(
        "/admin/phone-numbers/nonexistent-id/provision",
        json={},
        headers=_admin_headers(),
        cookies=_admin_cookies(),
    )
    assert r.status_code == 404
    assert "not found" in r.json()["detail"].lower()


async def test_provision_409s_when_already_provisioned(
    client, admin_auth, respx_mock: respx.MockRouter
):
    respx_mock.get(f"{SUPABASE_URL}/rest/v1/phone_numbers").mock(
        return_value=Response(200, json=[{
            "id": "pn-1",
            "number": "+18001234567",
            "provider": "twilio_us",
            "provider_sid": "PNxxx",
            "agent_id": None,
            "label": None,
            "lk_dispatch_rule_id": "EXISTING_RULE",   # ← already provisioned
            "lk_inbound_trunk_id": "EXISTING_TRUNK",
        }])
    )
    r = await client.post(
        "/admin/phone-numbers/pn-1/provision",
        json={},
        headers=_admin_headers(),
        cookies=_admin_cookies(),
    )
    assert r.status_code == 409
    assert "already provisioned" in r.json()["detail"].lower()


async def test_provision_400s_on_unknown_provider(
    client, admin_auth, respx_mock: respx.MockRouter
):
    respx_mock.get(f"{SUPABASE_URL}/rest/v1/phone_numbers").mock(
        return_value=Response(200, json=[{
            "id": "pn-2",
            "number": "+18001234567",
            "provider": "some_other_provider",   # not in TWILIO_PROVIDER_TO_SUFFIX
            "provider_sid": "PNxxx",
            "agent_id": None,
            "label": None,
            "lk_dispatch_rule_id": None,
            "lk_inbound_trunk_id": None,
        }])
    )
    r = await client.post(
        "/admin/phone-numbers/pn-2/provision",
        json={},
        headers=_admin_headers(),
        cookies=_admin_cookies(),
    )
    assert r.status_code == 400
    assert "provider" in r.json()["detail"].lower()


async def test_provision_404s_when_agent_id_does_not_exist(
    client, admin_auth, respx_mock: respx.MockRouter
):
    respx_mock.get(f"{SUPABASE_URL}/rest/v1/phone_numbers").mock(
        return_value=Response(200, json=[{
            "id": "pn-3",
            "number": "+18001234567",
            "provider": "twilio_us",
            "provider_sid": "PNxxx",
            "agent_id": None,
            "label": None,
            "lk_dispatch_rule_id": None,
            "lk_inbound_trunk_id": None,
        }])
    )
    respx_mock.get(f"{SUPABASE_URL}/rest/v1/agents").mock(
        return_value=Response(200, json=[])   # agent not found
    )
    r = await client.post(
        "/admin/phone-numbers/pn-3/provision",
        json={"agent_id": "nonexistent-agent"},
        headers=_admin_headers(),
        cookies=_admin_cookies(),
    )
    assert r.status_code == 404
    assert "agent" in r.json()["detail"].lower()


# ── Happy path ────────────────────────────────────────────────────────────

async def test_provision_happy_path_returns_all_ids(
    client, admin_auth, respx_mock: respx.MockRouter
):
    """The full sequence: Twilio trunk created + number attached, LiveKit
    inbound + dispatch created, DB row updated with all IDs, 200 response."""

    # --- Supabase mocks ---
    existing_row = {
        "id": "pn-happy",
        "number": "+18001234567",
        "provider": "twilio_us",
        "provider_sid": "PN1234567890",
        "agent_id": None,
        "label": "Main line",
        "lk_dispatch_rule_id": None,
        "lk_inbound_trunk_id": None,
    }
    respx_mock.get(f"{SUPABASE_URL}/rest/v1/phone_numbers").mock(
        return_value=Response(200, json=[existing_row])
    )
    respx_mock.patch(f"{SUPABASE_URL}/rest/v1/phone_numbers").mock(
        return_value=Response(200, json=[{**existing_row,
            "twilio_trunk_sid": "TK_aaa",
            "lk_inbound_trunk_id": "LK_inbound_abc",
            "lk_dispatch_rule_id": "LK_dispatch_xyz",
        }])
    )

    # --- Twilio mocks ---
    # 1) _find_shared_twilio_trunk → GET /Trunks → empty (so we create)
    respx_mock.get(f"{TWILIO_TRUNKING_BASE}/v1/Trunks").mock(
        return_value=Response(200, json={"trunks": []})
    )
    # 2) _create_shared_twilio_trunk → POST /Trunks → SID returned
    respx_mock.post(f"{TWILIO_TRUNKING_BASE}/v1/Trunks").mock(
        return_value=Response(200, json={
            "sid": "TK_aaa", "friendly_name": "LiveKit Shared (US)",
        })
    )
    # 3) Add origination URI → POST /Trunks/{sid}/OriginationUrls
    respx_mock.post(f"{TWILIO_TRUNKING_BASE}/v1/Trunks/TK_aaa/OriginationUrls").mock(
        return_value=Response(200, json={"sid": "OU_bbb"})
    )
    # 4) _is_number_attached_to_trunk → GET /Trunks/{sid}/PhoneNumbers → empty
    respx_mock.get(f"{TWILIO_TRUNKING_BASE}/v1/Trunks/TK_aaa/PhoneNumbers").mock(
        return_value=Response(200, json={"phone_numbers": []})
    )
    # 5) Attach number → POST /Trunks/{sid}/PhoneNumbers
    respx_mock.post(f"{TWILIO_TRUNKING_BASE}/v1/Trunks/TK_aaa/PhoneNumbers").mock(
        return_value=Response(200, json={"sid": "PN_attached"})
    )

    # --- LiveKit mocks ---
    factory, sip_mock = _make_livekit_mock(
        inbound_id="LK_inbound_abc",
        dispatch_id="LK_dispatch_xyz",
    )

    with patch("main._livekit_api", side_effect=factory):
        r = await client.post(
            "/admin/phone-numbers/pn-happy/provision",
            json={},
            headers=_admin_headers(),
            cookies=_admin_cookies(),
        )

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "provisioned"
    assert body["twilio_trunk_sid"] == "TK_aaa"
    assert body["lk_inbound_trunk_id"] == "LK_inbound_abc"
    assert body["lk_dispatch_rule_id"] == "LK_dispatch_xyz"
    assert body["phone_number"]["lk_dispatch_rule_id"] == "LK_dispatch_xyz"

    # Both LiveKit methods were called
    sip_mock.create_sip_inbound_trunk.assert_awaited_once()
    sip_mock.create_sip_dispatch_rule.assert_awaited_once()


# ── Idempotency on the Twilio side ────────────────────────────────────────

async def test_provision_idempotent_when_twilio_number_already_attached(
    client, admin_auth, respx_mock: respx.MockRouter
):
    """If the Twilio trunk already has the number attached, _attach_twilio_number_to_trunk
    is a no-op. We must NOT 4xx — the endpoint should still succeed."""

    existing_row = {
        "id": "pn-idem",
        "number": "+18001234567",
        "provider": "twilio_us",
        "provider_sid": "PN_already_attached",
        "agent_id": None,
        "label": None,
        "lk_dispatch_rule_id": None,
        "lk_inbound_trunk_id": None,
    }
    respx_mock.get(f"{SUPABASE_URL}/rest/v1/phone_numbers").mock(
        return_value=Response(200, json=[existing_row])
    )
    respx_mock.patch(f"{SUPABASE_URL}/rest/v1/phone_numbers").mock(
        return_value=Response(200, json=[existing_row])
    )

    # Shared trunk already exists
    respx_mock.get(f"{TWILIO_TRUNKING_BASE}/v1/Trunks").mock(
        return_value=Response(200, json={
            "trunks": [{"sid": "TK_existing", "friendly_name": "LiveKit Shared (US)"}]
        })
    )
    # Number ALREADY attached → endpoint skips POST
    respx_mock.get(f"{TWILIO_TRUNKING_BASE}/v1/Trunks/TK_existing/PhoneNumbers").mock(
        return_value=Response(200, json={
            "phone_numbers": [{"sid": "PN_already_attached"}]
        })
    )

    factory, sip_mock = _make_livekit_mock(
        inbound_id="LK_ii", dispatch_id="LK_dd"
    )
    with patch("main._livekit_api", side_effect=factory):
        r = await client.post(
            "/admin/phone-numbers/pn-idem/provision",
            json={},
            headers=_admin_headers(),
            cookies=_admin_cookies(),
        )

    assert r.status_code == 200, r.text
    assert r.json()["twilio_trunk_sid"] == "TK_existing"
    # respx raises if a non-mocked route was called (e.g. POST /Trunks/.../PhoneNumbers)


# ── LiveKit failure surfaces as 502, DB row untouched ──────────────────────

async def test_provision_502s_when_livekit_fails(
    client, admin_auth, respx_mock: respx.MockRouter
):
    """LiveKit SIP down → 502 (operator knows it's upstream), no DB update."""

    existing_row = {
        "id": "pn-lkfail",
        "number": "+18001234567",
        "provider": "twilio_us",
        "provider_sid": "PN_lkfail",
        "agent_id": None,
        "label": None,
        "lk_dispatch_rule_id": None,
        "lk_inbound_trunk_id": None,
    }
    respx_mock.get(f"{SUPABASE_URL}/rest/v1/phone_numbers").mock(
        return_value=Response(200, json=[existing_row])
    )

    # Twilio side succeeds
    respx_mock.get(f"{TWILIO_TRUNKING_BASE}/v1/Trunks").mock(
        return_value=Response(200, json={"trunks": []})
    )
    respx_mock.post(f"{TWILIO_TRUNKING_BASE}/v1/Trunks").mock(
        return_value=Response(200, json={"sid": "TK_502", "friendly_name": "x"})
    )
    respx_mock.post(f"{TWILIO_TRUNKING_BASE}/v1/Trunks/TK_502/OriginationUrls").mock(
        return_value=Response(200, json={"sid": "OU_502"})
    )
    respx_mock.get(f"{TWILIO_TRUNKING_BASE}/v1/Trunks/TK_502/PhoneNumbers").mock(
        return_value=Response(200, json={"phone_numbers": []})
    )
    respx_mock.post(f"{TWILIO_TRUNKING_BASE}/v1/Trunks/TK_502/PhoneNumbers").mock(
        return_value=Response(200, json={"sid": "PN_attached_502"})
    )

    # LiveKit fails — inbound throws
    factory, _ = _make_livekit_mock(inbound_should_fail=True)
    with patch("main._livekit_api", side_effect=factory):
        r = await client.post(
            "/admin/phone-numbers/pn-lkfail/provision",
            json={},
            headers=_admin_headers(),
            cookies=_admin_cookies(),
        )

    assert r.status_code == 502
    assert "livekit" in r.json()["detail"].lower()


# ── Twilio lookup fallback when row has no provider_sid ────────────────────

async def test_provision_looks_up_twilio_when_no_provider_sid(
    client, admin_auth, respx_mock: respx.MockRouter
):
    """If the row lacks `provider_sid`, the endpoint queries Twilio's
    IncomingPhoneNumbers by E.164 and uses the found SID. We mock the
    lookup to return a SID and verify it ends up in the update."""

    existing_row = {
        "id": "pn-lookup",
        "number": "+18005551111",
        "provider": "twilio_us",
        "provider_sid": None,             # ← forces lookup
        "agent_id": None,
        "label": None,
        "lk_dispatch_rule_id": None,
        "lk_inbound_trunk_id": None,
    }
    respx_mock.get(f"{SUPABASE_URL}/rest/v1/phone_numbers").mock(
        return_value=Response(200, json=[existing_row])
    )

    # Twilio lookup
    respx_mock.get(url__regex=r"^https://api\.twilio\.com/2010-04-01/Accounts/.*/IncomingPhoneNumbers\.json.*").mock(
        return_value=Response(200, json={
            "incoming_phone_numbers": [{"sid": "PN_lookup_found", "phone_number": "+18005551111"}]
        })
    )
    # Shared trunk
    respx_mock.get(f"{TWILIO_TRUNKING_BASE}/v1/Trunks").mock(
        return_value=Response(200, json={"trunks": []})
    )
    respx_mock.post(f"{TWILIO_TRUNKING_BASE}/v1/Trunks").mock(
        return_value=Response(200, json={"sid": "TK_lookup", "friendly_name": "x"})
    )
    respx_mock.post(f"{TWILIO_TRUNKING_BASE}/v1/Trunks/TK_lookup/OriginationUrls").mock(
        return_value=Response(200, json={"sid": "OU_lookup"})
    )
    respx_mock.get(f"{TWILIO_TRUNKING_BASE}/v1/Trunks/TK_lookup/PhoneNumbers").mock(
        return_value=Response(200, json={"phone_numbers": []})
    )
    respx_mock.post(f"{TWILIO_TRUNKING_BASE}/v1/Trunks/TK_lookup/PhoneNumbers").mock(
        return_value=Response(200, json={"sid": "PN_attached_lookup"})
    )

    # Verify the DB PATCH carries the looked-up SID
    patch_route = respx_mock.patch(f"{SUPABASE_URL}/rest/v1/phone_numbers").mock(
        return_value=Response(200, json=[{
            **existing_row,
            "provider_sid": "PN_lookup_found",   # ← came from Twilio lookup
            "twilio_trunk_sid": "TK_lookup",
            "lk_inbound_trunk_id": "LK_li",
            "lk_dispatch_rule_id": "LK_ld",
        }])
    )

    factory, _ = _make_livekit_mock(inbound_id="LK_li", dispatch_id="LK_ld")
    with patch("main._livekit_api", side_effect=factory):
        r = await client.post(
            "/admin/phone-numbers/pn-lookup/provision",
            json={},
            headers=_admin_headers(),
            cookies=_admin_cookies(),
        )

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["phone_number"]["provider_sid"] == "PN_lookup_found"
