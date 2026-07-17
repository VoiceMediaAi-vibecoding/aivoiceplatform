"""Health + readiness + metrics endpoint contracts.

These tests pin the public contract of the observability surface. If you
change the response shape of /health, /health/ready, or /metrics, these
tests must change too — which is the point.
"""
from __future__ import annotations

import re


async def test_health_returns_200_with_liveness_fields(client):
    r = await client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["service"] == "api"
    assert isinstance(body["uptime_s"], (int, float))
    assert body["uptime_s"] >= 0


async def test_health_ready_returns_503_when_supabase_down(no_deps_client):
    r = await no_deps_client.get("/health/ready")
    assert r.status_code == 503
    body = r.json()
    assert body["status"] == "degraded"
    assert "supabase" in body["unhealthy"]
    assert body["deps"]["supabase"]["status"] == "down"
    assert body["deps"]["supabase"]["last_error"] == "test-seeded-down"


async def test_health_ready_returns_200_when_all_deps_up(client, ready_deps):
    r = await client.get("/health/ready")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "unhealthy" not in body
    for name, dep in body["deps"].items():
        assert dep["status"] == "up", f"{name} should be up, got {dep}"
        assert dep["last_error"] is None


async def test_metrics_exposes_process_and_dep_gauges(client, ready_deps):
    r = await client.get("/metrics")
    assert r.status_code == 200
    assert "text/plain" in r.headers["content-type"]
    text = r.text

    assert "api_uptime_seconds" in text
    assert "api_process_cpu_percent" in text
    assert "api_process_memory_rss_bytes" in text

    # Both deps should have value lines (set by ready_deps fixture).
    assert re.search(r'^dep_up\{dep="livekit"\}\s+1\.0', text, re.M), \
        "dep_up{dep=livekit} should be 1.0 after ready_deps fixture"
    assert re.search(r'^dep_up\{dep="supabase"\}\s+1\.0', text, re.M), \
        "dep_up{dep=supabase} should be 1.0 after ready_deps fixture"


async def test_http_requests_counter_increments(client):
    """After N hits to /health, the counter for that path should have
    increased by at least N. We parse the value rather than counting lines
    because Prometheus _created lines are emitted once and the counter value
    line is unique, but the value itself is what we care about."""
    def counter_value(text: str, path: str) -> float:
        m = re.search(
            rf'^http_requests_total\{{[^}}]*path="{re.escape(path)}"[^}}]*status="200"[^}}]*\}}\s+([\d.eE+-]+)',
            text, re.M,
        )
        return float(m.group(1)) if m else 0.0

    before = await client.get("/metrics")
    v_before = counter_value(before.text, "/health")

    for _ in range(5):
        r = await client.get("/health")
        assert r.status_code == 200

    after = await client.get("/metrics")
    v_after = counter_value(after.text, "/health")

    assert v_after >= v_before + 5, \
        f"counter should have grown by 5, was {v_before} → {v_after}"


async def test_health_ready_deps_payload_has_required_fields(client, ready_deps):
    r = await client.get("/health/ready")
    assert r.status_code == 200
    deps = r.json()["deps"]
    for name in ("livekit", "supabase"):
        assert name in deps
        d = deps[name]
        assert "status" in d
        assert "last_check_age_s" in d
        assert "probe_latency_ms" in d
        assert "last_error" in d


async def test_health_ready_degraded_lists_unhealthy_deps(no_deps_client):
    r = await no_deps_client.get("/health/ready")
    assert r.status_code == 503
    body = r.json()
    assert set(body["unhealthy"]) == {"livekit", "supabase"}
