"""Tests for POST /token — LiveKit access token issuance.

The /token endpoint is the most-called API in the system (every dashboard
load, every agent join) and the one most likely to leak if auth breaks.
These tests pin the security-critical behavior:

  - Unauthenticated requests are rejected (401).
  - The admin identity comes from the SUPABASE user record, NEVER from
    caller-supplied input (prevents impersonation).
  - Room names are whitelisted to `call-*` and `room-agent-*` (prevents
    joining arbitrary rooms).
  - Room names are character-validated (prevents injection).
  - The returned JWT contains the expected identity, room, and grants.

External dependencies (Supabase auth + rest, LiveKit token signing) are
mocked at the HTTP boundary with respx. AccessToken.to_jwt() is the real
LiveKit SDK — we just verify its output shape.
"""
from __future__ import annotations

import base64
import json

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


def _bearer() -> dict[str, str]:
    return {"Authorization": "Bearer test-admin-jwt-token"}


# CSRF is required on POST / PUT / PATCH / DELETE for any authenticated admin
# request — see _get_admin_from_cookie_or_bearer at services/api/main.py:1281.
# The endpoint aliases _get_admin_from_token → that same function (line 1334),
# so even Bearer-authenticated POSTs must present a matching CSRF cookie +
# X-CSRF-Token header pair.
TEST_CSRF = "test-csrf-token-fixed-for-tests"


def _bearer_with_csrf() -> dict[str, str]:
    return {
        "Authorization": "Bearer test-admin-jwt-token",
        "X-CSRF-Token": TEST_CSRF,
    }


def _csrf_cookies() -> dict[str, str]:
    return {"csrf_admin": TEST_CSRF}


