"""Tests for POST /admin/agents — agent creation.

Pins the contract of the create-agent endpoint so future schema changes
don't silently break callers (admin dashboard, onboarding flows, etc.).

Key behaviors verified:
  - Auth required (admin JWT).
  - Required `name` field validated (422 on missing).
  - Optional `client_id` validated — 404 if client doesn't exist.
  - Platform defaults applied for omitted transport fields (LLM/STT/TTS).
  - Created row returned in response body.
"""
from __future__ import annotations

import pytest
import respx
from httpx import Response


SUPABASE_URL = "https://supabase.test"
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
    """Both Supabase auth.get_user AND admin_users lookup return success."""
    respx_mock.get(f"{SUPABASE_URL}/auth/v1/user").mock(
        return_value=Response(
            200,
            json={
                "id": TEST_ADMIN_UID,
                "aud": "authenticated",
                "role": "authenticated",
                "email": TEST_ADMIN_EMAIL,
                "phone": "",
                "app_metadata": {"provider": "email"},
                "user_metadata": {},
                "identities": [],
                "created_at": "2024-01-01T00:00:00Z",
                "updated_at": "2024-01-01T00:00:00Z",
            },
        )
    )
    respx_mock.get(f"{SUPABASE_URL}/rest/v1/admin_users").mock(
        return_value=Response(200, json=TEST_ADMIN_ROW)
    )
    return respx_mock


def _mock_insert_agent(
    respx_mock: respx.MockRouter, returning: dict
) -> None:
    """Mock the Supabase POST /rest/v1/agents that supabase-py issues for insert."""
    respx_mock.post(f"{SUPABASE_URL}/rest/v1/agents").mock(
        return_value=Response(201, json=[returning])
    )


def _mock_client_lookup(
    respx_mock: respx.MockRouter, found: bool
) -> None:
    """Mock the Supabase GET /rest/v1/clients?id=eq.X for client_id validation.

    supabase-py's `.maybe_single()` and `.single()` parse the response and
    check `len(parsed.data) == 1`. JSONAdapter returns the parsed JSON as-is
    (a dict stays a dict), so a non-empty object → len > 1 → "more than one
    row" error. We work around this by returning a single-element array,
    which parses to a list of length 1.
    """
    if found:
        respx_mock.get(f"{SUPABASE_URL}/rest/v1/clients").mock(
            return_value=Response(200, json=[{"id": "client-row-1", "name": "Acme Corp"}])
        )
    else:
        respx_mock.get(f"{SUPABASE_URL}/rest/v1/clients").mock(
            return_value=Response(200, json=[])
        )


# ── Auth ──────────────────────────────────────────────────────────────────

async def test_create_agent_requires_auth(client):
    r = await client.post(
        "/admin/agents",
        json={"name": "Test Agent"},
    )
    assert r.status_code == 401


# ── Validation ─────────────────────────────────────────────────────────────

async def test_create_agent_rejects_missing_name(client, admin_auth):
    r = await client.post(
        "/admin/agents",
        json={},
        headers=_admin_headers(),
        cookies=_admin_cookies(),
    )
    assert r.status_code == 422


async def test_create_agent_rejects_wrong_type_for_temperature(
    client, admin_auth
):
    r = await client.post(
        "/admin/agents",
        json={"name": "Test", "temperature": "not-a-number"},
        headers=_admin_headers(),
        cookies=_admin_cookies(),
    )
    assert r.status_code == 422


# ── Client validation ─────────────────────────────────────────────────────

async def test_create_agent_404s_when_client_does_not_exist(client, admin_auth):
    _mock_client_lookup(admin_auth, found=False)
    r = await client.post(
        "/admin/agents",
        json={"name": "Orphan Test", "client_id": "nonexistent-client-id"},
        headers=_admin_headers(),
        cookies=_admin_cookies(),
    )
    assert r.status_code == 404
    assert "not found" in r.json()["detail"].lower()


# ── Defaults ──────────────────────────────────────────────────────────────

async def test_create_agent_minimal_body_uses_defaults(
    client, admin_auth, respx_mock: respx.MockRouter
):
    """Only `name` required — everything else gets a sensible default."""
    _mock_insert_agent(admin_auth, returning={
        "id": "agent-new-1",
        "client_id": None,
        "name": "Minimal Agent",
        "voice_id": None,
        "lk_agent_name": "voice-agent",
        "tts_speed": 1.1,
        "llm_model": "gpt-4o",
        "stt_provider": "deepgram",
        "tts_provider": "elevenlabs",
        "stt_model": "nova-3",
        "tts_model": "eleven_turbo_v2_5",
        "language": "es",
        "temperature": 0.7,
    })
    r = await client.post(
        "/admin/agents",
        json={"name": "Minimal Agent"},
        headers=_admin_headers(),
        cookies=_admin_cookies(),
    )
    assert r.status_code == 201
    body = r.json()
    assert body["name"] == "Minimal Agent"
    assert body["llm_model"] == "gpt-4o"
    assert body["stt_provider"] == "deepgram"
    assert body["language"] == "es"


# ── Custom values pass through ────────────────────────────────────────────

async def test_create_agent_passes_through_custom_fields(
    client, admin_auth, respx_mock: respx.MockRouter
):
    """Custom model/provider values should be stored verbatim."""
    _mock_client_lookup(admin_auth, found=True)
    _mock_insert_agent(admin_auth, returning={
        "id": "agent-custom-1",
        "client_id": "client-row-1",
        "name": "Custom Agent",
        "voice_id": "voice-abc",
        "lk_agent_name": "voice-agent",
        "tts_speed": 0.9,
        "llm_model": "gpt-4-turbo",
        "stt_provider": "deepgram",
        "tts_provider": "inworld",
        "stt_model": "nova-3",
        "tts_model": "inworld_custom",
        "language": "en",
        "temperature": 0.3,
    })
    r = await client.post(
        "/admin/agents",
        json={
            "name": "Custom Agent",
            "client_id": "client-row-1",
            "voice_id": "voice-abc",
            "llm_model": "gpt-4-turbo",
            "tts_provider": "inworld",
            "tts_model": "inworld_custom",
            "language": "en",
            "temperature": 0.3,
            "tts_speed": 0.9,
        },
        headers=_admin_headers(),
        cookies=_admin_cookies(),
    )
    assert r.status_code == 201
    body = r.json()
    assert body["llm_model"] == "gpt-4-turbo"
    assert body["tts_provider"] == "inworld"
    assert body["temperature"] == 0.3
    assert body["client_id"] == "client-row-1"


# ── Request payload validation: client_id is optional ─────────────────────

async def test_create_agent_works_without_client_id_orphan(
    client, admin_auth, respx_mock: respx.MockRouter
):
    """client_id is OPTIONAL — unassigned ('orphan') agents are useful for
    solo/test/shared use cases. The endpoint must NOT require it."""
    _mock_insert_agent(admin_auth, returning={
        "id": "agent-orphan-1",
        "client_id": None,
        "name": "Orphan",
        "lk_agent_name": "voice-agent",
        "tts_speed": 1.1,
        "llm_model": "gpt-4o",
        "stt_provider": "deepgram",
        "tts_provider": "elevenlabs",
        "stt_model": "nova-3",
        "tts_model": "eleven_turbo_v2_5",
        "language": "es",
        "temperature": 0.7,
    })
    r = await client.post(
        "/admin/agents",
        json={"name": "Orphan"},
        headers=_admin_headers(),
        cookies=_admin_cookies(),
    )
    assert r.status_code == 201
    assert r.json()["client_id"] is None
