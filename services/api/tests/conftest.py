"""
Pytest fixtures for the api service.

Strategy: sandbox-mode testing. We spin up the FastAPI app in-process via
asgi-lifespan (so the lifespan context runs), set deterministic env vars,
and mock external HTTP calls (Supabase, LiveKit, Twilio) at the httpx
transport layer with respx. This gives us real route handling, real
middleware (including the metrics middleware), and real validation —
without ever touching production.
"""
from __future__ import annotations

import os
import pytest
import pytest_asyncio
from asgi_lifespan import LifespanManager
from httpx import ASGITransport, AsyncClient


@pytest.fixture(scope="session", autouse=True)
def _test_env():
    """Deterministic env for the whole test session. Anything the api reads
    via os.getenv at import time must be set BEFORE main.py is imported."""
    os.environ.update({
        "LIVEKIT_API_KEY": "test-api-key",
        "LIVEKIT_API_SECRET": "test-api-secret-thats-long-enough",
        "LIVEKIT_URL": "ws://livekit.test:7880",
        "SUPABASE_URL": "https://supabase.test",
        "SUPABASE_SERVICE_ROLE_KEY": "test-service-role-key",
        "SUPABASE_ANON_KEY": "test-anon-key",
        "FRONTEND_URL": "http://localhost:3000",
        # Twilio creds for tests that exercise phone-number provisioning.
        # Real Twilio endpoints are mocked at the respx layer.
        "TWILIO_ACCOUNT_SID": "ACtest1234567890",
        "TWILIO_AUTH_TOKEN": "test-auth-token",
        "TWILIO_ACCOUNT_SID_PA": "ACtest_PA_1234567890",
        "TWILIO_AUTH_TOKEN_PA": "test-auth-token-pa",
        # Don't let the probe loop race our seeded fixtures.
        "DISABLE_READINESS_PROBES": "1",
    })


@pytest_asyncio.fixture
async def client():
    """An httpx AsyncClient bound to the FastAPI app, with lifespan running.
    Use this as the entry point for all endpoint tests."""
    # Import inside the fixture so env vars are set first.
    from main import app

    async with LifespanManager(app):
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as ac:
            yield ac


@pytest_asyncio.fixture
async def no_deps_client():
    """Same as `client` but pre-seeds the readiness cache to 'down' for all
    deps so /health/ready returns 503. Useful for negative-path tests."""
    from main import (
        _dep_up,
        _dep_last_checked_monotonic,
        _dep_probe_latency_seconds,
        _dep_last_error,
        app,
    )
    import time as _time
    now = _time.monotonic()
    _dep_up.update({"livekit": 0, "supabase": 0})
    _dep_last_checked_monotonic.update({"livekit": now, "supabase": now})
    _dep_probe_latency_seconds.update({"livekit": 0.0, "supabase": 0.0})
    _dep_last_error.update({"livekit": "test-seeded-down", "supabase": "test-seeded-down"})

    async with LifespanManager(app):
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as ac:
            yield ac


@pytest.fixture
def ready_deps():
    """Mark all deps as UP for the duration of a test. Updates BOTH the
    in-memory cache (consumed by /health/ready) AND the Prometheus gauges
    (consumed by /metrics). Restores original state on teardown."""
    from main import (
        _dep_up as dep_up_dict,
        _dep_last_checked_monotonic as checked_dict,
        _dep_probe_latency_seconds as latency_dict,
        _dep_last_error as error_dict,
        dep_up as dep_up_gauge,
        dep_probe_latency_seconds as latency_gauge,
    )
    import time as _time
    now = _time.monotonic()
    saved_up = dict(dep_up_dict)
    saved_checked = dict(checked_dict)
    saved_latency = dict(latency_dict)
    saved_error = dict(error_dict)
    dep_up_dict.update({"livekit": 1, "supabase": 1})
    checked_dict.update({"livekit": now, "supabase": now})
    latency_dict.update({"livekit": 0.012, "supabase": 0.034})
    error_dict.update({"livekit": "", "supabase": ""})
    dep_up_gauge.labels(dep="livekit").set(1)
    dep_up_gauge.labels(dep="supabase").set(1)
    latency_gauge.labels(dep="livekit").set(0.012)
    latency_gauge.labels(dep="supabase").set(0.034)
    yield
    dep_up_dict.update(saved_up)
    checked_dict.update(saved_checked)
    latency_dict.update(saved_latency)
    error_dict.update(saved_error)
    dep_up_gauge.labels(dep="livekit").set(saved_up.get("livekit", 0))
    dep_up_gauge.labels(dep="supabase").set(saved_up.get("supabase", 0))