def _mock_supabase_auth_ok(respx_mock: respx.MockRouter, uid: str = TEST_ADMIN_UID) -> None:
    """Mock the Supabase auth.get_user() HTTP call that supabase-py makes.

    The real Supabase response wraps the user in a `user` field and includes
    several required metadata fields. We mirror that shape so supabase-py's
    UserResponse parser accepts it.
    """
    respx_mock.get(f"{SUPABASE_URL}/auth/v1/user").mock(
        return_value=Response(
            200,
            json={
                "id": uid,
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


def _mock_supabase_admin_lookup_ok(
    respx_mock: respx.MockRouter, uid: str = TEST_ADMIN_UID, row: dict | None = None
) -> None:
    """Mock the Supabase rest/v1/admin_users query that supabase-py makes.

    Note: supabase-py's .single() sets the header that tells PostgREST to
    return a single object instead of an array. The real API returns the
    unwrapped dict. We mirror that shape here — returning an array makes
    the .get('is_active') call on result.data raise AttributeError, which
    the endpoint surfaces as 401 "Invalid token".
    """
    respx_mock.get(f"{SUPABASE_URL}/rest/v1/admin_users").mock(
        return_value=Response(200, json=row or TEST_ADMIN_ROW)
    )


def _decode_jwt_payload(token: str) -> dict:
    """Decode the body of a JWT (no signature verification — that's LiveKit's job)."""
    body = token.split(".")[1]
    # base64url decode with padding
    body += "=" * (-len(body) % 4)
    return json.loads(base64.urlsafe_b64decode(body))


@pytest.fixture
def admin_auth(respx_mock: respx.MockRouter):
    """Both Supabase auth.get_user AND admin_users lookup return success."""
    _mock_supabase_auth_ok(respx_mock)
    _mock_supabase_admin_lookup_ok(respx_mock)
    return respx_mock


# ── Auth gating ────────────────────────────────────────────────────────────

async def test_token_rejects_request_without_bearer(client):
    r = await client.post("/token", json={"room_name": "call-test-room"})
    assert r.status_code == 401


async def test_token_rejects_invalid_supabase_jwt(client, respx_mock: respx.MockRouter):
    respx_mock.get(f"{SUPABASE_URL}/auth/v1/user").mock(
        return_value=Response(401, json={"message": "invalid_token"})
    )
    r = await client.post(
        "/token",
        json={"room_name": "call-test-room"},
        headers=_bearer_with_csrf(),
        cookies=_csrf_cookies(),
    )
    assert r.status_code == 401


async def test_token_rejects_when_admin_user_missing(
    client, respx_mock: respx.MockRouter
):
    """Empty admin_users result → 403 Admin not found."""
    _mock_supabase_auth_ok(respx_mock)
    # Real PostgREST with .single() returns 406 (Not Acceptable) when no rows
    # match. supabase-py raises on that. We match by returning an empty body
    # that triggers the same parse path.
    respx_mock.get(f"{SUPABASE_URL}/rest/v1/admin_users").mock(
        return_value=Response(406, json={"message": "No rows found"})
    )
    r = await client.post(
        "/token",
        json={"room_name": "call-test-room"},
        headers=_bearer_with_csrf(),
        cookies=_csrf_cookies(),
    )
    assert r.status_code in (401, 403)


# ── Room name validation ───────────────────────────────────────────────────

@pytest.mark.parametrize("bad_room", [
    "",
    " ",
    "foo-bar",                    # wrong prefix
    "room-test-1234",             # wrong prefix (only `call-*` and `room-agent*`)
    "call-bad/slash",             # bad chars (regex rejects)
    "call-bad space",             # bad chars
    "call-bad$dollar",            # bad chars
])
async def test_token_rejects_invalid_room_names(client, admin_auth, bad_room):
    r = await client.post(
        "/token",
        json={"room_name": bad_room},
        headers=_bearer_with_csrf(),
        cookies=_csrf_cookies(),
    )
    assert r.status_code in (400, 422), \
        f"expected 400/422 for room={bad_room!r}, got {r.status_code}"


@pytest.mark.parametrize("good_room", [
    "call-test-123",
    "call-+18001234567-abcd",
    "room-agent-1",
    "room-agent-playground-42",
])
async def test_token_accepts_whitelisted_room_names(client, admin_auth, good_room):
    r = await client.post(
        "/token",
        json={"room_name": good_room},
        headers=_bearer_with_csrf(),
        cookies=_csrf_cookies(),
    )
    assert r.status_code == 200, f"good room {good_room!r} rejected: {r.text}"
    body = r.json()
    assert body["room_name"] == good_room


# ── Identity is forced to admin email (CRITICAL security) ─────────────────

async def test_token_identity_is_forced_to_admin_email(client, admin_auth):
    """Caller can request any identity — endpoint MUST override with admin email."""
    r = await client.post(
        "/token",
        json={"room_name": "call-test-1", "identity": "attacker-controlled-id"},
        headers=_bearer_with_csrf(),
        cookies=_csrf_cookies(),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["identity"] == TEST_ADMIN_EMAIL, \
        "identity must be the admin's email, never caller-supplied"
    assert body["identity"] != "attacker-controlled-id"


async def test_token_identity_uses_id_prefix_when_admin_has_no_email(
    client, respx_mock: respx.MockRouter
):
    """Fallback: if the admin row has no email, identity = 'admin-<id-prefix>'."""
    admin_without_email = {**TEST_ADMIN_ROW, "email": ""}
    _mock_supabase_auth_ok(respx_mock)
    _mock_supabase_admin_lookup_ok(respx_mock, row=admin_without_email)
    r = await client.post(
        "/token",
        json={"room_name": "call-test-1"},
        headers=_bearer_with_csrf(),
        cookies=_csrf_cookies(),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["identity"].startswith("admin-")
    assert "admin-row-1"[:8] in body["identity"]


# ── JWT contents ───────────────────────────────────────────────────────────

async def test_token_returns_valid_jwt_with_expected_claims(client, admin_auth):
    r = await client.post(
        "/token",
        json={"room_name": "call-supabase-uid-test"},
        headers=_bearer_with_csrf(),
        cookies=_csrf_cookies(),
    )
    assert r.status_code == 200
    body = r.json()

    # Response shape
    assert "token" in body
    assert body["room_name"] == "call-supabase-uid-test"
    assert body["identity"] == TEST_ADMIN_EMAIL
    assert body["livekit_url"].startswith("ws")

    # JWT structure: 3 base64url segments
    parts = body["token"].split(".")
    assert len(parts) == 3, f"JWT must have 3 segments, got {len(parts)}"

    # JWT payload contains the expected grants
    claims = _decode_jwt_payload(body["token"])
    assert claims["sub"] == TEST_ADMIN_EMAIL  # identity
    assert claims["video"]["room"] == "call-supabase-uid-test"
    assert claims["video"]["roomJoin"] is True


async def test_token_uses_livekit_public_url_not_docker_internal(
    client, admin_auth, monkeypatch
):
    """The browser connects from outside Docker — it needs the PUBLIC LiveKit URL,
    not the in-network ws://livekit:7880 used by server-side workers."""
    monkeypatch.setenv("LIVEKIT_PUBLIC_URL", "wss://livekit.voicemedia.ai")
    r = await client.post(
        "/token",
        json={"room_name": "call-test-1"},
        headers=_bearer_with_csrf(),
        cookies=_csrf_cookies(),
    )
    assert r.json()["livekit_url"] == "wss://livekit.voicemedia.ai"
