"""
FastAPI backend: generates LiveKit tokens and exposes cost/session data from Supabase.
"""
from __future__ import annotations

import os
import re
import uuid
import json
import hmac
import logging
import urllib.parse
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "../../.env"))

import asyncio
import csv
import io
import subprocess
import sys

from fastapi import FastAPI, HTTPException, UploadFile, File, BackgroundTasks, Depends, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, field_validator
from typing import Literal
from livekit.api import AccessToken, VideoGrants

# ── S5 — Observability primitives ────────────────────────────────────────────
# Module-level so the HTTP middleware below can mutate them on every request.
# The /metrics endpoint exposes them in Prometheus exposition format.
import time as _time
import psutil as _psutil
from prometheus_client import Counter, Gauge, Histogram

logger = logging.getLogger(__name__)

# Process-level metrics
_API_START_TS = _time.time()
_API_PROCESS = _psutil.Process()


def _PROCESS_START_TIME_MONO() -> float:
    """Seconds since API process started. Used by /health uptime field."""
    return _time.time() - _API_START_TS


# HTTP request metrics (populated by middleware)
http_requests_total = Counter(
    "http_requests_total",
    "Total HTTP requests handled, partitioned by method, route template, and status code.",
    ["method", "path", "status"],
)
http_request_duration_seconds = Histogram(
    "http_request_duration_seconds",
    "HTTP request latency in seconds.",
    ["method", "path"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0),
)

# Dependency reachability — written by the background probe loop, read by /health/ready and /metrics.
_dep_up: dict[str, int] = {"livekit": 0, "supabase": 0}
_dep_probe_latency_seconds: dict[str, float] = {"livekit": 0.0, "supabase": 0.0}
_dep_last_error: dict[str, str] = {"livekit": "", "supabase": ""}
_dep_last_checked_monotonic: dict[str, float] = {"livekit": 0.0, "supabase": 0.0}

# Prometheus Gauges that mirror the in-memory state above. Updated by the
# probe loop after each check. These are the values /metrics emits.
dep_up = Gauge(
    "dep_up",
    "1 if the last background probe for this dependency succeeded, 0 otherwise.",
    ["dep"],
)
dep_probe_latency_seconds = Gauge(
    "dep_probe_latency_seconds",
    "Wall-clock seconds the most recent background probe for this dependency took.",
    ["dep"],
)
api_uptime_seconds = Gauge(
    "api_uptime_seconds",
    "Seconds since the API process started.",
)
api_process_cpu_percent = Gauge(
    "api_process_cpu_percent",
    "Process CPU usage percent (psutil).",
)
api_process_memory_rss_bytes = Gauge(
    "api_process_memory_rss_bytes",
    "Process resident set size in bytes.",
)
api_process_memory_vms_bytes = Gauge(
    "api_process_memory_vms_bytes",
    "Process virtual memory size in bytes.",
)
api_process_open_fds = Gauge(
    "api_process_open_fds",
    "Open file descriptors held by the API process.",
)
api_process_threads = Gauge(
    "api_process_threads",
    "OS threads in the API process.",
)


def _refresh_process_gauges() -> None:
    """Called by the probe loop every 15s. Cheap (sub-ms) but not free,
    so we don't run it on the request path."""
    try:
        api_uptime_seconds.set(_PROCESS_START_TIME_MONO())
        api_process_cpu_percent.set(_API_PROCESS.cpu_percent(interval=None))
        mem = _API_PROCESS.memory_info()
        api_process_memory_rss_bytes.set(mem.rss)
        api_process_memory_vms_bytes.set(mem.vms)
        try:
            api_process_open_fds.set(_API_PROCESS.num_fds())
        except (AttributeError, _psutil.AccessDenied):
            # num_fds() is Unix-only.
            pass
        api_process_threads.set(_API_PROCESS.num_threads())
        for name, val in _dep_up.items():
            dep_up.labels(dep=name).set(val)
        for name, val in _dep_probe_latency_seconds.items():
            dep_probe_latency_seconds.labels(dep=name).set(val)
    except Exception as e:
        logger.debug(f"[readiness] refresh_process_gauges: {e}")


def _readiness_cache_snapshot() -> dict[str, dict]:
    """Snapshot of the last probe result for each dep. Safe to call from
    request handlers — no I/O happens here, all data is in-memory from the
    background probe loop."""
    now = _time.monotonic()
    out: dict[str, dict] = {}
    for name in ("livekit", "supabase"):
        age = now - _dep_last_checked_monotonic[name] if _dep_last_checked_monotonic[name] else None
        out[name] = {
            "status": "up" if _dep_up[name] else "down",
            "last_check_age_s": round(age, 2) if age is not None else None,
            "probe_latency_ms": round(_dep_probe_latency_seconds[name] * 1000, 2),
            "last_error": _dep_last_error[name] or None,
        }
    return out


async def _reconcile_stuck_sessions() -> int:
    """
    Close sessions that are still open (ended_at IS NULL) but whose call_queue
    row is already completed/no_answer/failed. This handles edge cases where
    the agent process was killed before _save_session_to_db could run.

    Returns the number of sessions closed.
    """
    try:
        db = get_supabase()
        # Find sessions stuck > 10 minutes with a completed queue row
        result = db.rpc("reconcile_stuck_sessions", {}).execute()
        count = result.data if isinstance(result.data, int) else 0
        if count:
            logger.info(f"[reconcile] Closed {count} stuck session(s)")
        return count
    except Exception as e:
        logger.warning(f"[reconcile] Error: {e}")
        return 0


async def _reconcile_loop() -> None:
    """Background loop: reconcile stuck sessions every 5 minutes."""
    await asyncio.sleep(30)  # wait for API to fully start
    while True:
        await _reconcile_stuck_sessions()
        await asyncio.sleep(300)  # 5 minutes


# ── S5 — Dependency probes ──────────────────────────────────────────────────
# Probes run every 15s in the background so /health/ready stays sub-100ms
# even with slow/flaky deps. Each probe: measure latency, update cache,
# catch and log all exceptions (probes must never crash the loop).

async def _probe_supabase() -> None:
    import httpx
    url = os.getenv("SUPABASE_URL", "").rstrip("/")
    if not url:
        _dep_up["supabase"] = 0
        _dep_last_error["supabase"] = "SUPABASE_URL not set"
        return
    start = _time.monotonic()
    try:
        # /auth/v1/health returns 200 OR 401 depending on whether anon key is
        # sent. Either response means "server reachable" — we only fail on
        # connection-level errors (DNS, timeout, refused). raise_for_status()
        # would 401 us into a false-negative.
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(f"{url}/auth/v1/health")
        _dep_up["supabase"] = 1
        _dep_last_error["supabase"] = f"http {r.status_code}"
    except httpx.RequestError as e:
        # Network-level failure: DNS, TCP refused, TLS, timeout. Server is down.
        _dep_up["supabase"] = 0
        _dep_last_error["supabase"] = f"{type(e).__name__}: {e}"
    except Exception as e:
        _dep_up["supabase"] = 0
        _dep_last_error["supabase"] = f"{type(e).__name__}: {e}"
    finally:
        _dep_probe_latency_seconds["supabase"] = _time.monotonic() - start
        _dep_last_checked_monotonic["supabase"] = _time.monotonic()


async def _probe_livekit() -> None:
    import httpx
    lk_url = os.getenv("LIVEKIT_URL", "ws://livekit:7880").replace("ws://", "http://").replace("wss://", "https://").rstrip("/")
    start = _time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(f"{lk_url}/")
            # LiveKit returns 200 with version info on the root. We accept
            # any HTTP response as proof of reachability (the SIP port and
            # admin API might return non-200 from this client in some configs).
            _dep_up["livekit"] = 1
            _dep_last_error["livekit"] = f"http {r.status_code}"
    except httpx.RequestError as e:
        _dep_up["livekit"] = 0
        _dep_last_error["livekit"] = f"{type(e).__name__}: {e}"
    except Exception as e:
        _dep_up["livekit"] = 0
        _dep_last_error["livekit"] = f"{type(e).__name__}: {e}"
    finally:
        _dep_probe_latency_seconds["livekit"] = _time.monotonic() - start
        _dep_last_checked_monotonic["livekit"] = _time.monotonic()


async def _readiness_probe_loop() -> None:
    """Probe Supabase + LiveKit every 15s. First probe runs after a 5s warmup
    so we don't slow down startup. Failures are logged at WARNING, never raised.

    Honors DISABLE_READINESS_PROBES=1 to short-circuit (used by tests so they
    can deterministically seed the dep cache without a real network probe
    racing them)."""
    if os.getenv("DISABLE_READINESS_PROBES") == "1":
        return
    await asyncio.sleep(5)
    while True:
        try:
            await _probe_supabase()
        except Exception as e:
            logger.warning(f"[readiness] supabase probe crashed: {e}")
        try:
            await _probe_livekit()
        except Exception as e:
            logger.warning(f"[readiness] livekit probe crashed: {e}")
        _refresh_process_gauges()
        await asyncio.sleep(15)


def _get_twilio_accounts() -> list[tuple[str, str]]:
    """
    Return list of (account_sid, auth_token) pairs for all configured Twilio accounts.
    Panama (_PA) account is tried first since it handles the active outbound trunk.
    """
    accounts = []
    for suffix in ("_PA", ""):
        sid = os.getenv(f"TWILIO_ACCOUNT_SID{suffix}", "")
        token = os.getenv(f"TWILIO_AUTH_TOKEN{suffix}", "")
        if sid and token:
            accounts.append((sid, token))
    return accounts


async def _fetch_recording_url_from_twilio(call_sid: str) -> str | None:
    """Try all Twilio accounts to find the recording URL for a given CallSid."""
    import httpx
    for account_sid, auth_token in _get_twilio_accounts():
        try:
            async with httpx.AsyncClient(auth=(account_sid, auth_token), timeout=10) as hclient:
                resp = await hclient.get(
                    f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}/Recordings.json"
                    f"?CallSid={call_sid}"
                )
                recs = resp.json().get("recordings", [])
                if recs:
                    return (
                        f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}"
                        f"/Recordings/{recs[0]['sid']}.mp3"
                    )
        except Exception as e:
            logger.warning(f"[twilio] Error fetching recording for {call_sid} / account {account_sid[:8]}: {e}")
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Phase 3.5 — Phone number provisioning (import Twilio numbers → LiveKit)
# ─────────────────────────────────────────────────────────────────────────────
# Lets the dashboard import numbers the admin already bought in Twilio and
# provision them end-to-end:
#   Twilio IncomingPhoneNumber → Twilio Elastic SIP Trunk (shared, idempotent)
#                             → LiveKit SipInboundTrunk
#                             → LiveKit SipDispatchRule with metadata.agent_id
#
# Helpers below are split into Twilio-side (account resolution, trunk ensure,
# number attach) and LiveKit-side (inbound trunk + dispatch rule create/update/
# release). Endpoints further down call these in order, with rollback if any
# step fails mid-flow.

TWILIO_PROVIDER_TO_SUFFIX = {
    "twilio_us": "",
    "twilio_pa": "_PA",
}
TWILIO_PROVIDER_LABEL = {
    "twilio_us": "US",
    "twilio_pa": "Panama",
}
# FriendlyName prefix used for the shared Twilio Elastic SIP Trunk that routes
# inbound Twilio calls to our LiveKit SIP server. Matches trunks created by
# scripts/setup_panama_sip.py ("LiveKit Panama") as well as future imports.
TWILIO_SHARED_TRUNK_NAME_PREFIX = "LiveKit"
# LiveKit SIP server hostname/IP — must be reachable from Twilio's network.
# Override via env if you move to a different LiveKit deployment.
LIVEKIT_SIP_HOSTNAME = os.getenv("LIVEKIT_SIP_HOSTNAME", "44.247.225.191")
# Twilio egress IP ranges — the inbound trunk only accepts SIP from these.
# Source: https://www.twilio.com/docs/voice/sip/connecting-to-twilio
TWILIO_EGRESS_IP_RANGES = [
    "54.172.60.0/30",
    "54.172.60.192/30",
    "54.244.51.0/30",
]


def _twilio_account_for(provider: str) -> tuple[str, str, str]:
    """Map a `provider` slug ('twilio_us' | 'twilio_pa') to (account_sid,
    auth_token, friendly_label). Raises 503 if the matching env vars are
    missing."""
    suffix = TWILIO_PROVIDER_TO_SUFFIX.get(provider)
    if suffix is None:
        raise HTTPException(status_code=400, detail=f"Unknown provider: {provider}")
    sid = os.getenv(f"TWILIO_ACCOUNT_SID{suffix}", "")
    token = os.getenv(f"TWILIO_AUTH_TOKEN{suffix}", "")
    if not sid or not token:
        raise HTTPException(
            status_code=503,
            detail=(
                f"Twilio {provider} not configured "
                f"(TWILIO_ACCOUNT_SID{suffix} / TWILIO_AUTH_TOKEN{suffix} missing)"
            ),
        )
    return sid, token, TWILIO_PROVIDER_LABEL.get(provider, provider)


async def _twilio_request(
    method: str,
    path: str,
    *,
    provider: str,
    params: list[tuple[str, str]] | None = None,
    form_body: dict | None = None,
) -> dict | list:
    """Generic Twilio REST helper. Uses the api.twilio.com domain; pass the
    full path starting with `/2010-04-01/...` (or `/Trunks/...` for the
    trunking subdomain — use `_twilio_trunking_request` for that)."""
    import httpx

    account_sid, auth_token, _ = _twilio_account_for(provider)
    url = f"https://api.twilio.com{path}"
    headers: dict[str, str] = {}
    body: dict | None = None
    if form_body is not None:
        body = form_body
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    try:
        async with httpx.AsyncClient(auth=(account_sid, auth_token), timeout=15) as hclient:
            resp = await hclient.request(method, url, params=params, data=body, headers=headers)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Twilio request failed: {e}")
    if resp.status_code >= 400:
        raise HTTPException(
            status_code=resp.status_code,
            detail=f"Twilio {method} {path} → {resp.status_code}: {resp.text[:300]}",
        )
    return resp.json() if resp.content else {}


async def _twilio_trunking_request(
    method: str,
    path: str,
    *,
    provider: str,
    form_body: dict | None = None,
) -> dict | list:
    """Twilio trunking API (trunking.twilio.com/v1/...) — separate subdomain
    from the standard `api.twilio.com` REST API."""
    import httpx

    account_sid, auth_token, _ = _twilio_account_for(provider)
    url = f"https://trunking.twilio.com/v1{path}"
    headers: dict[str, str] = {}
    body: bytes | None = None
    if form_body is not None:
        body = urllib.parse.urlencode(form_body).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    try:
        async with httpx.AsyncClient(auth=(account_sid, auth_token), timeout=15) as hclient:
            resp = await hclient.request(method, url, data=body, headers=headers)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Twilio trunking request failed: {e}")
    if resp.status_code >= 400:
        raise HTTPException(
            status_code=resp.status_code,
            detail=f"Twilio trunking {method} {path} → {resp.status_code}: {resp.text[:300]}",
        )
    return resp.json() if resp.content else {}


async def _list_owned_twilio_numbers(provider: str) -> list[dict]:
    """Fetch all phone numbers the Twilio account owns (paginated), plus
    their capabilities. Used by the dashboard's 'Importar desde Twilio' modal."""
    account_sid, _, _ = _twilio_account_for(provider)
    all_numbers: list[dict] = []
    page_size = 100
    page = 0
    while True:
        params = [("PageSize", str(page_size)), ("Page", str(page))]
        try:
            data = await _twilio_request(
                "GET",
                f"/2010-04-01/Accounts/{account_sid}/IncomingPhoneNumbers.json",
                provider=provider,
                params=params,
            )
        except HTTPException as e:
            if e.status_code == 404 and page > 0:
                break
            raise
        numbers = data.get("incoming_phone_numbers", []) if isinstance(data, dict) else []
        if not numbers:
            break
        all_numbers.extend(numbers)
        if len(numbers) < page_size:
            break
        page += 1
    return all_numbers


async def _find_shared_twilio_trunk(provider: str) -> str | None:
    """Look for an existing Twilio Elastic SIP Trunk whose FriendlyName starts
    with the shared prefix (e.g. 'LiveKit Panama'). Returns its SID or None."""
    try:
        data = await _twilio_trunking_request("GET", "/Trunks", provider=provider)
    except HTTPException:
        return None
    trunks = data.get("trunks", []) if isinstance(data, dict) else []
    for trunk in trunks:
        name = trunk.get("friendly_name", "") or ""
        if name.startswith(TWILIO_SHARED_TRUNK_NAME_PREFIX):
            return trunk.get("sid")
    return None


async def _create_shared_twilio_trunk(provider: str) -> str:
    """Create a new Twilio Elastic SIP Trunk with origination → LiveKit SIP
    server. Returns the new trunk SID."""
    _, _, label = _twilio_account_for(provider)
    friendly_name = f"LiveKit Shared ({label})"
    trunk = await _twilio_trunking_request(
        "POST",
        "/Trunks",
        provider=provider,
        form_body={"FriendlyName": friendly_name},
    )
    if not isinstance(trunk, dict) or "sid" not in trunk:
        raise HTTPException(status_code=502, detail=f"Twilio trunk create returned unexpected payload: {trunk}")
    trunk_sid = trunk["sid"]

    # Add origination URI → LiveKit SIP (Twilio delivers inbound calls here)
    await _twilio_trunking_request(
        "POST",
        f"/Trunks/{trunk_sid}/OriginationUrls",
        provider=provider,
        form_body={
            "SipUrl": f"sip:{LIVEKIT_SIP_HOSTNAME}",
            "FriendlyName": "LiveKit SIP",
            "Weight": 1,
            "Priority": 1,
            "Enabled": "true",
        },
    )
    logger.info(f"[phone-import] Created Twilio Elastic Trunk {trunk_sid} for {provider}")
    return trunk_sid


async def _ensure_twilio_elastic_trunk(provider: str) -> str:
    """Find or create the shared Twilio Elastic SIP Trunk. Returns the SID."""
    existing = await _find_shared_twilio_trunk(provider)
    if existing:
        return existing
    return await _create_shared_twilio_trunk(provider)


async def _is_number_attached_to_trunk(provider: str, phone_sid: str, trunk_sid: str) -> bool:
    """Check if a Twilio IncomingPhoneNumber is already associated with a trunk.
    Used to make number attach idempotent."""
    try:
        data = await _twilio_trunking_request(
            "GET",
            f"/Trunks/{trunk_sid}/PhoneNumbers",
            provider=provider,
        )
    except HTTPException as e:
        if e.status_code == 404:
            return False
        raise
    phone_numbers = data.get("phone_numbers", []) if isinstance(data, dict) else []
    for entry in phone_numbers:
        if entry.get("sid") == phone_sid:
            return True
    return False


async def _attach_twilio_number_to_trunk(provider: str, phone_sid: str, trunk_sid: str) -> bool:
    """Associate a Twilio IncomingPhoneNumber with an Elastic SIP Trunk.
    Returns True if newly attached, False if already attached (idempotent)."""
    if await _is_number_attached_to_trunk(provider, phone_sid, trunk_sid):
        return False
    await _twilio_trunking_request(
        "POST",
        f"/Trunks/{trunk_sid}/PhoneNumbers",
        provider=provider,
        form_body={"PhoneNumberSid": phone_sid},
    )
    return True


async def _lookup_twilio_phone_by_number(provider: str, e164: str) -> dict | None:
    """Find a Twilio IncomingPhoneNumber by its E.164 string. Returns the raw
    record or None if not found in this account."""
    import urllib.parse as _urlparse
    account_sid, _, _ = _twilio_account_for(provider)
    data = await _twilio_request(
        "GET",
        f"/2010-04-01/Accounts/{account_sid}/IncomingPhoneNumbers.json",
        provider=provider,
        params=[("PhoneNumber", _urlparse.quote(e164, safe=""))],
    )
    numbers = data.get("incoming_phone_numbers", []) if isinstance(data, dict) else []
    return numbers[0] if numbers else None


def _livekit_api():
    """Construct a fresh LiveKitAPI client. Callers must `await lkapi.aclose()`."""
    from livekit import api as lk_api
    return lk_api.LiveKitAPI(
        url=os.getenv("LIVEKIT_URL", "ws://localhost:7880"),
        api_key=LIVEKIT_API_KEY,
        api_secret=LIVEKIT_API_SECRET,
    )


async def _create_livekit_inbound_trunk(e164: str, label: str) -> str:
    """Create a LiveKit SipInboundTrunk bound to a single E.164 number.
    Returns the new sip_trunk_id."""
    from livekit import api as lk_api

    lkapi = _livekit_api()
    try:
        inbound_resp = await lkapi.sip.create_sip_inbound_trunk(
            lk_api.CreateSIPInboundTrunkRequest(
                trunk=lk_api.SIPInboundTrunkInfo(
                    name=label,
                    numbers=[e164],
                    allowed_addresses=TWILIO_EGRESS_IP_RANGES,
                )
            )
        )
        return inbound_resp.sip_trunk_id
    finally:
        await lkapi.aclose()


async def _create_livekit_dispatch_rule(
    inbound_trunk_id: str,
    e164: str,
    agent_id: str | None,
    label: str,
) -> str:
    """Create a LiveKit SipDispatchRule that routes inbound calls on
    `inbound_trunk_id` to the `voice-agent` worker, passing `agent_id` in
    the room metadata so the worker loads that agent's config."""
    from livekit import api as lk_api

    lkapi = _livekit_api()
    try:
        metadata_str = json.dumps({"agent_id": agent_id}) if agent_id else None
        rule_resp = await lkapi.sip.create_sip_dispatch_rule(
            lk_api.CreateSIPDispatchRuleRequest(
                rule=lk_api.SIPDispatchRule(
                    dispatch_rule_individual=lk_api.SIPDispatchRuleIndividual(
                        room_prefix="call-",
                    ),
                ),
                trunk_ids=[inbound_trunk_id],
                inbound_numbers=[e164],
                room_config=lk_api.RoomConfiguration(
                    agents=[lk_api.RoomAgentDispatch(
                        agent_name="voice-agent",
                        metadata=metadata_str,
                    )]
                ),
                name=f"Dispatch {label}",
            )
        )
        return rule_resp.sip_dispatch_rule_id
    finally:
        await lkapi.aclose()


async def _create_livekit_inbound_and_dispatch(
    e164: str,
    agent_id: str | None,
    label: str,
) -> tuple[str, str]:
    """Create a LiveKit inbound trunk + matching dispatch rule for a single
    number. Returns (inbound_trunk_id, dispatch_rule_id). On dispatch rule
    failure, the inbound trunk is rolled back so we don't leave orphans."""
    inbound_id = await _create_livekit_inbound_trunk(e164, label)
    try:
        dispatch_id = await _create_livekit_dispatch_rule(inbound_id, e164, agent_id, label)
        return inbound_id, dispatch_id
    except Exception:
        # Roll back the inbound trunk — we can't leave it without a rule
        try:
            from livekit import api as lk_api
            lkapi = _livekit_api()
            try:
                await lkapi.sip.delete_sip_trunk(
                    lk_api.DeleteSIPTrunkRequest(sip_trunk_id=inbound_id)
                )
            finally:
                await lkapi.aclose()
        except Exception as cleanup_err:
            logger.warning(f"[phone-import] Failed to roll back inbound trunk {inbound_id}: {cleanup_err}")
        raise


async def _update_livekit_dispatch_agent(
    dispatch_rule_id: str,
    agent_id: str | None,
    label: str | None = None,
) -> None:
    """Live-update a dispatch rule's metadata (carries agent_id) and name."""
    from livekit import api as lk_api

    lkapi = _livekit_api()
    try:
        update_kwargs: dict = {"metadata": json.dumps({"agent_id": agent_id}) if agent_id else None}
        if label is not None:
            update_kwargs["name"] = label
        await lkapi.sip.update_dispatch_rule_fields(dispatch_rule_id, **update_kwargs)
    finally:
        await lkapi.aclose()


async def _release_livekit_number(dispatch_rule_id: str | None, inbound_trunk_id: str | None) -> dict:
    """Delete the LiveKit dispatch rule and inbound trunk for a number.
    Both deletes are best-effort — failures are logged but not raised, so
    the DB cleanup can still proceed. Returns {'dispatch': bool, 'inbound': bool}."""
    from livekit import api as lk_api

    released = {"dispatch": False, "inbound": False}
    lkapi = _livekit_api()
    try:
        if dispatch_rule_id:
            try:
                await lkapi.sip.delete_sip_dispatch_rule(
                    lk_api.DeleteSIPDispatchRuleRequest(sip_dispatch_rule_id=dispatch_rule_id)
                )
                released["dispatch"] = True
            except Exception as e:
                logger.warning(f"[phone-import] Could not delete dispatch rule {dispatch_rule_id}: {e}")
        if inbound_trunk_id:
            try:
                await lkapi.sip.delete_sip_trunk(
                    lk_api.DeleteSIPTrunkRequest(sip_trunk_id=inbound_trunk_id)
                )
                released["inbound"] = True
            except Exception as e:
                logger.warning(f"[phone-import] Could not delete inbound trunk {inbound_trunk_id}: {e}")
    finally:
        await lkapi.aclose()
    return released


async def _backfill_recordings() -> int:
    """
    Fetch and store Twilio recording URLs for sessions that have a twilio_call_sid
    but no recording_url. The agent process is killed (15s drain) before the Twilio
    poll finishes, so this background job picks up the slack.

    Tries all configured Twilio accounts (PA first) so Panama calls are found.
    Processes up to 10 sessions per run to avoid hammering the Twilio API.
    Returns the number of sessions updated.
    """
    try:
        if not _get_twilio_accounts():
            return 0

        db = get_supabase()
        result = db.table("sessions") \
            .select("id,twilio_call_sid") \
            .is_("recording_url", "null") \
            .not_.is_("twilio_call_sid", "null") \
            .not_.is_("ended_at", "null") \
            .limit(10) \
            .execute()

        rows = result.data or []
        if not rows:
            return 0

        updated = 0
        for row in rows:
            session_id = row["id"]
            call_sid = row["twilio_call_sid"]
            recording_url = await _fetch_recording_url_from_twilio(call_sid)
            if recording_url:
                db.table("sessions").update({"recording_url": recording_url}).eq("id", session_id).execute()
                updated += 1

        if updated:
            logger.info(f"[backfill_recordings] Updated {updated} recording URL(s)")
        return updated
    except Exception as e:
        logger.warning(f"[backfill_recordings] Error: {e}")
        return 0


async def _backfill_sid_by_phone() -> int:
    """
    For outbound sessions that ended but have no twilio_call_sid, look up the
    Twilio call by phone number + time window (±2 min of session start).

    This handles the case where the SIP participant's attributes never arrived
    with the CA-prefixed CallSid before the agent was torn down — e.g. when the
    callee hung up within ~10 s before Twilio had a chance to attach the SIP
    header. Without this, those sessions are permanently orphaned with no
    recording or SID.

    Only processes sessions from the last 24 hours to avoid hammering the API.
    """
    try:
        accounts = _get_twilio_accounts()
        if not accounts:
            return 0

        import httpx
        from datetime import datetime, timezone, timedelta

        db = get_supabase()

        # Sessions ended in last 24h, no SID, room_name is an outbound room
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        rows = (
            db.table("sessions")
            .select("id,room_name,started_at")
            .is_("twilio_call_sid", "null")
            .not_.is_("ended_at", "null")
            .like("room_name", "call-out-%")
            .gte("started_at", cutoff)
            .limit(10)
            .execute()
            .data or []
        )
        if not rows:
            return 0

        # Join with call_queue to get phone numbers
        room_names = [r["room_name"] for r in rows]
        queue_rows = (
            db.table("call_queue")
            .select("room_name,phone_number")
            .in_("room_name", room_names)
            .execute()
            .data or []
        )
        phone_by_room = {q["room_name"]: q["phone_number"] for q in queue_rows}

        updated = 0
        for row in rows:
            room = row["room_name"]
            phone = phone_by_room.get(room)
            if not phone:
                continue

            started_at = row["started_at"]  # ISO string
            # Parse into datetime for window calculation
            try:
                dt = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
            except Exception:
                continue

            # Search Twilio for a trunking-terminating call to this number
            # within a ±2 min window around session start
            window_start = (dt - timedelta(minutes=2)).strftime("%Y-%m-%d %H:%M:%S")
            window_end = (dt + timedelta(minutes=2)).strftime("%Y-%m-%d %H:%M:%S")

            found_sid: str | None = None
            found_recording: str | None = None

            for account_sid, auth_token in accounts:
                try:
                    async with httpx.AsyncClient(auth=(account_sid, auth_token), timeout=10) as hc:
                        resp = await hc.get(
                            f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}/Calls.json",
                            params={
                                "To": phone,
                                "StartTime>": window_start,
                                "StartTime<": window_end,
                                "PageSize": "5",
                            },
                        )
                        calls = resp.json().get("calls", [])
                        if not calls:
                            continue
                        # Pick the trunking call (outbound from our SIP trunk)
                        for c in calls:
                            if c.get("direction") in ("trunking-terminating", "outbound-api", "outbound-dial"):
                                found_sid = c["sid"]
                                break
                        if found_sid:
                            # Now fetch its recording
                            rec_resp = await hc.get(
                                f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}/Recordings.json",
                                params={"CallSid": found_sid},
                            )
                            recs = rec_resp.json().get("recordings", [])
                            if recs:
                                found_recording = (
                                    f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}"
                                    f"/Recordings/{recs[0]['sid']}.mp3"
                                )
                            break  # found in this account
                except Exception as e:
                    logger.warning(f"[backfill_sid] Error searching Twilio for {phone}: {e}")

            if found_sid:
                update_payload: dict = {"twilio_call_sid": found_sid}
                if found_recording:
                    update_payload["recording_url"] = found_recording
                db.table("sessions").update(update_payload).eq("id", row["id"]).execute()
                logger.info(
                    f"[backfill_sid] Recovered SID {found_sid} "
                    f"{'+ recording' if found_recording else '(no recording)'} "
                    f"for room {room} ({phone})"
                )
                updated += 1

        if updated:
            logger.info(f"[backfill_sid] Recovered {updated} orphaned session(s)")
        return updated
    except Exception as e:
        logger.warning(f"[backfill_sid] Error: {e}")
        return 0


async def _backfill_recordings_loop() -> None:
    """Background loop: backfill missing Twilio recording URLs every 3 minutes."""
    await asyncio.sleep(60)  # wait for API to fully start
    while True:
        await _backfill_recordings()
        await _backfill_sid_by_phone()  # recover sessions with no CallSid at all
        await asyncio.sleep(180)  # 3 minutes


from contextlib import asynccontextmanager


@asynccontextmanager
async def lifespan(app_instance: FastAPI):
    task1 = asyncio.create_task(_reconcile_loop())
    task2 = asyncio.create_task(_backfill_recordings_loop())
    task3 = asyncio.create_task(_readiness_probe_loop())
    yield
    task1.cancel()
    task2.cancel()
    task3.cancel()
    for task in (task1, task2, task3):
        try:
            await task
        except asyncio.CancelledError:
            pass


# S3 — App must be declared BEFORE the @app.middleware decorators below.
app = FastAPI(title="LiveKit Cost API", lifespan=lifespan)


# ── S3 — Rate limiting + body-size middleware (no external deps) ──────────────
#
# Lightweight in-memory rate limiter. Per-route limits, IP-keyed. Good enough
# for a single-instance deployment; for HA we'd back this with Redis, but
# our bottleneck is "stop credential stuffing / Twilio billing explosion",
# not absolute precision. Concurrent-instance deployments should sync via a
# shared store (out of scope for this iteration).
#
# Limits are configurable per route via the `RateLimiter.limit(path, …)`
# helper below.

import time as _time
from collections import deque as _deque


class _SlidingWindowLimiter:
    """Sliding-window counter keyed by (route, identifier). Thread-safe via
    a single asyncio lock; the actual store is a deque of timestamps."""

    def __init__(self) -> None:
        self._buckets: dict[str, _deque[float]] = {}
        self._lock = asyncio.Lock()

    async def hit(self, key: str, max_hits: int, window_seconds: float) -> tuple[bool, float]:
        """Returns (allowed, retry_after_seconds). If allowed=True, the hit
        is recorded. If allowed=False, retry_after_seconds tells the caller
        how long until the oldest hit in the current window expires."""
        now = _time.monotonic()
        async with self._lock:
            bucket = self._buckets.setdefault(key, _deque())
            cutoff = now - window_seconds
            # Drop expired timestamps from the left
            while bucket and bucket[0] <= cutoff:
                bucket.popleft()
            if len(bucket) >= max_hits:
                retry = max(0.0, bucket[0] + window_seconds - now)
                return False, retry
            bucket.append(now)
            return True, 0.0


_rate_limiter = _SlidingWindowLimiter()


def _client_ip(request: Request) -> str:
    """Best-effort client IP. Trusts the first X-Forwarded-For hop if the
    request came through Caddy; otherwise uses the direct peer. We don't
    validate that XFF is set by a trusted proxy here (Caddy always sets it
    for our deployment), so for true multi-hop setups you'd want to
    pin trusted proxies."""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


@app.middleware("http")
async def _rate_limit_middleware(request: Request, call_next):
    """Per-route rate limits. Define a tuple (max_hits, window_seconds) per
    path prefix; paths not listed here are unlimited.

    Failed auth attempts are the highest-value target — credential stuffing
    is the easiest way to break in once JWTs are stored in cookies. We rate-
    limit by IP for login endpoints."""
    path = request.url.path
    method = request.method.upper()
    ip = _client_ip(request)

    # Apply limits to mutating endpoints + login.
    limits: list[tuple[str, int, float]] = [
        # path prefix, max hits, window seconds
        ("/auth/login",        10, 60.0),    # 10/min/IP
        ("/admin/login",       10, 60.0),
        ("/portal/login",      10, 60.0),
        ("/calls/outbound",    30, 60.0),    # 30/min/IP (anti billing-DOS)
        ("/admin/phone-numbers/search", 60, 60.0),
        ("/admin/clients",     30, 60.0),    # 30/min for create+invite
        ("/admin/agents",      60, 60.0),    # 60/min for any agent mutating
    ]
    for prefix, max_hits, window in limits:
        if path == prefix or path.startswith(prefix + "/") or path.startswith(prefix + "?"):
            key = f"{method}:{prefix}:{ip}"
            allowed, retry = await _rate_limiter.hit(key, max_hits, window)
            if not allowed:
                # S4.7 — security event log. These are the events an
                # operator should monitor for credential stuffing / abuse.
                logger.warning(
                    "[security] rate-limit hit: ip=%s method=%s path=%s limit=%d/%ds retry_after=%.1fs",
                    ip, method, path, max_hits, window, retry,
                )
                from starlette.responses import JSONResponse
                return JSONResponse(
                    {"detail": "Rate limit exceeded", "retry_after": round(retry, 1)},
                    status_code=429,
                    headers={"Retry-After": str(int(retry) + 1)},
                )
            break

    return await call_next(request)


@app.middleware("http")
async def _body_size_limit_middleware(request: Request, call_next):
    """S3.2 — Reject requests larger than 25 MB before they're fully read.

    Without this, a malicious admin could POST a 10 GB file to /campaigns/
    upload and exhaust API memory (the upload endpoint reads the whole file
    in one go). The size is enforced from Content-Length when present, and
    as a defense in depth we install a max body size stream guard.
    """
    MAX_BODY_BYTES = 25 * 1024 * 1024  # 25 MB

    cl = request.headers.get("content-length")
    if cl and cl.isdigit() and int(cl) > MAX_BODY_BYTES:
        from starlette.responses import JSONResponse
        return JSONResponse(
            {"detail": f"Request body too large (max {MAX_BODY_BYTES // (1024*1024)} MB)"},
            status_code=413,
        )

    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://dashboard.voicemedia.ai",
        "http://44.247.225.191:3000",  # direct-IP access (fallback / debugging)
        "http://localhost:3000",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
    # S2.4 follow-up — must be True so the browser stores the Set-Cookie
    # response headers from /admin/login, /portal/login, /auth/login and
    # sends them back on subsequent cross-origin requests. Without this
    # the cookie-based auth flow silently breaks (browser drops the
    # cookies on the floor).
    allow_credentials=True,
)


# ── S5 — HTTP metrics middleware ────────────────────────────────────────────
# Increments http_requests_total and observes http_request_duration_seconds
# for every request. Path label uses the route template (e.g. /sessions/{id})
# not the raw URL — otherwise every UUID would explode the label cardinality.
@app.middleware("http")
async def _metrics_middleware(request: Request, call_next):
    start = _time.perf_counter()
    response = await call_next(request)
    duration = _time.perf_counter() - start
    route = request.scope.get("route")
    path_template = getattr(route, "path", request.url.path) if route else request.url.path
    try:
        http_requests_total.labels(
            method=request.method,
            path=path_template,
            status=str(response.status_code),
        ).inc()
        http_request_duration_seconds.labels(
            method=request.method,
            path=path_template,
        ).observe(duration)
    except Exception:
        # Never let a metrics failure break the request.
        pass
    return response

LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET")
# S1.2 — fail-fast on startup if LiveKit credentials are missing. The previous
# `devkey`/`secret` fallbacks let the service run with publicly-known
# credentials if the env file was missing — anyone hitting port 7880 could
# then mint LiveKit tokens. We now refuse to boot instead.
if not LIVEKIT_API_KEY or not LIVEKIT_API_SECRET:
    raise RuntimeError(
        "LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set in the env. "
        "Refusing to start with default credentials. "
        "Generate new keys in your LiveKit deployment and update .env."
    )


def get_supabase():
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise HTTPException(status_code=503, detail="Supabase not configured")
    from supabase import create_client
    return create_client(url, key)


# ── Auth dependencies (defined early so they can gate routes declared below) ──

_bearer = HTTPBearer(auto_error=False)

SUPABASE_URL_VAR = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON   = os.getenv("SUPABASE_ANON_KEY", "")

# Base URL of the dashboard frontend, used to build redirect links sent in
# Supabase Auth emails (invite, password reset, etc.). The dashboard's
# `/auth/set-password` page reads the access_token from the URL hash and
# lets the user set their password.
FRONTEND_URL = os.getenv("FRONTEND_URL", "https://dashboard.voicemedia.ai")


def _get_client_from_token(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict:
    """Verify Supabase JWT and return the authenticated client row."""
    if not creds:
        raise HTTPException(status_code=401, detail="Missing token")
    try:
        from supabase import create_client
        # Use service role to verify the token and look up the client
        svc = create_client(
            os.getenv("SUPABASE_URL", ""),
            os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""),
        )
        user = svc.auth.get_user(creds.credentials)
        uid = user.user.id
        result = svc.table("clients").select("*").eq("supabase_uid", uid).single().execute()
        if not result.data:
            raise HTTPException(status_code=403, detail="Client not found")
        return result.data
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Invalid token: {e}")


def _get_admin_from_token(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict:
    """Verify Supabase JWT and return the authenticated admin_users row.

    Mirrors _get_client_from_token but checks `admin_users` instead of
    `clients` — admins and clients are distinct identities that never overlap.
    """
    if not creds:
        raise HTTPException(status_code=401, detail="Missing token")
    try:
        from supabase import create_client
        svc = create_client(
            os.getenv("SUPABASE_URL", ""),
            os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""),
        )
        user = svc.auth.get_user(creds.credentials)
        uid = user.user.id
        result = svc.table("admin_users").select("*").eq("supabase_uid", uid).single().execute()
        if not result.data:
            raise HTTPException(status_code=403, detail="Admin not found")
        if not result.data.get("is_active", True):
            raise HTTPException(status_code=403, detail="Admin account disabled")
        return result.data
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Invalid token: {e}")


# ── S2.4 — Cookie-based session + CSRF helpers ───────────────────────────────
#
# Replaces JWT-in-localStorage with HttpOnly cookies + a non-HttpOnly CSRF
# companion cookie. Defense against XSS-driven token theft: the session JWT
# lives in an HttpOnly cookie the browser sends automatically; the JS only
# sees the CSRF token, which is useless alone (an attacker who can XSS can't
# exfiltrate the session, and CSRF tokens require the corresponding cookie to
# be present which browsers gate by SameSite=Strict).
#
# Two parallel namespaces (`admin` / `portal`) so cookies don't collide when
# the same browser logs into both surfaces.
#
# Backward compatibility: callers passing `Authorization: Bearer <jwt>` (curl,
# scripts, the existing dashboard code path) still work via `_extract_token`.
# After the dashboard is updated, deprecate but don't break the header path.

import secrets as _secrets

SESSION_COOKIE_ADMIN  = "admin_session"
SESSION_COOKIE_PORTAL = "portal_session"
CSRF_COOKIE_ADMIN     = "csrf_admin"
CSRF_COOKIE_PORTAL    = "csrf_portal"
SESSION_TTL_SECONDS   = 60 * 60 * 8  # 8 hours — matches Supabase's default

# When True, `Secure` is added to Set-Cookie. Disabled when running locally
# over HTTP (the dashboard dev server isn't HTTPS by default).
_SECURE_COOKIES = os.getenv("COOKIE_SECURE", "true").lower() == "true"


def _session_cookie_attrs() -> dict:
    """Common attributes for the HttpOnly session cookie."""
    return {
        "httponly": True,
        "secure": _SECURE_COOKIES,
        "samesite": "strict",
        "path": "/",
        "max_age": SESSION_TTL_SECONDS,
    }


def _csrf_cookie_attrs() -> dict:
    """Same attributes minus `httponly` so the dashboard's JS can read it."""
    return {
        "httponly": False,
        "secure": _SECURE_COOKIES,
        "samesite": "strict",
        "path": "/",
        "max_age": SESSION_TTL_SECONDS,
    }


def _set_session_cookies(response: Response, role: str, jwt: str) -> str:
    """Set the session + CSRF cookies for the given role. Returns the
    generated CSRF token so the caller can include it in the response body
    (the JS uses it as the X-CSRF-Token header)."""
    csrf = _secrets.token_urlsafe(32)
    session_cookie = SESSION_COOKIE_ADMIN if role == "admin" else SESSION_COOKIE_PORTAL
    csrf_cookie    = CSRF_COOKIE_ADMIN    if role == "admin" else CSRF_COOKIE_PORTAL
    response.set_cookie(session_cookie, jwt, **_session_cookie_attrs())
    response.set_cookie(csrf_cookie, csrf, **_csrf_cookie_attrs())
    return csrf


def _clear_session_cookies(response: Response, role: str) -> None:
    """Clear both cookies for the given role (logout).

    Starlette's Response.delete_cookie() accepts only path/domain/secure/
    httponly/samesite/partitioned — no max-age or expires. To force
    immediate expiry we override the cookie with max_age=0 via set_cookie,
    which emits Set-Cookie with Max-Age=0 (browsers drop it).
    """
    session_cookie = SESSION_COOKIE_ADMIN if role == "admin" else SESSION_COOKIE_PORTAL
    csrf_cookie    = CSRF_COOKIE_ADMIN    if role == "admin" else CSRF_COOKIE_PORTAL
    expire = {"path": "/", "max_age": 0, "expires": 0}
    response.set_cookie(session_cookie, "", **expire)
    response.set_cookie(csrf_cookie, "", **expire)


def _extract_token(
    request: Request,
    creds: HTTPAuthorizationCredentials | None,
    role: str,
) -> str | None:
    """Pull the JWT from either the session cookie (preferred) or the
    Authorization: Bearer header (backward compat). Returns None if absent."""
    cookie_name = SESSION_COOKIE_ADMIN if role == "admin" else SESSION_COOKIE_PORTAL
    cookie_token = request.cookies.get(cookie_name)
    if cookie_token:
        return cookie_token
    if creds and creds.credentials:
        return creds.credentials
    return None


def _check_csrf(request: Request, role: str) -> None:
    """Verify the X-CSRF-Token header matches the CSRF cookie. Only called
    for mutating methods (POST/PUT/PATCH/DELETE). Raises 403 on mismatch.

    The CSRF cookie is SameSite=Strict so browsers never send it on
    cross-origin requests — meaning a malicious site can't trigger a state-
    changing request from the user's browser.
    """
    csrf_cookie_name = CSRF_COOKIE_ADMIN if role == "admin" else CSRF_COOKIE_PORTAL
    expected = request.cookies.get(csrf_cookie_name, "")
    provided = request.headers.get("X-CSRF-Token", "")
    if not expected or not provided or not hmac.compare_digest(expected, provided):
        # S4.7 — security event log. A mismatch here usually means the
        # CSRF cookie expired or a stale tab. Worth flagging because
        # repeated mismatches from the same IP indicate a CSRF probe.
        logger.warning(
            "[security] csrf-mismatch: role=%s path=%s method=%s cookie_present=%s header_present=%s",
            role, request.url.path, request.method, bool(expected), bool(provided),
        )
        raise HTTPException(status_code=403, detail="CSRF token missing or invalid")


def _get_admin_from_cookie_or_bearer(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict:
    """S2.4 — admin auth that accepts session cookie OR Bearer header.

    On mutating methods (POST/PUT/PATCH/DELETE) it ALSO requires a matching
    X-CSRF-Token header. Safe methods (GET/HEAD/OPTIONS) skip the CSRF check.
    """
    token = _extract_token(request, creds, "admin")
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        _check_csrf(request, "admin")
    try:
        from supabase import create_client
        svc = create_client(
            os.getenv("SUPABASE_URL", ""),
            os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""),
        )
        user = svc.auth.get_user(token)
        uid = user.user.id
        result = svc.table("admin_users").select("*").eq("supabase_uid", uid).single().execute()
        if not result.data:
            raise HTTPException(status_code=403, detail="Admin not found")
        if not result.data.get("is_active", True):
            raise HTTPException(status_code=403, detail="Admin account disabled")
        return result.data
    except HTTPException:
        raise
    except Exception:
        # Don't leak underlying exception text — invalid token is invalid token.
        raise HTTPException(status_code=401, detail="Invalid token")


def _get_client_from_cookie_or_bearer(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict:
    """S2.4 — client auth (mirror of admin)."""
    token = _extract_token(request, creds, "client")
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        _check_csrf(request, "client")
    try:
        from supabase import create_client
        svc = create_client(
            os.getenv("SUPABASE_URL", ""),
            os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""),
        )
        user = svc.auth.get_user(token)
        uid = user.user.id
        result = svc.table("clients").select("*").eq("supabase_uid", uid).single().execute()
        if not result.data:
            raise HTTPException(status_code=403, detail="Client not found")
        return result.data
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")


# Backward-compat aliases: the existing routes use these names. After the
# dashboard migration, switch them to the cookie-aware versions.
_get_admin_from_token  = _get_admin_from_cookie_or_bearer
_get_client_from_token = _get_client_from_cookie_or_bearer


# ── Call log helpers ──────────────────────────────────────────────────────────
#
# The legacy `calls` table is only ever inserted into at call-creation time
# (see /calls/outbound and /calls/webhook/inbound below) and is never updated
# with the call's outcome — so `cost_usd`, `duration_seconds`, `ended_at` and
# the final `status` stay null/stale forever. The voice agent writes the real,
# authoritative record (cost, duration, transcript, recording, Twilio SID) to
# `sessions` once the call ends (see agent.py::_save_session_to_db). Both the
# admin call log (`GET /calls`) and the client portal call log
# (`GET /portal/calls`) read from `sessions` via this shared mapper so the two
# views stay consistent and always show real cost/duration data.

# LiveKit's SIP server embeds the caller-ID it receives from the SIP INVITE
# verbatim into room_name (format call-_<caller-id>_<suffix>). That caller-ID
# is attacker-controlled and has been observed containing SQLi probe strings
# (e.g. "'or''='"), so anything parsed out of it must be validated against a
# phone-number shape before being trusted as `from_number`.
_PHONE_LIKE_RE = re.compile(r"^\+?[0-9]{4,15}$")


def _client_agent_ids(db: object, client_id: str) -> list[str]:
    """Return the IDs of all agents owned by the given client.

    Shared by every `/portal/*` endpoint that needs to scope a query to the
    authenticated client's own resources (campaigns, calls, recordings) — see
    `portal_campaigns`, `portal_calls`, `portal_campaign_calls`,
    `portal_recording`. Centralizing this avoids the tenant-scoping filter
    drifting out of sync between endpoints.
    """
    agents = db.table("agents").select("id").eq("client_id", client_id).execute()
    return [a["id"] for a in (agents.data or [])]


def _phone_lookup_for_rooms(db: object, room_names: list[str]) -> dict[str, dict[str, str | None]]:
    """Resolve `to_number`/`from_number` for a batch of `room_name`s.

    `sessions` (the source of the call log — see `_session_to_call_row`) never
    stores the dialed/calling number, so for outbound calls placed via
    `/calls/outbound` (logged to the legacy `calls` table) or via campaigns
    (logged to `call_queue`) we look the number up by `room_name` from those
    tables and merge it in. `calls` wins over `call_queue` when both have a row
    for the same room (it carries both `to_number` and `from_number`).
    """
    rooms = [r for r in room_names if r]
    if not rooms:
        return {}

    lookup: dict[str, dict[str, str | None]] = {}

    try:
        cq = (
            db.table("call_queue")
            .select("room_name,phone_number")
            .in_("room_name", rooms)
            .execute()
        )
        for row in cq.data or []:
            rn = row.get("room_name")
            if rn:
                lookup[rn] = {"to_number": row.get("phone_number"), "from_number": None}
    except Exception:
        pass

    try:
        calls = (
            db.table("calls")
            .select("room_name,to_number,from_number")
            .in_("room_name", rooms)
            .execute()
        )
        for row in calls.data or []:
            rn = row.get("room_name")
            if rn:
                lookup[rn] = {"to_number": row.get("to_number"), "from_number": row.get("from_number")}
    except Exception:
        pass

    return lookup


def _session_to_call_row(s: dict, phone_lookup: dict[str, dict[str, str | None]] | None = None) -> dict:
    """Map a `sessions` row (room_name like 'call-%') to a call-log entry,
    deriving direction/phone number from the room_name convention:
      inbound  → call-_+<phone>_<suffix>
      outbound → call-out-<suffix> or call-<campaignId>-<suffix>

    `sessions` itself doesn't carry the dialed/calling number for outbound or
    campaign calls, so `phone_lookup` (built by `_phone_lookup_for_rooms` from
    `calls`/`call_queue`) fills in `to_number`/`from_number` by `room_name`
    when the room-name convention alone doesn't reveal them.
    """
    from datetime import datetime, timezone

    room: str = s.get("room_name") or ""
    looked_up = (phone_lookup or {}).get(room)

    if room.startswith("call-_"):
        direction = "inbound"
        # room format: call-_+<phone>_<random>
        inner = room[len("call-_"):]          # "+16236320705_si84vUJpZ6kh"
        last_sep = inner.rfind("_")
        phone = inner[:last_sep] if last_sep > 0 else inner
        from_number = phone if _PHONE_LIKE_RE.match(phone) else None
        to_number = None
    else:
        direction = "outbound"
        from_number = None
        to_number = None

    if looked_up:
        to_number = to_number or looked_up.get("to_number")
        from_number = from_number or looked_up.get("from_number")

    duration: int | None = None
    if s.get("started_at") and s.get("ended_at"):
        try:
            def _parse(ts: str):
                return datetime.fromisoformat(ts.replace("Z", "+00:00"))
            secs = int((_parse(s["ended_at"]) - _parse(s["started_at"])).total_seconds())
            duration = max(secs, 0)
        except Exception:
            pass

    end_reason = s.get("end_reason")
    if not s.get("ended_at"):
        status = "in_progress"
    else:
        status = end_reason if end_reason in _END_REASON_LABELS else "completed"

    return {
        "id": s["id"],
        "direction": direction,
        "from_number": from_number,
        "to_number": to_number,
        "status": status,
        "status_label": _END_REASON_LABELS.get(status, "Completada"),
        "duration_seconds": duration,
        "started_at": s.get("started_at"),
        "ended_at": s.get("ended_at"),
        "room_name": room,
        "cost_usd": float(s.get("total_cost_usd") or 0),
        "transcript": s.get("transcript") or None,
        "recording_url": s.get("recording_url") or None,
        "twilio_call_sid": s.get("twilio_call_sid") or None,
    }


# Maps `sessions.end_reason` (set by the agent's `_classify_end_reason`) to the
# label shown in the admin/portal call log. "completed" / "in_progress" aren't
# `end_reason` values but are included so `_session_to_call_row` can look up a
# label for every status it produces through one dict.
_END_REASON_LABELS = {
    "client_hangup": "Colgó el cliente",
    "voicemail": "Buzón de voz",
    "no_answer": "No contestó",
    "completed": "Completada",
    "in_progress": "En curso",
}


_CALL_LOG_SELECT = (
    "id,started_at,ended_at,total_cost_usd,room_name,identity,"
    "transcript,recording_url,twilio_call_sid,agent_id,end_reason"
)


# ── Token generation ─────────────────────────────────────────────────────────

class TokenRequest(BaseModel):
    identity: str | None = None
    room_name: str | None = None


class TokenResponse(BaseModel):
    token: str
    room_name: str
    identity: str
    livekit_url: str


@app.post("/token", response_model=TokenResponse)
async def create_token(req: TokenRequest, _admin: dict = Depends(_get_admin_from_token)):
    """Issue a LiveKit access token for an admin to join a room.

    S1.3 — Previously unauthenticated (any internet caller could mint a token
    for any room_name and listen to customer calls). Now:
      1. Requires a valid admin JWT (admin_users row).
      2. The supplied room_name is validated: must match one of the known
         room patterns (`call-*` for actual calls). The admin can ONLY join
         rooms that the platform itself dispatched — we don't accept arbitrary
         `room-{uuid}` names. This prevents joining other admins' private
         rooms if we ever add private rooms later.
      3. Identity is always bound to the admin's email (we ignore any
         identity the caller sends) so we can audit who joined which room.

    The token still grants `room_join=True` so the admin can publish audio
    and listen. Token TTL defaults to LiveKit's default (10 min); the admin
    can refresh by calling this endpoint again.
    """
    import re

    room_name = (req.room_name or "").strip()
    if not room_name:
        raise HTTPException(status_code=400, detail="room_name is required")

    # Whitelist room-name patterns we actually dispatch.
    #   call-*       → SIP-driven rooms (call-<campaignId>-… or call-_+<phone>_<suffix>)
    #   room-agent   → /agent playground rooms
    # Anything else is rejected.
    if not (room_name.startswith("call-") or room_name.startswith("room-agent")):
        raise HTTPException(
            status_code=400,
            detail="room_name must start with 'call-' or 'room-agent'",
        )
    if not re.match(r"^[A-Za-z0-9_\-+]+$", room_name):
        raise HTTPException(status_code=400, detail="invalid room_name characters")

    # Force identity to the admin's email — never trust caller-supplied identity
    # for audit purposes. If admin has no email (shouldn't happen), use id prefix.
    identity = _admin.get("email") or f"admin-{(_admin.get('id') or '')[:8]}"

    token = (
        AccessToken(api_key=LIVEKIT_API_KEY, api_secret=LIVEKIT_API_SECRET)
        .with_identity(identity)
        .with_name(identity)
        .with_grants(
            VideoGrants(
                room_join=True,
                room=room_name,
            )
        )
        .to_jwt()
    )

    return TokenResponse(
        token=token,
        room_name=room_name,
        identity=identity,
        # Browser clients connect from outside Docker — they need the public URL,
        # not the internal docker-compose service hostname used by server-side calls.
        livekit_url=os.getenv("LIVEKIT_PUBLIC_URL", "ws://44.247.225.191:7880"),
    )


# ── Cost & session endpoints ──────────────────────────────────────────────────

@app.get("/sessions")
async def list_sessions(limit: int = 50):
    db = get_supabase()
    result = db.table("sessions").select("*").order("ended_at", desc=True).limit(limit).execute()
    return result.data


@app.get("/sessions/{session_id}")
async def get_session(session_id: str, _admin: dict = Depends(_get_admin_from_token)):
    db = get_supabase()
    session = db.table("sessions").select("*").eq("id", session_id).single().execute()
    usage = db.table("api_usage").select("*").eq("session_id", session_id).execute()
    return {"session": session.data, "usage": usage.data}


@app.get("/costs/summary")
async def cost_summary():
    db = get_supabase()
    result = db.table("api_usage").select("provider, cost_usd, timestamp").execute()
    records = result.data or []
    by_provider: dict[str, float] = {}
    total = 0.0
    for r in records:
        p = r["provider"]
        c = float(r["cost_usd"])
        by_provider[p] = by_provider.get(p, 0) + c
        total += c
    return {"total_usd": round(total, 6), "by_provider": {k: round(v, 6) for k, v in by_provider.items()}}


@app.get("/admin/agents/{agent_id}/cost-stats", tags=["admin"])
async def agent_cost_stats(agent_id: str, days: int = 30):
    """..."""
    pass


class AddPhoneNumberBody(BaseModel):
    number: str
    name: str | None = None


@app.post("/admin/agents/{agent_id}/phone-numbers", tags=["admin"])
async def add_agent_phone_number(agent_id: str, body: AddPhoneNumberBody):
    """Provision a phone number for an agent in one call.

    Idempotent: re-running with the same number is a no-op (returns the
    existing trunk and rule ids). Powers the "+ Agregar número" button
    in the agent detail page so operators don't have to touch scripts.

    Body:
      - number: E.164 format, e.g. "+16089461249"
      - name:   optional trunk display name (defaults to "{agent_name} - {number}")
    """
    from supabase import create_client
    db = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_SERVICE_ROLE_KEY"))

    # Verify agent exists (fail loud if UUID is wrong — better than silent trunk creation)
    agent = db.table("agents").select("id, name").eq("id", agent_id).single().execute()
    if not agent.data:
        raise HTTPException(status_code=404, detail=f"agent {agent_id} not found")

    number = body.number.strip()
    if not number.startswith("+"):
        raise HTTPException(status_code=400, detail="number must be in E.164 format (e.g. +16089461249)")

    lkapi = LiveKitAPI(
        url=os.getenv("LIVEKIT_URL", "http://localhost:7880"),
        api_key=os.getenv("LIVEKIT_API_KEY"),
        api_secret=os.getenv("LIVEKIT_API_SECRET"),
    )

    # Idempotent trunk creation
    existing = lkapi.sip.list_sip_inbound_trunk(ListSIPInboundTrunkRequest())
    trunk_id = None
    for t in existing.items:
        if number in (t.numbers or []):
            trunk_id = t.sip_trunk_id
            break
    created_trunk = False
    if not trunk_id:
        trunk = await lkapi.sip.create_sip_inbound_trunk(CreateSIPInboundTrunkRequest(
            trunk=SIPInboundTrunkInfo(
                name=body.name or f"Trunk for {agent.data['name']} - {number}",
                numbers=[number],
            ),
        ))
        trunk_id = trunk.sip_trunk_id
        created_trunk = True

    # Idempotent dispatch rule
    rules = lkapi.sip.list_sip_dispatch_rule(ListSIPDispatchRuleRequest())
    for r in rules.items:
        if r.trunk_ids and trunk_id in r.trunk_ids:
            await lkapi.aclose()
            return {
                "agent_id": agent_id,
                "trunk_id": trunk_id,
                "dispatch_rule_id": r.sip_dispatch_rule_id,
                "created_trunk": created_trunk,
                "created_rule": False,
                "number": number,
            }
    rule = await lkapi.sip.create_sip_dispatch_rule(CreateSIPDispatchRuleRequest(
        rule=SIPDispatchRule(
            dispatch_rule_individual=SIPDispatchRuleIndividual(room_prefix="call-"),
            trunk_ids=[trunk_id],
        ),
        room_config=RoomConfiguration(
            agents=[RoomAgentDispatch(
                agent_name="voice-agent",
                metadata=json.dumps({"agent_id": agent_id}),
            )],
        ),
        name=f"Dispatch {agent.data['name']} - {number}",
    ))
    await lkapi.aclose()
    return {
        "agent_id": agent_id,
        "trunk_id": trunk_id,
        "dispatch_rule_id": rule.sip_dispatch_rule_id,
        "created_trunk": created_trunk,
        "created_rule": True,
        "number": number,
    }


@app.get("/admin/agents/{agent_id}/phone-numbers", tags=["admin"])
async def list_agent_phone_numbers(agent_id: str):
    """List inbound trunks (and the dispatch rule attached to each) that route
    calls to this agent. Used by the agent detail page to show which numbers
    are currently wired up.
    """
    lkapi = LiveKitAPI(
        url=os.getenv("LIVEKIT_URL", "http://localhost:7880"),
        api_key=os.getenv("LIVEKIT_API_KEY"),
        api_secret=os.getenv("LIVEKIT_API_SECRET"),
    )
    trunks = lkapi.sip.list_sip_inbound_trunk(ListSIPInboundTrunkRequest())
    rules = lkapi.sip.list_sip_dispatch_rule(ListSIPDispatchRuleRequest())

    # Build trunk_id → rule mapping
    trunk_to_rule: dict[str, str] = {}
    for r in rules.items:
        for tid in (r.trunk_ids or []):
            trunk_to_rule[tid] = r.sip_dispatch_rule_id

    out = []
    for t in trunks.items:
        out.append({
            "trunk_id": t.sip_trunk_id,
            "name": t.name,
            "numbers": list(t.numbers or []),
            "rule_id": trunk_to_rule.get(t.sip_trunk_id),
        })
    await lkapi.aclose()
    return out


@app.get("/admin/agents/{agent_id}/cost-stats", tags=["admin"])
async def agent_cost_stats(agent_id: str, days: int = 30):
    """Per-agent cost aggregation from the `sessions` table.

    Powers the agent detail page's Costos tab in the admin dashboard.
    Returns total spend, session count, provider breakdown, and a daily
    trend so the operator can price agents with a real margin.
    Pass `?days=30` (default) to scope to the last 30 days; set `days=0`
    or omit to get all-time totals.
    """
    from datetime import datetime, timezone, timedelta
    db = get_supabase()
    q = db.table("sessions").select(
        "id, total_cost_usd, cost_by_provider, started_at, ended_at"
    ).eq("agent_id", agent_id)
    if days and days > 0:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        q = q.gte("started_at", cutoff)
    result = q.execute()
    sessions = result.data or []

    total = 0.0
    by_provider: dict[str, float] = {}
    daily: dict[str, float] = {}
    total_minutes = 0.0

    for s in sessions:
        cost = float(s.get("total_cost_usd") or 0)
        total += cost
        cbp = s.get("cost_by_provider") or {}
        for p, c in cbp.items():
            by_provider[p] = by_provider.get(p, 0.0) + float(c or 0)
        if s.get("started_at"):
            day = str(s["started_at"])[:10]
            daily[day] = daily.get(day, 0.0) + cost
        # Sum session duration for avg-cost-per-minute
        if s.get("started_at") and s.get("ended_at"):
            try:
                from datetime import datetime
                start = datetime.fromisoformat(str(s["started_at"]).replace("Z", "+00:00"))
                end = datetime.fromisoformat(str(s["ended_at"]).replace("Z", "+00:00"))
                total_minutes += max(0.0, (end - start).total_seconds() / 60.0)
            except Exception:
                pass

    return {
        "agent_id":           agent_id,
        "total_cost_usd":     round(total, 6),
        "session_count":      len(sessions),
        "avg_cost_per_min":   round(total / total_minutes, 6) if total_minutes > 0 else 0,
        "total_minutes":      round(total_minutes, 2),
        "by_provider":        {k: round(v, 6) for k, v in by_provider.items()},
        "daily":              [{"date": d, "cost_usd": round(c, 6)} for d, c in sorted(daily.items())],
    }


@app.get("/costs/daily")
async def daily_costs():
    db = get_supabase()
    result = db.table("api_usage").select("provider, cost_usd, timestamp").execute()
    records = result.data or []
    by_day: dict[str, float] = {}
    for r in records:
        day = r["timestamp"][:10]
        by_day[day] = by_day.get(day, 0) + float(r["cost_usd"])
    return [{"date": d, "cost_usd": round(c, 6)} for d, c in sorted(by_day.items())]


@app.get("/health")
async def health():
    """Liveness probe — process is up. Does NOT check dependencies.
    Use /health/ready for orchestrator-level readiness."""
    return {
        "status": "ok",
        "service": "api",
        "uptime_s": round(_PROCESS_START_TIME_MONO(), 3),
    }


@app.get("/health/ready")
async def health_ready(response: Response):
    """Readiness probe — process AND all dependencies reachable.
    Returns 503 if any dep is down so Docker / load balancers can
    take this instance out of rotation. Probes run on a 15s background
    loop so this endpoint stays sub-100ms even with flaky deps."""
    deps = _readiness_cache_snapshot()
    unhealthy = [name for name, d in deps.items() if d.get("status") != "up"]
    body = {
        "status": "ok" if not unhealthy else "degraded",
        "deps": deps,
    }
    if unhealthy:
        response.status_code = 503
        body["unhealthy"] = unhealthy
    return body


@app.get("/metrics")
async def metrics():
    """Prometheus exposition. Includes:
      - process_*: CPU%, RSS, VMS, fds, threads (via psutil)
      - api_uptime_seconds
      - dep_up{dep="livekit|supabase"}: 1/0 from last probe
      - dep_probe_latency_seconds{dep="..."}
      - http_requests_total{method,path,status} (incremented by middleware)
      - http_request_duration_seconds histogram (per route)
    """
    from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


# ── Campaigns / Batch Dialer ──────────────────────────────────────────────────

class CampaignCreate(BaseModel):
    name: str
    max_concurrent: int = 3
    outbound_trunk_id: str | None = None   # LiveKit SIP outbound trunk (None = default/US)
    caller_id_number: str | None = None    # informational display number for the chosen trunk
    agent_id: str | None = None            # DB agent that drives the campaign calls
    sip_trunk_id: str | None = None        # BYOC trunk from sip_trunks table


class CampaignUpdate(BaseModel):
    """Mutable fields on a campaign. Only fields present in the request are
    applied (model_dump(exclude_unset=True)), so partial updates like a
    rename work without resending everything else."""
    name: str | None = None
    max_concurrent: int | None = None
    agent_id: str | None = None


# Available outbound numbers/trunks a campaign can be configured to use.
# Keep in sync with LiveKit SIP outbound trunks created via scripts/setup_sip_trunks.py
# and scripts/setup_panama_sip.py.
OUTBOUND_TRUNK_OPTIONS = [
    {
        "trunk_id": os.getenv("LIVEKIT_SIP_OUTBOUND_TRUNK_ID", "ST_2A9WLRPPmDhD"),
        "number": os.getenv("TWILIO_PHONE_NUMBER", "+18782849980"),
        "label": "Estados Unidos (+1)",
    },
    {
        "trunk_id": os.getenv("LIVEKIT_SIP_OUTBOUND_TRUNK_PA", "ST_gojPBJbYBmAh"),
        "number": os.getenv("TWILIO_PHONE_NUMBER_PA", "+5072023503"),
        "label": "Panamá (+507)",
    },
]


@app.get("/campaigns/outbound-numbers")
async def list_outbound_numbers(_admin: dict = Depends(_get_admin_from_token)):
    """List all available outbound numbers: platform trunks + active BYOC trunks."""
    db = get_supabase()
    # Platform trunks (static)
    options = [opt for opt in OUTBOUND_TRUNK_OPTIONS if opt["trunk_id"]]
    # BYOC trunks from sip_trunks table
    byoc = db.table("sip_trunks").select("id,name,client_name,phone_number,lk_trunk_id").eq("is_active", True).execute().data or []
    for t in byoc:
        if t.get("lk_trunk_id"):
            options.append({
                "trunk_id": t["lk_trunk_id"],
                "number": t["phone_number"],
                "label": f"{t['client_name'] or t['name']} (BYOC)",
                "sip_trunk_id": t["id"],     # DB id for linking to campaign
            })
    return options


@app.post("/campaigns", status_code=201)
async def create_campaign(body: CampaignCreate, _admin: dict = Depends(_get_admin_from_token)):
    db = get_supabase()
    result = db.table("campaigns").insert({
        "name": body.name,
        "max_concurrent": body.max_concurrent,
        "outbound_trunk_id": body.outbound_trunk_id,
        "caller_id_number": body.caller_id_number,
        "agent_id": body.agent_id,
        "sip_trunk_id": body.sip_trunk_id,
    }).execute()
    return result.data[0]


@app.get("/campaigns")
async def list_campaigns(_admin: dict = Depends(_get_admin_from_token)):
    db = get_supabase()
    campaigns = db.table("campaigns").select("*").order("created_at", desc=True).execute().data or []
    if not campaigns:
        return []

    # Enrich counters with real dispositions from sessions.end_reason.
    # The dialer's own counters (campaigns.answered / .voicemail) only count
    # call_queue outcomes, not the agent's actual disposition.  We override them
    # here so the UI reflects the true breakdown.
    campaign_ids = [c["id"] for c in campaigns]
    cq_rows = (
        db.table("call_queue")
        .select("campaign_id,status,room_name,started_at")
        .in_("campaign_id", campaign_ids)
        .execute()
        .data or []
    )

    # Build end_reason lookup from sessions
    room_names = [r["room_name"] for r in cq_rows if r.get("room_name")]
    end_reason_map: dict[str, str] = {}
    if room_names:
        sess_rows = (
            db.table("sessions")
            .select("room_name,end_reason")
            .in_("room_name", room_names)
            .execute()
            .data or []
        )
        end_reason_map = {s["room_name"]: s.get("end_reason") for s in sess_rows}

    # Aggregate per campaign
    from collections import defaultdict
    stats: dict[str, dict] = defaultdict(lambda: {
        "called": 0, "answered": 0, "voicemail": 0, "no_answer": 0, "failed": 0,
    })
    _HUMAN_REASONS = {"client_hangup", "agent_hangup", "completed"}
    for row in cq_rows:
        cid = row["campaign_id"]
        q_status = row.get("status", "")
        # Only count rows that have actually completed a call attempt.
        # `pending` = queued, `calling` = dial in progress — neither should
        # count as "called" or the progress bar will hit 100% prematurely.
        # Mirrors the dialer's own _update_campaign_counters() logic.
        if q_status in ("pending", "calling"):
            continue
        stats[cid]["called"] += 1
        room = row.get("room_name")
        end_reason = end_reason_map.get(room) if room else None
        if end_reason == "voicemail":
            stats[cid]["voicemail"] += 1
        elif end_reason in _HUMAN_REASONS:
            stats[cid]["answered"] += 1
        elif q_status == "no_answer":
            stats[cid]["no_answer"] += 1
        elif q_status == "failed":
            stats[cid]["failed"] += 1
        elif not end_reason and q_status == "completed":
            # completed in queue but no session → treat as answered (very brief call)
            stats[cid]["answered"] += 1

    # Merge enriched stats into campaign rows
    enriched = []
    for c in campaigns:
        s = stats.get(c["id"])
        if s:
            c = {**c, **s}
        enriched.append(c)
    return enriched


@app.get("/campaigns/{campaign_id}")
async def get_campaign(campaign_id: str, _admin: dict = Depends(_get_admin_from_token)):
    db = get_supabase()
    campaign = db.table("campaigns").select("*").eq("id", campaign_id).single().execute()
    queue = db.table("call_queue").select("*").eq("campaign_id", campaign_id).order("created_at").execute()
    return {"campaign": campaign.data, "queue": queue.data}


@app.post("/campaigns/{campaign_id}/upload")
async def upload_csv(campaign_id: str, file: UploadFile = File(...), _admin: dict = Depends(_get_admin_from_token)):
    """
    Upload a CSV with columns: phone_number, customer_name, + any extras (stored in metadata).
    Required column: phone_number
    """
    db = get_supabase()

    # Verify campaign exists
    campaign = db.table("campaigns").select("id,status").eq("id", campaign_id).single().execute()
    if not campaign.data:
        raise HTTPException(status_code=404, detail="Campaign not found")
    if campaign.data["status"] not in ("draft",):
        raise HTTPException(status_code=400, detail="Can only upload to draft campaigns")

    content = await file.read()
    text = content.decode("utf-8-sig")  # handle BOM

    rows = []

    # Some lists are just a bare column of phone numbers with no header row.
    # `csv.DictReader` would otherwise swallow the first number as a "column
    # name" and silently skip its row. Sniff the first non-empty cell: if it
    # already looks like a phone number, treat the whole file as headerless.
    raw_lines = [ln for ln in csv.reader(io.StringIO(text)) if ln and ln[0].strip()]
    first_cell = raw_lines[0][0].strip() if raw_lines else ""
    headerless = bool(_PHONE_LIKE_RE.match(re.sub(r"[\s\-().]", "", first_cell)))

    if headerless:
        for line in raw_lines:
            phone = re.sub(r"[\s\-().]", "", line[0].strip())
            if not phone or not _PHONE_LIKE_RE.match(phone):
                continue
            name = line[1].strip() if len(line) > 1 else ""
            rows.append({
                "campaign_id": campaign_id,
                "phone_number": phone,
                "customer_name": name,
                "metadata": {},
            })
    else:
        # Recognized header spellings for the phone-number column, in priority order.
        _PHONE_HEADER_ALIASES = (
            "phone_number", "phone_numbers", "phone", "phone_no", "number", "numbers",
            "numero", "número", "numeros", "números", "telefono", "teléfono",
            "telefonos", "teléfonos", "celular", "movil", "móvil", "msisdn", "to",
        )
        reader = csv.DictReader(io.StringIO(text))
        for line in reader:
            # Normalize keys
            normalized = {k.strip().lower().replace(" ", "_"): v.strip() for k, v in line.items()}
            phone = None
            for alias in _PHONE_HEADER_ALIASES:
                phone = normalized.pop(alias, None)
                if phone:
                    break
            # Single-column file with an unrecognized header (e.g. "id", "contacto")
            # — if its lone value looks like a phone number, use it anyway.
            if not phone and len(normalized) == 1:
                (only_key, only_val), = normalized.items()
                candidate = re.sub(r"[\s\-().]", "", only_val or "")
                if _PHONE_LIKE_RE.match(candidate):
                    phone = candidate
                    normalized.pop(only_key, None)
            if not phone:
                continue
            name = normalized.pop("customer_name", None) or normalized.pop("nombre", None) or normalized.pop("nombre_cliente", None) or ""
            rows.append({
                "campaign_id": campaign_id,
                "phone_number": phone,
                "customer_name": name,
                "metadata": normalized,
            })

    if not rows:
        raise HTTPException(status_code=400, detail="No valid phone numbers found in CSV")

    # Insert in batches of 500
    for i in range(0, len(rows), 500):
        db.table("call_queue").insert(rows[i:i+500]).execute()

    db.table("campaigns").update({"total_numbers": len(rows)}).eq("id", campaign_id).execute()
    return {"inserted": len(rows), "campaign_id": campaign_id}


def _run_dialer(campaign_id: str) -> None:
    """Spawn dialer.py as subprocess using the venv Python (has livekit-api installed)."""
    dialer_path = os.path.join(os.path.dirname(__file__), "dialer/dialer.py")
    # Use the venv python which has all dependencies installed
    venv_python = os.path.join(os.path.dirname(sys.executable), "..", ".venv", "bin", "python")
    python_bin = venv_python if os.path.exists(venv_python) else "/app/.venv/bin/python"
    if not os.path.exists(python_bin):
        python_bin = sys.executable
    subprocess.Popen(
        [python_bin, dialer_path, campaign_id],
        env={**os.environ},
        start_new_session=True,
    )
    logger.info(f"Dialer launched for campaign {campaign_id} using {python_bin}")


@app.post("/campaigns/{campaign_id}/start")
async def start_campaign(campaign_id: str, background_tasks: BackgroundTasks, _admin: dict = Depends(_get_admin_from_token)):
    db = get_supabase()
    campaign = db.table("campaigns").select("id,status").eq("id", campaign_id).single().execute()
    if not campaign.data:
        raise HTTPException(status_code=404, detail="Campaign not found")
    if campaign.data["status"] == "running":
        raise HTTPException(status_code=400, detail="Campaign already running")

    db.table("campaigns").update({"status": "running"}).eq("id", campaign_id).execute()
    # Reset any stalled "calling" rows back to pending
    db.table("call_queue").update({"status": "pending"}).eq("campaign_id", campaign_id).eq("status", "calling").execute()

    background_tasks.add_task(_run_dialer, campaign_id)
    return {"status": "started", "campaign_id": campaign_id}


@app.post("/campaigns/{campaign_id}/pause")
async def pause_campaign(campaign_id: str, _admin: dict = Depends(_get_admin_from_token)):
    get_supabase().table("campaigns").update({"status": "paused"}).eq("id", campaign_id).execute()
    return {"status": "paused"}


@app.post("/campaigns/{campaign_id}/resume")
async def resume_campaign(campaign_id: str, background_tasks: BackgroundTasks, _admin: dict = Depends(_get_admin_from_token)):
    get_supabase().table("campaigns").update({"status": "running"}).eq("id", campaign_id).execute()
    background_tasks.add_task(_run_dialer, campaign_id)
    return {"status": "resumed"}


@app.post("/campaigns/{campaign_id}/stop")
async def stop_campaign(campaign_id: str, _admin: dict = Depends(_get_admin_from_token)):
    get_supabase().table("campaigns").update({"status": "cancelled"}).eq("id", campaign_id).execute()
    return {"status": "cancelled"}


@app.post("/campaigns/{campaign_id}/restart")
async def restart_campaign(campaign_id: str, background_tasks: BackgroundTasks, _admin: dict = Depends(_get_admin_from_token)):
    """Re-run a finished/cancelled campaign from scratch: clears prior call
    results, resets counters, and relaunches the dialer over the full list."""
    db = get_supabase()
    campaign = db.table("campaigns").select("id,status").eq("id", campaign_id).single().execute()
    if not campaign.data:
        raise HTTPException(status_code=404, detail="Campaign not found")
    if campaign.data["status"] in ("running",):
        raise HTTPException(status_code=400, detail="Campaign already running")

    db.table("call_queue").update({
        "status": "pending",
        "attempts": 0,
        "started_at": None,
        "ended_at": None,
        "duration_seconds": None,
        "transcript": None,
        "recording_url": None,
        "error_msg": None,
        "room_name": None,
    }).eq("campaign_id", campaign_id).execute()

    db.table("campaigns").update({
        "status": "running",
        "called": 0,
        "answered": 0,
        "voicemail": 0,
        "no_answer": 0,
        "failed": 0,
        "started_at": None,
        "completed_at": None,
    }).eq("id", campaign_id).execute()

    background_tasks.add_task(_run_dialer, campaign_id)
    return {"status": "restarted", "campaign_id": campaign_id}


@app.patch("/campaigns/{campaign_id}", tags=["admin"])
async def update_campaign(
    campaign_id: str,
    body: CampaignUpdate,
    _admin: dict = Depends(_get_admin_from_token),
):
    """Partial update of a campaign. Used today for renaming a campaign in
    place (e.g. when relaunching on the same contact list: "Cliente X — Intento 1"
    → "Cliente X — Intento 2"). Other mutable fields are kept here so the
    endpoint is the single point of change for live campaigns."""
    db = get_supabase()
    existing = db.table("campaigns").select("id").eq("id", campaign_id).execute()
    if not existing.data:
        raise HTTPException(status_code=404, detail="Campaign not found")

    updates = body.model_dump(exclude_unset=True)
    if not updates:
        return {"status": "no-op", "campaign_id": campaign_id}

    if "name" in updates:
        cleaned = (updates["name"] or "").strip()
        if not cleaned:
            raise HTTPException(status_code=400, detail="name cannot be empty")
        updates["name"] = cleaned

    db.table("campaigns").update(updates).eq("id", campaign_id).execute()
    return {"status": "updated", "campaign_id": campaign_id, "applied": list(updates.keys())}


@app.delete("/campaigns/{campaign_id}")
async def delete_campaign(campaign_id: str, _admin: dict = Depends(_get_admin_from_token)):
    db = get_supabase()
    campaign = db.table("campaigns").select("id,status").eq("id", campaign_id).single().execute()
    if not campaign.data:
        raise HTTPException(status_code=404, detail="Campaign not found")
    if campaign.data["status"] == "running":
        raise HTTPException(status_code=400, detail="Stop the campaign before deleting it")

    # `call_queue.campaign_id` has ON DELETE CASCADE — its rows are cleaned up automatically.
    db.table("campaigns").delete().eq("id", campaign_id).execute()
    return {"status": "deleted", "campaign_id": campaign_id}


@app.get("/campaigns/{campaign_id}/logs")
async def campaign_logs(campaign_id: str, status: str | None = None, _admin: dict = Depends(_get_admin_from_token)):
    db = get_supabase()
    query = db.table("call_queue").select(
        "id,phone_number,customer_name,status,room_name,duration_seconds,transcript,recording_url,started_at,ended_at,error_msg,metadata"
    ).eq("campaign_id", campaign_id)
    if status:
        query = query.eq("status", status)
    rows = query.order("created_at").execute().data or []

    # Enrich each row with the real call disposition from `sessions.end_reason`,
    # plus the session ID and twilio_call_sid needed to fetch recordings.
    # `call_queue.status` only reflects the dialer outcome (completed/no_answer/failed),
    # not the actual disposition (voicemail, client_hangup, etc.) from the agent.
    room_names = [r["room_name"] for r in rows if r.get("room_name")]
    end_reason_map: dict[str, str | None] = {}
    session_id_map: dict[str, str] = {}       # room_name → sessions.id
    twilio_sid_map: dict[str, str | None] = {} # room_name → twilio_call_sid
    if room_names:
        session_rows = (
            db.table("sessions")
            .select("id,room_name,end_reason,twilio_call_sid")
            .in_("room_name", room_names)
            .execute()
            .data or []
        )
        end_reason_map = {s["room_name"]: s.get("end_reason") for s in session_rows}
        session_id_map = {s["room_name"]: s["id"] for s in session_rows if s.get("id")}
        twilio_sid_map = {s["room_name"]: s.get("twilio_call_sid") for s in session_rows}

    for row in rows:
        room = row.get("room_name")
        # Prefer the real disposition from sessions.end_reason
        end_reason = end_reason_map.get(room) if room else None

        # Fallback: if no session exists (or session has null end_reason),
        # infer the disposition from the dialer's queue status so the UI
        # never shows the misleading "contestó" default.
        if not end_reason:
            q_status = row.get("status")
            if q_status == "no_answer":
                end_reason = "no_answer"
            elif q_status == "failed":
                end_reason = "failed"
            elif q_status == "completed":
                # Call connected but no session data — treat as client_hangup
                end_reason = "client_hangup"

        row["end_reason"] = end_reason
        row["session_id"] = session_id_map.get(room) if room else None
        row["twilio_call_sid"] = twilio_sid_map.get(room) if room else None

    return rows


# ── Telephony / Calls ─────────────────────────────────────────────────────────

class OutboundCallRequest(BaseModel):
    to_number: str          # E.164 e.g. "+15105551234"
    from_number: str | None = None  # Override default Twilio number
    agent_id: str | None = None  # DB agent (services/admin/agents) whose builder config drives the call


@app.post("/calls/outbound", tags=["admin"])
async def make_outbound_call(req: OutboundCallRequest, _admin: dict = Depends(_get_admin_from_token)):
    """Initiate an outbound call: LiveKit SIP → Twilio → phone number. Admin only — this incurs real cost."""
    from livekit import api as lk_api
    from datetime import datetime, timezone

    room_name = f"call-out-{uuid.uuid4().hex[:8]}"
    call_id = str(uuid.uuid4())
    from_number = req.from_number or os.getenv("TWILIO_PHONE_NUMBER", "")

    try:
        lkapi = lk_api.LiveKitAPI(
            url=os.getenv("LIVEKIT_URL", "ws://localhost:7880"),
            api_key=LIVEKIT_API_KEY,
            api_secret=LIVEKIT_API_SECRET,
        )

        # Create the outbound SIP call via LiveKit
        sip_client = lkapi.sip
        outbound_trunk_id = os.getenv("LIVEKIT_SIP_OUTBOUND_TRUNK_ID", "")
        if not outbound_trunk_id:
            raise HTTPException(status_code=503, detail="LIVEKIT_SIP_OUTBOUND_TRUNK_ID not configured")

        # Pre-create the room with the voice agent dispatched into it — without this,
        # the SIP call connects but no agent joins to talk. Mirrors services/dialer/dialer.py.
        # `metadata` carries the DB agent_id so the worker can load that agent's
        # builder config (prompt/voice/models/tools) at session start — see
        # _load_agent_config in services/agent/src/agent.py.
        dispatch_metadata = json.dumps({"agent_id": req.agent_id}) if req.agent_id else None
        await lkapi.room.create_room(
            lk_api.CreateRoomRequest(
                name=room_name,
                empty_timeout=120,
                agents=[lk_api.RoomAgentDispatch(agent_name="voice-agent", metadata=dispatch_metadata)],
            )
        )

        participant = await sip_client.create_sip_participant(
            lk_api.CreateSIPParticipantRequest(
                sip_trunk_id=outbound_trunk_id,
                # Let the trunk's configured `address` handle routing — just pass the
                # destination number via `sip_call_to`. Mirrors the working pattern in
                # services/dialer/dialer.py. The old `sip_url` field was removed from
                # CreateSIPParticipantRequest in newer livekit-protocol releases (1.1.13+),
                # and its replacement `sip_request_uri` expects a typed SIPRequestDest,
                # not a plain string — and isn't needed when a trunk is already configured.
                sip_call_to=req.to_number,
                room_name=room_name,
                participant_identity=f"phone-{req.to_number}",
                participant_name=req.to_number,
                play_ringtone=True,
            )
        )
        await lkapi.aclose()

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"SIP call failed: {e}")

    # Log to Supabase
    db = get_supabase()
    db.table("calls").insert({
        "id": call_id,
        "direction": "outbound",
        "from_number": from_number,
        "to_number": req.to_number,
        "room_name": room_name,
        "status": "initiated",
        "started_at": datetime.now(timezone.utc).isoformat(),
    }).execute()

    return {
        "call_id": call_id,
        "room_name": room_name,
        "to_number": req.to_number,
        "status": "initiated",
    }


@app.get("/calls", tags=["admin"])
async def list_calls(
    limit: int = 50,
    offset: int = 0,
    agent_id: str | None = None,
    client_id: str | None = None,
    campaign_id: str | None = None,
    direction: str | None = None,           # "inbound" | "outbound"
    status: str | None = None,              # "in_progress" | "completed" | "client_hangup" | "voicemail" | "no_answer" | "failed"
    date_from: str | None = None,           # ISO datetime, inclusive lower bound on started_at
    date_to: str | None = None,             # ISO datetime, inclusive upper bound on started_at
    phone_search: str | None = None,        # substring search against from_number/to_number/room_name
    call_id: str | None = None,             # exact match on sessions.id
    _admin: dict = Depends(_get_admin_from_token),
):
    """
    General call log for the admin (inbound + outbound, all clients).

    Sourced from `sessions` — the table the voice agent populates with the
    final outcome of every call (cost, duration, transcript, recording) — so
    the cost-per-call shown here is always real, not the stale/null values
    left behind in the legacy `calls` table. See `_session_to_call_row`.

    Phase 3.1 adds 8 filter params + pagination. DB-level filters (agent_id,
    client_id, campaign_id, status, date range, call_id) hit indexes; derived
    filters (direction, phone_search) are applied in Python after materializing
    the rows. We over-fetch up to 1000 rows so direction/phone filters have a
    useful working set even on the post-filter slice.
    """
    db = get_supabase()

    # client_id → agent_ids lookup. Sessions don't carry client_id directly,
    # so we fan out via agents.client_id and then filter sessions by IN.
    # If neither client_id nor agent_id is set, we don't constrain by agent.
    client_agent_ids: list[str] | None = None
    if client_id and not agent_id:
        agents_rows = (
            db.table("agents").select("id").eq("client_id", client_id).execute().data or []
        )
        client_agent_ids = [a["id"] for a in agents_rows]
        # If the client has no agents, short-circuit to an empty result rather
        # than running a query that would return all un-agent calls.
        if not client_agent_ids:
            return {"calls": [], "total": 0, "limit": limit, "offset": offset, "filters_applied": 0}

    q = db.table("sessions").select(_CALL_LOG_SELECT).like("room_name", "call-%")

    # DB-level filters
    if call_id:
        q = q.eq("id", call_id)
    if agent_id:
        q = q.eq("agent_id", agent_id)
    elif client_agent_ids is not None:
        q = q.in_("agent_id", client_agent_ids)
    if campaign_id:
        # Campaign call rooms are named call-<campaignId>-<suffix>.
        q = q.like("room_name", f"call-{campaign_id}-%")
    if status:
        if status == "in_progress":
            q = q.is_("ended_at", "null")
        else:
            q = q.eq("end_reason", status)
    if date_from:
        q = q.gte("started_at", date_from)
    if date_to:
        q = q.lte("started_at", date_to)

    # Over-fetch so derived filters (direction, phone_search) still have rows
    # to slice from. The hard cap also prevents the dashboard from forcing a
    # multi-thousand-row scan on a free-text phone search.
    FETCH_CAP = 1000
    q = q.order("started_at", desc=True).limit(FETCH_CAP)
    rows = q.execute().data or []

    # Materialize via the existing helper, then derive direction + phones.
    phone_lookup = _phone_lookup_for_rooms(db, [r.get("room_name") for r in rows])
    mapped = [_session_to_call_row(s, phone_lookup) for s in rows]

    # Derived (in-Python) filters
    if direction in ("inbound", "outbound"):
        mapped = [c for c in mapped if c.get("direction") == direction]

    if phone_search:
        needle = phone_search.lower().strip()
        if needle:
            mapped = [
                c for c in mapped
                if needle in (c.get("from_number") or "").lower()
                or needle in (c.get("to_number") or "").lower()
                or needle in (c.get("room_name") or "").lower()
            ]

    # Count how many of the 8 filters the caller actually used — useful for
    # surfacing an "X filtros activos" badge in the dashboard FilterBar.
    filters_applied = sum(
        1 for v in (
            agent_id, client_id, campaign_id, direction, status,
            date_from, date_to, phone_search,
        ) if v
    )
    # call_id is a 9th param but exclusive (short-circuits to 1 row max).
    # Don't count it as a filter — UI treats it as a direct lookup.

    total = len(mapped)
    page = mapped[offset:offset + limit]

    return {
        "calls": page,
        "total": total,
        "limit": limit,
        "offset": offset,
        "filters_applied": filters_applied,
        "truncated": total >= FETCH_CAP,
    }


@app.get("/calls/{call_id}")
async def get_call(call_id: str, _admin: dict = Depends(_get_admin_from_token)):
    db = get_supabase()
    result = db.table("calls").select("*").eq("id", call_id).single().execute()
    return result.data


@app.post("/calls/webhook/inbound")
async def inbound_call_webhook(request: Request):
    """
    Webhook called by Twilio (or LiveKit SIP) when an inbound call arrives.
    Logs the call to Supabase.

    S1.1 — Two valid auth modes:
      1. Twilio-signed: header `X-Twilio-Signature` is a valid HMAC-SHA1 of
         (URL + sorted POST body) using the configured Twilio auth token.
      2. Internal: header `X-Internal-Webhook-Secret` matches
         `INTERNAL_WEBHOOK_SECRET` env var. Used by LiveKit SIP or local tests.

    Anything else → 401. This prevents anonymous internet callers from
    inserting fake call rows (which polluted call logs and inflated cost
    reports before the validation was added).
    """
    import hmac
    import hashlib
    import base64
    from datetime import datetime, timezone

    # Read the raw body. We re-parse it here (rather than relying on
    # FastAPI's body parsing) so the signature can be computed over the
    # exact bytes Twilio sent.
    raw_body = await request.body()
    try:
        payload = json.loads(raw_body) if raw_body else {}
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="invalid JSON body")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="body must be a JSON object")

    sig = request.headers.get("X-Twilio-Signature", "")
    internal_secret_header = request.headers.get("X-Internal-Webhook-Secret", "")
    expected_internal = os.getenv("INTERNAL_WEBHOOK_SECRET", "")

    valid = False
    auth_mode = None

    if sig and _twilio_signature_valid(request, sig, payload):
        valid = True
        auth_mode = "twilio"
    elif expected_internal and hmac.compare_digest(internal_secret_header, expected_internal):
        valid = True
        auth_mode = "internal"
    # Dev fallback: only if no Twilio creds are configured AT ALL and no
    # internal secret is set. In prod this branch is unreachable because
    # we always have at least one Twilio auth token configured.
    elif not sig and not expected_internal and not _any_twilio_token_configured():
        valid = True
        auth_mode = "dev-allow-all"

    if not valid:
        # Don't leak which check failed — keep the 401 opaque to avoid
        # signature-forgery probes.
        raise HTTPException(status_code=401, detail="Unauthorized")

    db = get_supabase()
    db.table("calls").insert({
        "direction": "inbound",
        "from_number": payload.get("from", "unknown"),
        "to_number": payload.get("to", os.getenv("TWILIO_PHONE_NUMBER", "")),
        "room_name": payload.get("room_name", ""),
        "status": "in_progress",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "metadata": {**payload, "_webhook_auth": auth_mode},
    }).execute()
    return {"status": "ok", "auth": auth_mode}


def _any_twilio_token_configured() -> bool:
    """True if at least one Twilio auth token is in the env. Used to fail
    closed: if any Twilio integration is configured, the dev fallback is off."""
    return any(
        os.getenv(f"TWILIO_AUTH_TOKEN{suffix}") for suffix in ("", "_PA")
    )


def _twilio_signature_valid(request: Request, signature: str, body: dict) -> bool:
    """Verify Twilio's X-Twilio-Signature against the request URL + POST body.

    Twilio's algorithm (https://www.twilio.com/docs/usage/webhooks/webhooks-security):
      sig = base64(HMAC_SHA1(auth_token, url + sorted(k1v1k2v2...)))
    We concatenate the JSON body in sorted-key order (Twilio POSTs form-encoded,
    but for our internal use case the JSON parse is equivalent — we sign the
    parsed dict's keys+values in alphabetical order).

    If any token isn't configured, this returns False.
    """
    import hmac
    import hashlib
    import base64

    accounts = _get_twilio_accounts()
    if not accounts:
        return False

    # Reconstruct the URL Twilio used (with https, no query string).
    url = str(request.url).split("?")[0]
    # Force https even when running behind a TLS-terminating proxy that
    # forwards http internally.
    if url.startswith("http://"):
        url = "https://" + url[len("http://"):]

    # Sort keys alphabetically; concat key+value as strings.
    sorted_kvs = "".join(f"{k}{body[k]}" for k in sorted(body.keys()) if body[k] is not None)
    signed_payload = url + sorted_kvs

    # Try every configured Twilio account — we don't know which one signed it.
    for account_sid, auth_token in accounts:
        digest = hmac.new(
            auth_token.encode("utf-8"),
            signed_payload.encode("utf-8"),
            hashlib.sha1,
        ).digest()
        expected = base64.b64encode(digest).decode("ascii")
        if hmac.compare_digest(signature, expected):
            return True
    return False


# ── Client Portal API ─────────────────────────────────────────────────────────

@app.post("/auth/login", tags=["auth"])
async def unified_login(body: dict, response: Response):
    """
    Single entry point for the platform: exchange email+password for a
    Supabase session token and resolve which role the account has.

    S2.4 — also sets the session + CSRF cookies for whichever role is
    resolved. The role-aware cookies (`admin_session` / `portal_session`)
    mean a single browser session can be logged in as admin OR client
    without collisions.
    """
    email = body.get("email", "")
    password = body.get("password", "")
    try:
        from supabase import create_client
        anon = create_client(
            os.getenv("SUPABASE_URL", ""),
            os.getenv("SUPABASE_ANON_KEY", ""),
        )
        session = anon.auth.sign_in_with_password({"email": email, "password": password})
        uid = session.session.user.id
    except Exception:
        raise HTTPException(status_code=401, detail="Credenciales inválidas")

    svc = get_supabase()
    token_payload = {
        "access_token": session.session.access_token,
        "refresh_token": session.session.refresh_token,
        "expires_in": session.session.expires_in,
    }

    admin = svc.table("admin_users").select("id,name,email,role,is_active").eq("supabase_uid", uid).maybe_single().execute()
    if admin and admin.data and admin.data.get("is_active", True):
        csrf = _set_session_cookies(response, "admin", session.session.access_token)
        return {**token_payload, "role": "admin", "profile": admin.data, "csrf_token": csrf}

    client = svc.table("clients").select("id,name,email,is_active").eq("supabase_uid", uid).maybe_single().execute()
    if client and client.data and client.data.get("is_active", True):
        csrf = _set_session_cookies(response, "client", session.session.access_token)
        return {**token_payload, "role": "client", "profile": client.data, "csrf_token": csrf}

    raise HTTPException(status_code=403, detail="Esta cuenta no tiene acceso a la plataforma")


@app.post("/admin/login", tags=["admin"])
async def admin_login(body: dict, response: Response):
    """Exchange email+password for a Supabase session token (admin only).

    S2.4 — sets two cookies:
      • `admin_session` (HttpOnly, Secure, SameSite=Strict) carries the JWT.
        The browser sends this automatically; JS cannot read it, so XSS can't
        exfiltrate the session.
      • `csrf_admin` (NOT HttpOnly) carries a random 32-byte token. The
        dashboard reads it via document.cookie and echoes it as the
        `X-CSRF-Token` header on every mutating request.

    Backward compat: the body still returns `access_token` for callers that
    can't use cookies (curl, scripts, the dashboard in transition).
    """
    email = body.get("email", "")
    password = body.get("password", "")
    try:
        from supabase import create_client
        anon = create_client(
            os.getenv("SUPABASE_URL", ""),
            os.getenv("SUPABASE_ANON_KEY", ""),
        )
        session = anon.auth.sign_in_with_password({"email": email, "password": password})
        uid = session.session.user.id

        # Verify this user is actually a registered admin (not just any Supabase user)
        svc = get_supabase()
        admin = svc.table("admin_users").select("id,is_active").eq("supabase_uid", uid).single().execute()
        if not admin.data or not admin.data.get("is_active", True):
            raise HTTPException(status_code=403, detail="Not an admin account")

        # S2.4 — set cookies + CSRF
        csrf = _set_session_cookies(response, "admin", session.session.access_token)

        return {
            "access_token": session.session.access_token,
            "refresh_token": session.session.refresh_token,
            "expires_in": session.session.expires_in,
            "csrf_token": csrf,
        }
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid credentials")


@app.post("/admin/logout", tags=["admin"])
async def admin_logout(response: Response, _admin: dict = Depends(_get_admin_from_token)):
    """Clear the admin session + CSRF cookies. Always succeeds — even if
    the token is already expired, the cookies get cleared client-side."""
    _clear_session_cookies(response, "admin")
    return {"status": "ok"}


@app.get("/admin/me", tags=["admin"])
async def admin_me(admin: dict = Depends(_get_admin_from_token)):
    """Return the authenticated admin's profile."""
    return {"admin": admin}


# -- Admin endpoints (require admin JWT — see _get_admin_from_token) -----------

class AdminCreateClient(BaseModel):
    name: str
    email: str
    password: str
    agent_name: str = "Camila"
    voice_id: str = "6uZeZ0TKIeJahuKIBwp7"

    @field_validator("password")
    @classmethod
    def _password_min_length(cls, v: str) -> str:
        # S4.3 — same complexity rule as AdminUserCreate.
        if len(v) < 12:
            raise ValueError("Password must be at least 12 characters")
        if not any(c.isupper() for c in v):
            raise ValueError("Password must contain at least one uppercase letter")
        if not any(c.isdigit() for c in v):
            raise ValueError("Password must contain at least one digit")
        return v


@app.post("/admin/clients", tags=["admin"])
async def admin_create_client(body: AdminCreateClient, _admin: dict = Depends(_get_admin_from_token)):
    """Create a new client account + their agent. Called by admin only."""
    svc = get_supabase()
    url = os.getenv("SUPABASE_URL", "")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    try:
        from supabase import create_client
        admin_client = create_client(url, key)
        # 1. Create Supabase auth user
        auth_resp = admin_client.auth.admin.create_user({
            "email": body.email,
            "password": body.password,
            "email_confirm": True,
        })
        uid = auth_resp.user.id
        # 2. Insert client row
        client = svc.table("clients").insert({
            "name": body.name,
            "email": body.email,
            "supabase_uid": uid,
        }).execute().data[0]
        # 3. Insert agent row
        agent = svc.table("agents").insert({
            "client_id": client["id"],
            "name": body.agent_name,
            "voice_id": body.voice_id,
            "lk_agent_name": "voice-agent",
            "tts_speed": 1.1,
        }).execute().data[0]
        return {"client": client, "agent": agent}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/admin/clients", tags=["admin"])
async def admin_list_clients(_admin: dict = Depends(_get_admin_from_token)):
    db = get_supabase()
    clients = db.table("clients").select("*, agents(*)").order("created_at", desc=True).execute()
    return clients.data


@app.get("/admin/clients/{client_id}", tags=["admin"])
async def admin_get_client(client_id: str, _admin: dict = Depends(_get_admin_from_token)):
    """Fetch a single client with its assigned agents (for the detail/edit view)."""
    db = get_supabase()
    result = db.table("clients").select("*, agents(*)").eq("id", client_id).single().execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Client not found")
    return result.data


class ClientUpdate(BaseModel):
    name: str | None = None
    email: str | None = None
    is_active: bool | None = None


@app.patch("/admin/clients/{client_id}", tags=["admin"])
async def admin_update_client(client_id: str, body: ClientUpdate, _admin: dict = Depends(_get_admin_from_token)):
    """Update a client's profile or toggle their active status (deactivate/reactivate)."""
    db = get_supabase()
    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    # Keep Supabase Auth email in sync if it's changing
    if "email" in updates:
        client = db.table("clients").select("supabase_uid").eq("id", client_id).single().execute()
        if not client.data:
            raise HTTPException(status_code=404, detail="Client not found")
        uid = client.data.get("supabase_uid")
        if uid:
            try:
                from supabase import create_client
                admin_client = create_client(
                    os.getenv("SUPABASE_URL", ""),
                    os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""),
                )
                admin_client.auth.admin.update_user_by_id(uid, {"email": updates["email"]})
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"Failed to update auth email: {e}")

    result = db.table("clients").update(updates).eq("id", client_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Client not found")
    return result.data[0]


@app.delete("/admin/clients/{client_id}", tags=["admin"])
async def admin_delete_client(client_id: str, _admin: dict = Depends(_get_admin_from_token)):
    """Permanently delete a client (only if it has no agents). Prefer deactivating via PATCH."""
    db = get_supabase()
    agents = db.table("agents").select("id").eq("client_id", client_id).limit(1).execute()
    if agents.data:
        raise HTTPException(
            status_code=400,
            detail="Cannot delete client with assigned agents — reassign or delete the agents first, or deactivate the client instead.",
        )
    result = db.table("clients").delete().eq("id", client_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Client not found")
    return {"status": "deleted"}


# -- User management (admin): invite / create accounts with roles -------------


def _admin_auth_client():
    from supabase import create_client
    return create_client(
        os.getenv("SUPABASE_URL", ""),
        os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""),
    )


def _auth_user_status(admin_client: object, uid: str | None) -> str:
    """Return 'invited' if the auth user hasn't confirmed/set a password yet, else 'active'."""
    if not uid:
        return "active"
    try:
        resp = admin_client.auth.admin.get_user_by_id(uid)
        confirmed = getattr(resp.user, "email_confirmed_at", None) if resp and resp.user else None
        return "active" if confirmed else "invited"
    except Exception:
        return "active"


@app.get("/admin/users", tags=["admin"])
async def admin_list_users(_admin: dict = Depends(_get_admin_from_token)):
    """List all platform users (admins + clients) with their role and status."""
    db = get_supabase()
    admin_client = _admin_auth_client()

    admins = db.table("admin_users").select("*").order("created_at", desc=True).execute().data or []
    clients = db.table("clients").select("*").order("created_at", desc=True).execute().data or []

    users = []
    for row in admins:
        users.append({
            "id": row["id"],
            "name": row.get("name"),
            "email": row.get("email"),
            "role": "admin",
            "supabase_uid": row.get("supabase_uid"),
            "is_active": row.get("is_active", True),
            "status": _auth_user_status(admin_client, row.get("supabase_uid")),
            "created_at": row.get("created_at"),
        })
    for row in clients:
        users.append({
            "id": row["id"],
            "name": row.get("name"),
            "email": row.get("email"),
            "role": "cliente",
            "supabase_uid": row.get("supabase_uid"),
            "is_active": row.get("is_active", True),
            "status": _auth_user_status(admin_client, row.get("supabase_uid")),
            "created_at": row.get("created_at"),
        })

    users.sort(key=lambda u: u.get("created_at") or "", reverse=True)
    return users


class AdminUserInvite(BaseModel):
    name: str
    email: str
    role: Literal["admin", "cliente"]


@app.post("/admin/users/invite", tags=["admin"])
async def admin_invite_user(body: AdminUserInvite, _admin: dict = Depends(_get_admin_from_token)):
    """Invite a new user by email via Supabase Auth and assign them a role.

    Requires SMTP to be configured in the Supabase project (Authentication →
    Settings → SMTP) for the invitation email to actually be delivered.
    """
    db = get_supabase()
    admin_client = _admin_auth_client()

    table = "admin_users" if body.role == "admin" else "clients"

    try:
        auth_resp = admin_client.auth.admin.invite_user_by_email(
            body.email,
            {
                "data": {"name": body.name},
                "redirect_to": f"{FRONTEND_URL}/auth/set-password",
            },
        )
    except Exception as e:
        msg = str(e)
        if "already" in msg.lower() or "registered" in msg.lower() or "exists" in msg.lower():
            raise HTTPException(status_code=409, detail="A user with this email already exists")
        raise HTTPException(status_code=400, detail=f"Failed to send invitation: {msg}")

    uid = auth_resp.user.id
    insert_data = {
        "name": body.name,
        "email": body.email,
        "supabase_uid": uid,
        "is_active": True,
    }
    if body.role == "admin":
        insert_data["role"] = "admin"
    try:
        row = db.table(table).insert(insert_data).execute().data[0]
    except Exception as e:
        # Rollback the auth user if the profile row couldn't be created
        try:
            admin_client.auth.admin.delete_user(uid)
        except Exception:
            pass
        raise HTTPException(status_code=400, detail=f"Failed to create user profile: {e}")

    return {**row, "role": body.role, "status": "invited"}


class AdminUserCreate(BaseModel):
    name: str
    email: str
    password: str
    role: Literal["admin", "cliente"]

    @field_validator("password")
    @classmethod
    def _password_min_length(cls, v: str) -> str:
        # S4.3 — stronger password policy: 12+ chars, at least one uppercase
        # and at least one digit. The 8-char minimum was too weak given that
        # credentials stored in Supabase are the gateway to admin sessions.
        if len(v) < 12:
            raise ValueError("Password must be at least 12 characters")
        if not any(c.isupper() for c in v):
            raise ValueError("Password must contain at least one uppercase letter")
        if not any(c.isdigit() for c in v):
            raise ValueError("Password must contain at least one digit")
        return v


@app.post("/admin/users", tags=["admin"])
async def admin_create_user(body: AdminUserCreate, _admin: dict = Depends(_get_admin_from_token)):
    """Create a new user account directly with an admin-set password.

    No invitation email is sent and the password is not forced to be changed
    on first login (`email_confirm: True`).
    """
    db = get_supabase()
    admin_client = _admin_auth_client()

    table = "admin_users" if body.role == "admin" else "clients"

    try:
        auth_resp = admin_client.auth.admin.create_user({
            "email": body.email,
            "password": body.password,
            "email_confirm": True,
        })
    except Exception as e:
        msg = str(e)
        if "already" in msg.lower() or "registered" in msg.lower() or "exists" in msg.lower():
            raise HTTPException(status_code=409, detail="A user with this email already exists")
        raise HTTPException(status_code=400, detail=f"Failed to create user: {msg}")

    uid = auth_resp.user.id
    insert_data = {
        "name": body.name,
        "email": body.email,
        "supabase_uid": uid,
        "is_active": True,
    }
    if body.role == "admin":
        insert_data["role"] = "admin"
    try:
        row = db.table(table).insert(insert_data).execute().data[0]
    except Exception as e:
        try:
            admin_client.auth.admin.delete_user(uid)
        except Exception:
            pass
        raise HTTPException(status_code=400, detail=f"Failed to create user profile: {e}")

    return {**row, "role": body.role, "status": "active"}


class AdminUserUpdate(BaseModel):
    name: str | None = None
    is_active: bool | None = None


@app.post("/admin/users/{role}/{user_id}/resend-invite", tags=["admin"])
async def admin_resend_invite(
    role: Literal["admin", "cliente"], user_id: str, _admin: dict = Depends(_get_admin_from_token)
):
    """Resend the invitation email to a user who hasn't set their password yet.

    Uses Supabase's password-recovery email (works regardless of whether the
    user already confirmed their account) so it can be reused even if the
    original invite link expired. The link points to `/auth/set-password`,
    same as a fresh invite.
    """
    db = get_supabase()
    table = "admin_users" if role == "admin" else "clients"

    row = db.table(table).select("email").eq("id", user_id).execute().data
    if not row:
        raise HTTPException(status_code=404, detail="User not found")
    email = row[0].get("email")
    if not email:
        raise HTTPException(status_code=400, detail="User has no email on file")

    admin_client = _admin_auth_client()
    try:
        admin_client.auth.reset_password_for_email(
            email,
            {"redirect_to": f"{FRONTEND_URL}/auth/set-password"},
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to resend invitation: {e}")

    return {"status": "sent"}


@app.patch("/admin/users/{role}/{user_id}", tags=["admin"])
async def admin_update_user(
    role: Literal["admin", "cliente"], user_id: str, body: AdminUserUpdate, _admin: dict = Depends(_get_admin_from_token)
):
    """Update a user's profile (name) or toggle their active status."""
    db = get_supabase()
    table = "admin_users" if role == "admin" else "clients"

    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    result = db.table(table).update(updates).eq("id", user_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="User not found")
    return {**result.data[0], "role": role}


@app.delete("/admin/users/{role}/{user_id}", tags=["admin"])
async def admin_delete_user(
    role: Literal["admin", "cliente"], user_id: str, _admin: dict = Depends(_get_admin_from_token)
):
    """Deactivate a user account (soft delete)."""
    db = get_supabase()
    table = "admin_users" if role == "admin" else "clients"

    if role == "admin" and _admin.get("id") == user_id:
        raise HTTPException(status_code=400, detail="You cannot deactivate your own admin account")

    result = db.table(table).update({"is_active": False}).eq("id", user_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="User not found")
    return {"status": "deactivated"}


# -- Agent CRUD (admin) --------------------------------------------------------

class AgentCreate(BaseModel):
    client_id: str | None = None
    name: str
    voice_id: str | None = None
    lk_agent_name: str = "voice-agent"
    tts_speed: float | None = 1.1
    llm_model: str | None = None
    stt_provider: str | None = None
    tts_provider: str | None = None
    stt_model: str | None = None
    tts_model: str | None = None
    language: str | None = None
    temperature: float | None = None
    # Inworld TTS fine-tuning (only used when tts_provider == "inworld")
    tts_temperature: float | None = None
    tts_text_normalization: bool | None = None
    tts_delivery_mode: str | None = None
    tts_buffer_char_threshold: int | None = None
    tts_max_buffer_delay_ms: int | None = None


# Fields that make up an agent's editable runtime configuration. Every PATCH
# that touches one of these triggers a new row in `agent_versions` so admins
# can review history and roll back — mirrors VAPI's "publish" / version model.
AGENT_CONFIG_FIELDS = (
    "name", "description", "system_prompt", "greeting", "voice_id",
    "llm_model", "stt_model", "tts_model", "stt_provider", "tts_provider",
    "temperature", "language",
    "idle_timeout_seconds", "idle_message",
    "tts_speed", "tts_temperature", "tts_text_normalization",
    "tts_delivery_mode", "tts_buffer_char_threshold", "tts_max_buffer_delay_ms",
    "turn_handling",
)


class AgentUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    voice_id: str | None = None
    lk_agent_name: str | None = None
    is_active: bool | None = None
    system_prompt: str | None = None
    greeting: str | None = None
    llm_model: str | None = None
    stt_model: str | None = None
    tts_model: str | None = None
    stt_provider: str | None = None
    tts_provider: str | None = None
    temperature: float | None = None
    language: str | None = None
    # TTS speed multiplier (0.8-1.2 ElevenLabs, 0.5-1.5 Inworld; backend clamps).
    tts_speed: float | None = None
    # Inworld TTS fine-tuning (only used when tts_provider == "inworld")
    tts_temperature: float | None = None
    tts_text_normalization: bool | None = None
    tts_delivery_mode: str | None = None
    tts_buffer_char_threshold: int | None = None
    tts_max_buffer_delay_ms: int | None = None
    # Post-call webhook (VAPI-style end-of-call report). When webhook_url is
    # set, the worker POSTs a JSON report (transcript, summary, tools used,
    # costs) to this URL at the end of every call. webhook_secret signs
    # the body with HMAC-SHA256 (X-Webhook-Signature: sha256=<hex>).
    webhook_url: str | None = None
    webhook_secret: str | None = None
    # Idle nudge: if the customer stays silent for this many seconds, the
    # agent proactively says `idle_message` (e.g. "¿sigues ahí?"). Set
    # `idle_timeout_seconds` to null/0 to disable.
    idle_timeout_seconds: int | None = None
    idle_message: str | None = None
    # VAPI-style Start/Stop Speaking Plan + interruption + preemptive
    # generation knobs. Stored as JSONB on the agent row and consumed by
    # the worker in entrypoint(). Empty dict (default) keeps legacy behavior.
    turn_handling: dict | None = None
    # Reassign an agent to a different client (or unassign by passing null).
    # Used by the client-detail page to manage which agents belong to which
    # customer. We block the change if the agent has active sessions.
    client_id: str | None = None
    note: str | None = None  # optional changelog message for the version snapshot


def _snapshot_agent_version(db, agent: dict, note: str | None, admin_id: str | None) -> None:
    """Write an immutable snapshot of `agent`'s current config to agent_versions.

    Called right before persisting a change, so the snapshot represents the
    state being replaced — version N+1 always reflects the config saved in
    that PATCH. Failures are logged but never block the actual save.
    """
    try:
        last = (
            db.table("agent_versions")
            .select("version_number")
            .eq("agent_id", agent["id"])
            .order("version_number", desc=True)
            .limit(1)
            .execute()
        )
        next_version = (last.data[0]["version_number"] + 1) if last.data else 1
        db.table("agent_versions").insert({
            "agent_id": agent["id"],
            "version_number": next_version,
            "name": agent.get("name"),
            "description": agent.get("description"),
            "system_prompt": agent.get("system_prompt"),
            "greeting": agent.get("greeting"),
            "voice_id": agent.get("voice_id"),
            "llm_model": agent.get("llm_model"),
            "stt_model": agent.get("stt_model"),
            "tts_model": agent.get("tts_model"),
            "temperature": agent.get("temperature"),
            "language": agent.get("language"),
            "turn_handling": agent.get("turn_handling") or {},
            "note": note,
            "created_by": admin_id,
        }).execute()
    except Exception as e:
        logger.error(f"Failed to snapshot agent version for {agent['id']}: {e}")


# ── BYOC / SIP Trunks ────────────────────────────────────────────────────────

class SipTrunkCreate(BaseModel):
    name: str
    client_name: str | None = None
    sip_server: str
    sip_username: str
    sip_password: str
    phone_number: str
    agent_id: str | None = None
    inbound_enabled: bool = False


class SipTrunkUpdate(BaseModel):
    name: str | None = None
    client_name: str | None = None
    agent_id: str | None = None
    inbound_enabled: bool | None = None
    is_active: bool | None = None


@app.get("/admin/sip-trunks", tags=["admin"])
async def list_sip_trunks(_admin: dict = Depends(_get_admin_from_token)):
    """List all BYOC SIP trunks registered on the platform."""
    db = get_supabase()
    rows = db.table("sip_trunks").select("*").order("created_at", desc=True).execute().data or []
    return rows


# ── Phone Numbers ───────────────────────────────────────────────────────────
# Phase 3.2: flat catalog of phone numbers provisioned in Twilio (or other
# providers), independent from the SIP-trunk credential layer. Each number can
# be assigned to an agent and/or a client for inbound/outbound routing.

class PhoneNumberCreate(BaseModel):
    number: str                       # E.164, e.g. "+5072023503"
    label: str | None = None          # human-friendly description
    provider: str                     # "twilio_pa" | "twilio_us" | "manual"
    provider_sid: str | None = None   # Twilio IncomingPhoneNumber SID (PNxxxx…)
    capabilities: dict | None = None  # {"voice": true, "sms": true, "mms": false}
    agent_id: str | None = None
    client_id: str | None = None


class PhoneNumberUpdate(BaseModel):
    label: str | None = None
    agent_id: str | None = None       # null unassigns
    client_id: str | None = None      # null unassigns
    is_active: bool | None = None


class PhoneNumberSearchRequest(BaseModel):
    """Search Twilio's AvailablePhoneNumbers API. Today this only queries the
    default US account (`twilio_us`); we extend to `_PA` later if needed."""
    country: str = "US"               # ISO country code (US, PA, MX, …)
    type: str = "local"               # "local" | "tollfree" | "mobile"
    contains: str | None = None       # substring match on the number digits
    page_size: int = 10


class PhoneNumberImportRequest(BaseModel):
    """Import a Twilio-owned number into the platform: creates the LiveKit
    inbound trunk + dispatch rule and (if needed) attaches the number to the
    shared Twilio Elastic SIP Trunk that points at our LiveKit SIP server."""
    incoming_phone_number_sid: str   # Twilio IncomingPhoneNumber SID (PNxxxx…)
    provider: str                    # "twilio_us" | "twilio_pa"
    agent_id: str | None = None
    label: str | None = None


class PhoneNumberProvisionRequest(BaseModel):
    """Provision an existing phone_numbers row that has no LiveKit IDs yet
    (typically a manually-added row from Phase 3.2 or a backfilled row).
    Requires either the Twilio IncomingPhoneNumber SID in the DB row, or
    one passed explicitly here."""
    incoming_phone_number_sid: str | None = None
    agent_id: str | None = None
    label: str | None = None


@app.get("/admin/phone-numbers", tags=["admin"])
async def list_phone_numbers(
    agent_id: str | None = None,
    client_id: str | None = None,
    is_active: bool | None = None,
    _admin: dict = Depends(_get_admin_from_token),
):
    """List all provisioned phone numbers, joined with the assigned agent's
    name and the client's name for display. Used by /admin/phone-numbers."""
    db = get_supabase()
    q = db.table("phone_numbers").select(
        "*, agents(name, is_active), clients(name)"
    ).order("created_at", desc=True)
    if agent_id:
        q = q.eq("agent_id", agent_id)
    if client_id:
        q = q.eq("client_id", client_id)
    if is_active is not None:
        q = q.eq("is_active", is_active)
    rows = q.execute().data or []
    return rows


@app.post("/admin/phone-numbers", status_code=201, tags=["admin"])
async def create_phone_number(
    body: PhoneNumberCreate,
    _admin: dict = Depends(_get_admin_from_token),
):
    """Add a phone number to the catalog.

    Phase 3.2 only supports **manual** entry (the admin already bought the
    number in Twilio console and is registering it here). The `provider_sid`
    is optional — if you have it, we store it so future release flows know
    which Twilio resource to call.

    Future enhancement: when ready, we'll add a `provision` flag that calls
    Twilio's `IncomingPhoneNumbers.json` to buy a number and write the SID
    here in one transaction. Until then, purchase in Twilio console, then
    register here.
    """
    import re
    cleaned = (body.number or "").strip()
    if not re.match(r"^\+[1-9]\d{6,14}$", cleaned):
        raise HTTPException(status_code=400, detail="number must be E.164 (e.g. +5072023503)")
    if body.provider not in ("twilio_pa", "twilio_us", "manual"):
        raise HTTPException(status_code=400, detail="provider must be twilio_pa | twilio_us | manual")

    db = get_supabase()
    # Validate FK references if provided — the DB will check too, but a clean
    # 404 message beats a generic FK violation.
    if body.agent_id:
        a = db.table("agents").select("id").eq("id", body.agent_id).execute()
        if not a.data:
            raise HTTPException(status_code=404, detail="Agent not found")
    if body.client_id:
        c = db.table("clients").select("id").eq("id", body.client_id).execute()
        if not c.data:
            raise HTTPException(status_code=404, detail="Client not found")

    row = db.table("phone_numbers").insert({
        "number": cleaned,
        "label": (body.label or "").strip() or None,
        "provider": body.provider,
        "provider_sid": body.provider_sid,
        "capabilities": body.capabilities or {},
        "agent_id": body.agent_id,
        "client_id": body.client_id,
    }).execute()
    if not row.data:
        raise HTTPException(status_code=500, detail="Insert returned no row")
    return row.data[0]


@app.patch("/admin/phone-numbers/{number_id}", tags=["admin"])
async def update_phone_number(
    number_id: str,
    body: PhoneNumberUpdate,
    _admin: dict = Depends(_get_admin_from_token),
):
    """Update mutable fields on a phone number. Pass `agent_id: null` to
    unassign the agent; same for `client_id`. Used by the assignment
    dropdowns on /admin/phone-numbers.

    When the row has a LiveKit dispatch rule and the `agent_id` or `label`
    changes, we also live-update the rule's metadata so the next inbound
    call routes to the new agent without manual reprovisioning."""
    db = get_supabase()
    existing = db.table("phone_numbers").select(
        "id,number,lk_dispatch_rule_id,label"
    ).eq("id", number_id).execute()
    if not existing.data:
        raise HTTPException(status_code=404, detail="Phone number not found")
    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    if "agent_id" in updates and updates["agent_id"]:
        a = db.table("agents").select("id").eq("id", updates["agent_id"]).execute()
        if not a.data:
            raise HTTPException(status_code=404, detail="Agent not found")
    if "client_id" in updates and updates["client_id"]:
        c = db.table("clients").select("id").eq("id", updates["client_id"]).execute()
        if not c.data:
            raise HTTPException(status_code=404, detail="Client not found")
    row = db.table("phone_numbers").update(updates).eq("id", number_id).execute()

    # Live-update LiveKit dispatch rule if this row is provisioned and either
    # agent_id or label changed. Only do this on the canonical LiveKit field
    # (agent_id), not client_id, since the dispatch rule only cares about agent.
    rule_id = existing.data[0].get("lk_dispatch_rule_id")
    agent_changed = "agent_id" in updates
    label_changed = "label" in updates and updates["label"] is not None
    if rule_id and (agent_changed or label_changed):
        try:
            new_label = (
                f"Dispatch {updates['label'] or existing.data[0]['number']}"
                if label_changed else None
            )
            await _update_livekit_dispatch_agent(
                rule_id,
                updates.get("agent_id") if agent_changed else None,
                label=new_label,
            )
        except Exception as e:
            # The DB row updated — surface the LiveKit error but don't roll back
            logger.warning(f"[phone-numbers] LiveKit dispatch rule update failed for {number_id}: {e}")

    return row.data[0] if row.data else {"status": "updated"}


@app.delete("/admin/phone-numbers/{number_id}", tags=["admin"])
async def delete_phone_number(
    number_id: str,
    _admin: dict = Depends(_get_admin_from_token),
):
    """Remove a phone number from the catalog.

    Phase 3.5: if the row has a LiveKit dispatch rule / inbound trunk, we
    release those resources first so re-importing the same number later
    doesn't fail with 'trunk already exists'. The number's Twilio
    Elastic SIP Trunk association is left untouched — that's a shared
    resource used by other imported numbers, and detaching it would
    require careful coordination (the number would briefly stop routing
    in Twilio). The number stays active in Twilio and remains
    re-importable through the dashboard.

    If a sip_trunks row references this number, the FK is ON DELETE SET
    NULL so the trunk keeps existing (we just lose the friendly label).
    """
    db = get_supabase()
    existing = db.table("phone_numbers").select(
        "id,number,provider_sid,lk_inbound_trunk_id,lk_dispatch_rule_id"
    ).eq("id", number_id).execute()
    if not existing.data:
        raise HTTPException(status_code=404, detail="Phone number not found")
    row = existing.data[0]

    released = await _release_livekit_number(
        row.get("lk_dispatch_rule_id"),
        row.get("lk_inbound_trunk_id"),
    )

    db.table("phone_numbers").delete().eq("id", number_id).execute()
    return {
        "status": "deleted",
        "phone_number_id": number_id,
        "livekit_released": released,
        "twilio_trunk_kept": True,
    }


@app.post("/admin/phone-numbers/search", tags=["admin"])
async def search_phone_numbers(
    body: PhoneNumberSearchRequest,
    _admin: dict = Depends(_get_admin_from_token),
):
    """Search Twilio's AvailablePhoneNumbers API for numbers that match the
    criteria. Returns a small array of candidates the admin can preview
    before buying. Phase 3.2: only queries the default `twilio_us` account —
    we extend to `_PA` once we add the credentials-handling layer."""
    import httpx

    accounts = _get_twilio_accounts()
    if not accounts:
        raise HTTPException(
            status_code=503,
            detail="Twilio not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN missing)",
        )
    # Prefer US account for now.
    account_sid, auth_token = accounts[-1]

    url = f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}/AvailablePhoneNumbers/{body.country.upper()}/{body.type}.json"
    params: list[tuple[str, str]] = [("PageSize", str(body.page_size))]
    if body.contains:
        params.append(("Contains", body.contains))

    try:
        async with httpx.AsyncClient(auth=(account_sid, auth_token), timeout=15) as hclient:
            resp = await hclient.get(url, params=params)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Twilio request failed: {e}")

    if resp.status_code != 200:
        raise HTTPException(
            status_code=resp.status_code,
            detail=f"Twilio error: {resp.text[:300]}",
        )
    data = resp.json() or {}
    numbers = data.get("available_phone_numbers", []) or []
    return [
        {
            "phone_number": n.get("phone_number"),
            "friendly_name": n.get("friendly_name"),
            "lata": n.get("lata"),
            "rate_center": n.get("rate_center"),
            "locality": (n.get("locality") or ""),
            "region": (n.get("region") or ""),
            "capabilities": n.get("capabilities") or {},
            "iso_country": n.get("iso_country"),
        }
        for n in numbers
    ]


@app.get("/admin/phone-numbers/owned", tags=["admin"])
async def list_owned_phone_numbers(
    provider: str = "twilio_us",
    exclude_existing: bool = True,
    _admin: dict = Depends(_get_admin_from_token),
):
    """List phone numbers already owned in the given Twilio account. Powers
    the dashboard's 'Importar desde Twilio' modal: shows what's in Twilio
    but not yet in our catalog so the admin can pick what to wire up.

    When `exclude_existing=true` (default) we cross-reference the local
    `phone_numbers` table by E.164 and mark numbers already known to us,
    so the modal can hide them from the picker."""
    raw_numbers = await _list_owned_twilio_numbers(provider)

    known_numbers: set[str] = set()
    if exclude_existing:
        rows = get_supabase().table("phone_numbers").select("number").execute().data or []
        known_numbers = {(r.get("number") or "").strip() for r in rows}

    out = []
    for n in raw_numbers:
        e164 = n.get("phone_number") or ""
        out.append({
            "incoming_phone_number_sid": n.get("sid"),
            "phone_number": e164,
            "friendly_name": n.get("friendly_name"),
            "capabilities": n.get("capabilities") or {},
            "voice_url": n.get("voice_url"),
            "date_created": n.get("date_created"),
            "iso_country": n.get("iso_country"),
            "locality": n.get("locality"),
            "region": n.get("region"),
            "already_imported": bool(exclude_existing and e164 in known_numbers),
        })
    return out


@app.post("/admin/phone-numbers/import", status_code=201, tags=["admin"])
async def import_phone_number(
    body: PhoneNumberImportRequest,
    _admin: dict = Depends(_get_admin_from_token),
):
    """Import a Twilio-owned phone number into the platform end-to-end:

    1. Verify the number exists in the Twilio account (IncomingPhoneNumber SID).
    2. Find or create the shared Twilio Elastic SIP Trunk that points to our
       LiveKit SIP server (idempotent — same trunk for all imported numbers).
    3. Attach the number to that trunk (idempotent — re-imports no-op).
    4. Create a LiveKit SipInboundTrunk bound to the number (with Twilio
       egress IPs allowed).
    5. Create a LiveKit SipDispatchRule that routes inbound calls to the
       `voice-agent` worker, passing `agent_id` in room metadata.
    6. Insert a `phone_numbers` row with all the LiveKit / Twilio IDs.

    If steps 4-5 fail mid-flow, we roll back the inbound trunk so we don't
    leave orphans. If step 6 fails, both LiveKit resources are released
    (the Twilio attach is kept — re-imports detect it as already attached)."""
    if body.provider not in TWILIO_PROVIDER_TO_SUFFIX:
        raise HTTPException(status_code=400, detail=f"provider must be one of {list(TWILIO_PROVIDER_TO_SUFFIX)}")
    if body.agent_id:
        a = get_supabase().table("agents").select("id").eq("id", body.agent_id).execute()
        if not a.data:
            raise HTTPException(status_code=404, detail="Agent not found")

    # 1. Resolve E.164 + capabilities from Twilio
    account_sid, _, _ = _twilio_account_for(body.provider)
    try:
        data = await _twilio_request(
            "GET",
            f"/2010-04-01/Accounts/{account_sid}/IncomingPhoneNumbers/{body.incoming_phone_number_sid}.json",
            provider=body.provider,
        )
    except HTTPException as e:
        if e.status_code == 404:
            raise HTTPException(status_code=404, detail="Twilio IncomingPhoneNumber not found in this account")
        raise
    if not isinstance(data, dict):
        raise HTTPException(status_code=502, detail=f"Twilio lookup returned unexpected payload: {data}")
    e164 = (data.get("phone_number") or "").strip()
    if not e164:
        raise HTTPException(status_code=502, detail="Twilio record has no phone_number")
    capabilities = data.get("capabilities") or {}
    friendly_name = data.get("friendly_name") or e164

    db = get_supabase()

    # Conflict if already in catalog
    existing = db.table("phone_numbers").select("id").eq("number", e164).execute()
    if existing.data:
        raise HTTPException(status_code=409, detail=f"Number {e164} is already in the catalog")

    # 2. Ensure shared Twilio Elastic SIP Trunk exists
    trunk_sid = await _ensure_twilio_elastic_trunk(body.provider)

    # 3. Attach number to trunk (idempotent)
    await _attach_twilio_number_to_trunk(body.provider, body.incoming_phone_number_sid, trunk_sid)

    # 4 + 5. LiveKit inbound trunk + dispatch rule (with rollback on failure)
    label = body.label or friendly_name
    try:
        inbound_id, dispatch_id = await _create_livekit_inbound_and_dispatch(
            e164, body.agent_id, label,
        )
    except Exception as e:
        logger.error(f"[phone-import] LiveKit provisioning failed for {e164}: {e}")
        raise HTTPException(status_code=502, detail=f"LiveKit provisioning failed: {e}")

    # 6. Insert phone_numbers row. If this fails, release LiveKit resources
    # (but keep Twilio attach — re-imports will detect it as already done).
    try:
        row = db.table("phone_numbers").insert({
            "number": e164,
            "label": label,
            "provider": body.provider,
            "provider_sid": body.incoming_phone_number_sid,
            "capabilities": capabilities,
            "agent_id": body.agent_id,
            "twilio_trunk_sid": trunk_sid,
            "lk_inbound_trunk_id": inbound_id,
            "lk_dispatch_rule_id": dispatch_id,
        }).execute()
    except Exception as e:
        logger.error(f"[phone-import] DB insert failed for {e164} — rolling back LiveKit: {e}")
        await _release_livekit_number(dispatch_id, inbound_id)
        raise HTTPException(status_code=500, detail=f"DB insert failed: {e}")

    if not row.data:
        await _release_livekit_number(dispatch_id, inbound_id)
        raise HTTPException(status_code=500, detail="Insert returned no row")

    return {
        "status": "imported",
        "phone_number": row.data[0],
        "twilio_trunk_sid": trunk_sid,
        "lk_inbound_trunk_id": inbound_id,
        "lk_dispatch_rule_id": dispatch_id,
    }


@app.post("/admin/phone-numbers/{number_id}/provision", tags=["admin"])
async def provision_phone_number(
    number_id: str,
    body: PhoneNumberProvisionRequest | None = None,
    _admin: dict = Depends(_get_admin_from_token),
):
    """Provision an existing phone_numbers row that has no LiveKit IDs yet
    (typically a manually-added row or a backfill from Phase 3.2). Idempotent
    on the Twilio side; refuses if the row already has a dispatch rule.

    Body fields are optional — if `agent_id` is omitted, the row's current
    `agent_id` is used; same for `label`. `incoming_phone_number_sid`
    overrides the row's `provider_sid` if both are present (useful when the
    manual row was created without one)."""
    body = body or PhoneNumberProvisionRequest()
    db = get_supabase()
    existing = db.table("phone_numbers").select(
        "id,number,provider,provider_sid,agent_id,label,lk_dispatch_rule_id,lk_inbound_trunk_id"
    ).eq("id", number_id).execute()
    if not existing.data:
        raise HTTPException(status_code=404, detail="Phone number not found")
    row = existing.data[0]

    if row.get("lk_dispatch_rule_id"):
        raise HTTPException(status_code=409, detail="Number is already provisioned")

    provider = row.get("provider") or "twilio_us"
    if provider not in TWILIO_PROVIDER_TO_SUFFIX:
        raise HTTPException(
            status_code=400,
            detail=f"provider {provider!r} cannot be auto-provisioned (only twilio_us | twilio_pa)",
        )

    phone_sid = body.incoming_phone_number_sid or row.get("provider_sid")
    if not phone_sid:
        # Try to look it up by E.164 from Twilio
        twilio_lookup = await _lookup_twilio_phone_by_number(provider, row["number"])
        if not twilio_lookup:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Row has no provider_sid and the number wasn't found in Twilio. "
                    "Pass incoming_phone_number_sid explicitly, or buy the number first."
                ),
            )
        phone_sid = twilio_lookup["sid"]

    agent_id = body.agent_id if body.agent_id is not None else row.get("agent_id")
    if agent_id:
        a = db.table("agents").select("id").eq("id", agent_id).execute()
        if not a.data:
            raise HTTPException(status_code=404, detail="Agent not found")

    label = body.label or row.get("label") or row["number"]

    # Twilio side: ensure shared trunk + attach number (idempotent)
    trunk_sid = await _ensure_twilio_elastic_trunk(provider)
    await _attach_twilio_number_to_trunk(provider, phone_sid, trunk_sid)

    # LiveKit side: inbound + dispatch (with rollback on partial failure)
    try:
        inbound_id, dispatch_id = await _create_livekit_inbound_and_dispatch(
            row["number"], agent_id, label,
        )
    except Exception as e:
        logger.error(f"[phone-provision] LiveKit provisioning failed for {row['number']}: {e}")
        raise HTTPException(status_code=502, detail=f"LiveKit provisioning failed: {e}")

    # Update DB row with all the IDs (plus the looked-up sid if we didn't have one)
    try:
        updated = db.table("phone_numbers").update({
            "provider_sid": phone_sid,
            "twilio_trunk_sid": trunk_sid,
            "lk_inbound_trunk_id": inbound_id,
            "lk_dispatch_rule_id": dispatch_id,
            "agent_id": agent_id,
        }).eq("id", number_id).execute()
    except Exception as e:
        logger.error(f"[phone-provision] DB update failed for {number_id} — rolling back LiveKit: {e}")
        await _release_livekit_number(dispatch_id, inbound_id)
        raise HTTPException(status_code=500, detail=f"DB update failed: {e}")

    return {
        "status": "provisioned",
        "phone_number": updated.data[0] if updated.data else None,
        "twilio_trunk_sid": trunk_sid,
        "lk_inbound_trunk_id": inbound_id,
        "lk_dispatch_rule_id": dispatch_id,
    }


@app.post("/admin/sip-trunks", status_code=201, tags=["admin"])
async def create_sip_trunk(body: SipTrunkCreate, _admin: dict = Depends(_get_admin_from_token)):
    """
    Register a client's SIP trunk in LiveKit and store the resulting IDs.
    Optionally creates an inbound dispatch rule so the client's number routes
    to the assigned agent.
    """
    from livekit import api as lk_api

    lkapi = lk_api.LiveKitAPI(
        url=os.getenv("LIVEKIT_URL", "ws://localhost:7880"),
        api_key=LIVEKIT_API_KEY,
        api_secret=LIVEKIT_API_SECRET,
    )

    # 1. Create outbound trunk in LiveKit
    try:
        trunk_resp = await lkapi.sip.create_sip_outbound_trunk(
            lk_api.CreateSIPOutboundTrunkRequest(
                trunk=lk_api.SIPOutboundTrunkInfo(
                    name=body.name,
                    address=body.sip_server,
                    numbers=[body.phone_number],
                    auth_username=body.sip_username,
                    auth_password=body.sip_password,
                )
            )
        )
        lk_trunk_id = trunk_resp.sip_trunk_id
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LiveKit trunk creation failed: {e}")

    # 2. Optionally create an inbound trunk + dispatch rule so the client's
    # number routes incoming calls to the assigned agent. LiveKit matches
    # inbound calls against *inbound* trunks (by number), not the outbound
    # trunk created above — so a separate inbound trunk is required here.
    lk_inbound_trunk_id = None
    lk_dispatch_rule_id = None
    if body.inbound_enabled and body.agent_id:
        try:
            inbound_resp = await lkapi.sip.create_sip_inbound_trunk(
                lk_api.CreateSIPInboundTrunkRequest(
                    trunk=lk_api.SIPInboundTrunkInfo(
                        name=f"{body.name} Inbound",
                        numbers=[body.phone_number],
                    )
                )
            )
            lk_inbound_trunk_id = inbound_resp.sip_trunk_id

            rule_resp = await lkapi.sip.create_sip_dispatch_rule(
                lk_api.CreateSIPDispatchRuleRequest(
                    rule=lk_api.SIPDispatchRule(
                        dispatch_rule_individual=lk_api.SIPDispatchRuleIndividual(
                            room_prefix="call-",
                        ),
                    ),
                    trunk_ids=[lk_inbound_trunk_id],
                    room_config=lk_api.RoomConfiguration(
                        agents=[lk_api.RoomAgentDispatch(
                            agent_name="voice-agent",
                            metadata=json.dumps({"agent_id": body.agent_id}),
                        )]
                    ),
                    name=f"BYOC Dispatch - {body.name}",
                )
            )
            lk_dispatch_rule_id = rule_resp.sip_dispatch_rule_id
        except Exception as e:
            # Outbound trunk created but inbound trunk/dispatch rule failed — still save what we have
            logger.warning(f"[sip-trunks] Inbound trunk/dispatch rule creation failed (outbound trunk OK): {e}")

    # 3. Save to DB
    db = get_supabase()
    row = db.table("sip_trunks").insert({
        "name": body.name,
        "client_name": body.client_name,
        "sip_server": body.sip_server,
        "sip_username": body.sip_username,
        "sip_password": body.sip_password,  # TODO: encrypt in production
        "phone_number": body.phone_number,
        "lk_trunk_id": lk_trunk_id,
        "lk_inbound_trunk_id": lk_inbound_trunk_id,
        "lk_dispatch_rule_id": lk_dispatch_rule_id,
        "inbound_enabled": body.inbound_enabled,
        "agent_id": body.agent_id,
    }).execute()
    return row.data[0]


@app.patch("/admin/sip-trunks/{trunk_id}", tags=["admin"])
async def update_sip_trunk(trunk_id: str, body: SipTrunkUpdate, _admin: dict = Depends(_get_admin_from_token)):
    """Update metadata for a BYOC SIP trunk (name, assigned agent, active status)."""
    db = get_supabase()
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    row = db.table("sip_trunks").update(updates).eq("id", trunk_id).execute()
    if not row.data:
        raise HTTPException(status_code=404, detail="SIP trunk not found")
    return row.data[0]


@app.delete("/admin/sip-trunks/{trunk_id}", tags=["admin"])
async def delete_sip_trunk(trunk_id: str, _admin: dict = Depends(_get_admin_from_token)):
    """Delete a BYOC SIP trunk from LiveKit and the database."""
    from livekit import api as lk_api

    db = get_supabase()
    row = db.table("sip_trunks").select("lk_trunk_id,lk_inbound_trunk_id,lk_dispatch_rule_id").eq("id", trunk_id).maybe_single().execute()
    if not row.data:
        raise HTTPException(status_code=404, detail="SIP trunk not found")

    lkapi = lk_api.LiveKitAPI(
        url=os.getenv("LIVEKIT_URL", "ws://localhost:7880"),
        api_key=LIVEKIT_API_KEY,
        api_secret=LIVEKIT_API_SECRET,
    )

    # Delete dispatch rule first (if any)
    if rule_id := row.data.get("lk_dispatch_rule_id"):
        try:
            await lkapi.sip.delete_sip_dispatch_rule(
                lk_api.DeleteSIPDispatchRuleRequest(sip_dispatch_rule_id=rule_id)
            )
        except Exception as e:
            logger.warning(f"[sip-trunks] Could not delete dispatch rule {rule_id}: {e}")

    # Delete outbound trunk
    if lk_id := row.data.get("lk_trunk_id"):
        try:
            await lkapi.sip.delete_sip_outbound_trunk(
                lk_api.DeleteSIPOutboundTrunkRequest(sip_trunk_id=lk_id)
            )
        except Exception as e:
            logger.warning(f"[sip-trunks] Could not delete LiveKit outbound trunk {lk_id}: {e}")

    # Delete inbound trunk (if any)
    if lk_in_id := row.data.get("lk_inbound_trunk_id"):
        try:
            await lkapi.sip.delete_sip_trunk(
                lk_api.DeleteSIPTrunkRequest(sip_trunk_id=lk_in_id)
            )
        except Exception as e:
            logger.warning(f"[sip-trunks] Could not delete LiveKit inbound trunk {lk_in_id}: {e}")

    db.table("sip_trunks").delete().eq("id", trunk_id).execute()
    return {"status": "deleted"}


# ── Voice catalogs (admin) ────────────────────────────────────────────────────
# Fetch the live voice catalog from each TTS provider so the agent builder's
# "Modelo y voz" tab can show a `<select>` with real names + preview buttons
# instead of a free-text Voice ID input. Keys live in .env (server-side only)
# and are never exposed to the browser.

class VoiceOption(BaseModel):
    id: str
    name: str
    description: str | None = None
    preview_url: str | None = None
    language: str | None = None
    gender: str | None = None
    tags: list[str] = []


@app.get("/admin/voices/elevenlabs", tags=["admin"])
async def list_elevenlabs_voices(
    _admin: dict = Depends(_get_admin_from_token),
    search: str | None = None,
):
    """List ElevenLabs voices (premade + workspace) for the configured key.

    Returns a normalized list of {id, name, description, preview_url, language,
    gender, tags}. `voice_type=non-community` excludes community voices so the
    catalog stays compact and within the workspace's permissions.
    """
    api_key = os.getenv("ELEVEN_API_KEY", "")
    if not api_key:
        raise HTTPException(status_code=503, detail="ELEVEN_API_KEY not configured")
    import httpx

    params: dict = {"page_size": 100, "voice_type": "non-community"}
    if search:
        params["search"] = search
    async with httpx.AsyncClient(timeout=10) as h:
        resp = await h.get(
            "https://api.elevenlabs.io/v2/voices",
            headers={"xi-api-key": api_key},
            params=params,
        )
    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"ElevenLabs error {resp.status_code}: {resp.text[:200]}",
        )
    data = resp.json()
    voices: list[dict] = []
    for v in data.get("voices", []):
        labels = v.get("labels") or {}
        verified = v.get("verified_languages") or []
        voices.append({
            "id": v["voice_id"],
            "name": v.get("name") or v["voice_id"],
            "description": v.get("description"),
            "preview_url": v.get("preview_url"),
            "language": labels.get("language") or (verified[0].get("language") if verified else None),
            "gender": labels.get("gender"),
            "tags": [v.get("category")] if v.get("category") else [],
        })
    return voices


@app.get("/admin/voices/inworld", tags=["admin"])
async def list_inworld_voices(
    _admin: dict = Depends(_get_admin_from_token),
    language: str = "es",
):
    """List Inworld TTS voices for the given language (default 'es').

    Inworld does not expose pre-recorded preview URLs, so `preview_url` is
    always null for these — the UI calls `/admin/voices/inworld/preview` to
    synthesize a sample on demand.
    """
    api_key = os.getenv("INWORLD_API_KEY", "")
    if not api_key:
        raise HTTPException(status_code=503, detail="INWORLD_API_KEY not configured")
    import httpx

    async with httpx.AsyncClient(timeout=10) as h:
        resp = await h.get(
            "https://api.inworld.ai/tts/v1/voices",
            headers={"Authorization": f"Basic {api_key}"},
            params={"filter": f"language={language}"},
        )
    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Inworld error {resp.status_code}: {resp.text[:200]}",
        )
    data = resp.json()
    voices: list[dict] = []
    for v in data.get("voices", []):
        langs = v.get("languages") or [None]
        voices.append({
            "id": v["voiceId"],
            "name": v.get("displayName") or v["voiceId"],
            "description": v.get("description"),
            "preview_url": None,
            "language": langs[0],
            "gender": None,
            "tags": v.get("tags") or [],
        })
    return voices


@app.post("/admin/voices/inworld/preview", tags=["admin"])
async def preview_inworld_voice(
    body: dict,
    _admin: dict = Depends(_get_admin_from_token),
):
    """Synthesize a short audio sample for an Inworld voice (preview button).

    Tries the streaming endpoint first; falls back to the unary endpoint and
    to decoding a JSON envelope containing base64 audio, since Inworld has
    historically returned the same data in all three shapes depending on
    account/version. Any non-2xx response surfaces a 502 with the upstream
    error body truncated to 200 chars.
    """
    api_key = os.getenv("INWORLD_API_KEY", "")
    if not api_key:
        raise HTTPException(status_code=503, detail="INWORLD_API_KEY not configured")
    voice_id = (body or {}).get("voice_id", "")
    if not voice_id:
        raise HTTPException(status_code=400, detail="voice_id required")
    text = (body or {}).get("text") or "Hola, esta es una muestra de mi voz."
    model_id = (body or {}).get("model_id") or "inworld-tts-1"

    import httpx
    from fastapi.responses import StreamingResponse

    payload = {
        "voiceId": voice_id,
        "modelId": model_id,
        "text": text,
        "audioConfig": {"audioEncoding": "MP3", "sampleRateHertz": 24000},
    }
    headers = {
        "Authorization": f"Basic {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    endpoints = [
        "https://api.inworld.ai/tts/v1/voice:stream",
        "https://api.inworld.ai/tts/v1/voice: synth",
        "https://api.inworld.ai/v1/voice:synthesize",
    ]
    last_err: str = ""
    async with httpx.AsyncClient(timeout=20) as h:
        for url in endpoints:
            try:
                resp = await h.post(url, headers=headers, json=payload)
            except Exception as e:
                last_err = f"{url}: {e}"
                continue
            if resp.status_code == 200:
                audio_bytes = _extract_inworld_audio(resp)
                if audio_bytes:
                    return StreamingResponse(
                        iter([audio_bytes]),
                        media_type="audio/mpeg",
                        headers={"Cache-Control": "no-store"},
                    )
                last_err = f"{url}: 200 but no audio in body"
            else:
                last_err = f"{url}: {resp.status_code} {resp.text[:120]}"
    raise HTTPException(status_code=502, detail=f"Inworld synthesize failed: {last_err}")


def _extract_inworld_audio(resp: object) -> bytes | None:
    """Pull MP3 bytes out of an Inworld response regardless of envelope shape.

    Inworld's `:stream` endpoint returns NDJSON: multiple JSON objects
    concatenated together, each with `{"result": {"audioContent": "<base64>",
    "usage": {...}}}`. The base64 chunks are sequential parts of a single MP3
    file and must be concatenated BEFORE base64-decoding — decoding each
    chunk independently produces an invalid file.

    Also handles:
    - Flat `{"audioContent": "..."}` (older / non-streaming endpoints)
    - Nested `{"result": {"audioContent": "..."}}` (single object)
    - Raw MP3 bytes (content-type audio/*, ID3 header, or \xff\xfb MP3 sync)
    """
    import base64

    content_type = (resp.headers.get("content-type") or "").lower()
    raw = resp.content or b""
    if "audio" in content_type or raw[:3] == b"ID3" or raw[:2] == b"\xff\xfb":
        return raw

    AUDIO_KEYS = ("audioContent", "audio", "audio_content", "audio_base64")

    # Try the body as a single JSON object first
    try:
        envelope = resp.json()
    except Exception:
        envelope = None

    if envelope is not None and isinstance(envelope, dict):
        # Look for a single audioContent in envelope / envelope.result
        candidates: list[dict] = [envelope]
        for wrapper_key in ("result", "data", "response"):
            wrapper = envelope.get(wrapper_key)
            if isinstance(wrapper, dict):
                candidates.append(wrapper)
        for c in candidates:
            for key in AUDIO_KEYS:
                val = c.get(key)
                if isinstance(val, str) and val and len(val) > 100:
                    try:
                        return base64.b64decode(val)
                    except Exception:
                        pass
        # Fall through to streaming parse if no single chunk found

    # Parse the body as concatenated JSON objects (NDJSON / streaming)
    try:
        text = raw.decode("utf-8", errors="replace")
    except Exception:
        return None
    decoder = json.JSONDecoder()
    idx = 0
    n = len(text)
    combined_b64: list[str] = []
    while idx < n:
        while idx < n and text[idx] in " \n\r\t":
            idx += 1
        if idx >= n:
            break
        try:
            obj, end = decoder.raw_decode(text, idx)
        except json.JSONDecodeError:
            break
        idx = end
        if not isinstance(obj, dict):
            continue
        # Look for audioContent in this chunk (envelope / envelope.result)
        candidates = [obj]
        for wrapper_key in ("result", "data", "response"):
            wrapper = obj.get(wrapper_key)
            if isinstance(wrapper, dict):
                candidates.append(wrapper)
        for c in candidates:
            for key in AUDIO_KEYS:
                val = c.get(key)
                if isinstance(val, str) and val:
                    combined_b64.append(val)
                    break
            else:
                continue
            break

    if not combined_b64:
        return None
    try:
        return base64.b64decode("".join(combined_b64))
    except Exception:
        return None


# ── Per-agent live test (Talk) ───────────────────────────────────────────────
# Lets an admin open a LiveKit room pre-dispatched with THIS specific agent's
# builder config (prompt/voice/model/tools/KB), and join it from the browser.
# Mirrors the dispatch pattern used by /calls/outbound and the batch dialer so
# the worker picks the agent up via job metadata.agent_id (see agent.py).

class TalkTokenResponse(BaseModel):
    token: str
    room_name: str
    identity: str
    livekit_url: str


@app.post("/admin/agents/{agent_id}/talk-token", response_model=TalkTokenResponse, tags=["admin"])
async def admin_create_talk_token(agent_id: str, _admin: dict = Depends(_get_admin_from_token)):
    """Create a LiveKit room pre-dispatched with the named agent and return a
    join token for the admin caller. Empty_timeout is short (5 min) since
    talk sessions are interactive; rooms auto-clean when the admin leaves.
    """
    db = get_supabase()
    agent = db.table("agents").select("id, name, lk_agent_name").eq("id", agent_id).single().execute()
    if not agent.data:
        raise HTTPException(status_code=404, detail="Agent not found")

    from livekit import api as lk_api

    room_name = f"talk-{uuid.uuid4().hex[:10]}"
    dispatch_metadata = json.dumps({"agent_id": agent_id})

    lkapi = lk_api.LiveKitAPI(
        url=os.getenv("LIVEKIT_URL", "ws://localhost:7880"),
        api_key=LIVEKIT_API_KEY,
        api_secret=LIVEKIT_API_SECRET,
    )
    try:
        await lkapi.room.create_room(
            lk_api.CreateRoomRequest(
                name=room_name,
                empty_timeout=300,
                agents=[lk_api.RoomAgentDispatch(
                    agent_name="voice-agent",
                    metadata=dispatch_metadata,
                )],
            )
        )
    except Exception as e:
        await lkapi.aclose()
        raise HTTPException(status_code=502, detail=f"LiveKit room create failed: {e}")

    admin_email = (_admin or {}).get("email", "admin")
    identity = f"admin-{admin_email.split('@')[0]}"
    token = (
        AccessToken(api_key=LIVEKIT_API_KEY, api_secret=LIVEKIT_API_SECRET)
        .with_identity(identity)
        .with_name(identity)
        .with_grants(
            VideoGrants(
                room_join=True,
                room=room_name,
                can_publish=True,
                can_subscribe=True,
            )
        )
        .to_jwt()
    )

    await lkapi.aclose()
    return TalkTokenResponse(
        token=token,
        room_name=room_name,
        identity=identity,
        livekit_url=os.getenv("LIVEKIT_PUBLIC_URL", "ws://44.247.225.191:7880"),
    )


# ── Duplicate agent ──────────────────────────────────────────────────────────
# Deep-copies an agent (config + tools + knowledge) into a new row owned by
# the same client. Version history is intentionally NOT copied — the new
# agent starts with a clean version log so the rollback feature has nothing
# stale to suggest.

@app.post("/admin/agents/{agent_id}/duplicate", status_code=201, tags=["admin"])
async def admin_duplicate_agent(agent_id: str, _admin: dict = Depends(_get_admin_from_token)):
    db = get_supabase()
    original = db.table("agents").select("*").eq("id", agent_id).single().execute()
    if not original.data:
        raise HTTPException(status_code=404, detail="Agent not found")
    src = original.data

    DUPLICATABLE_FIELDS = (
        "client_id", "description", "system_prompt", "greeting",
        "voice_id", "llm_model", "stt_model", "tts_model",
        "stt_provider", "tts_provider", "temperature", "language",
        "idle_timeout_seconds", "idle_message", "lk_agent_name",
        "tts_speed", "tts_temperature", "tts_text_normalization",
        "tts_delivery_mode", "tts_buffer_char_threshold", "tts_max_buffer_delay_ms",
    )
    new_row = {f: src.get(f) for f in DUPLICATABLE_FIELDS}
    new_row["name"] = f"{src.get('name', 'Agente')} (Copia)"
    new_row["is_active"] = False

    insert = db.table("agents").insert(new_row).execute()
    if not insert.data:
        raise HTTPException(status_code=500, detail="Failed to create duplicated agent")
    new_agent = insert.data[0]

    # Copy agent_tools (skip IDs; keep config + key/label/type verbatim)
    tools = (
        db.table("agent_tools")
        .select("key,label,description,tool_type,enabled,config")
        .eq("agent_id", agent_id)
        .execute()
    )
    if tools.data:
        try:
            db.table("agent_tools").insert([
                {**t, "agent_id": new_agent["id"]} for t in tools.data
            ]).execute()
        except Exception as e:
            logger.warning(f"[duplicate] tools copy failed for {new_agent['id']}: {e}")

    # Copy agent_knowledge (skip IDs; keep title + content)
    knowledge = (
        db.table("agent_knowledge")
        .select("title,content")
        .eq("agent_id", agent_id)
        .execute()
    )
    if knowledge.data:
        try:
            db.table("agent_knowledge").insert([
                {**k, "agent_id": new_agent["id"]} for k in knowledge.data
            ]).execute()
        except Exception as e:
            logger.warning(f"[duplicate] knowledge copy failed for {new_agent['id']}: {e}")

    logger.info(f"[duplicate] Agent {agent_id} → {new_agent['id']} (by {_admin.get('email')})")
    return new_agent


# ── Per-agent call log ───────────────────────────────────────────────────────

@app.get("/admin/agents/{agent_id}/calls", tags=["admin"])
async def admin_list_agent_calls(
    agent_id: str,
    limit: int = 50,
    _admin: dict = Depends(_get_admin_from_token),
):
    """Calls (sessions) belonging to a single agent — same shape as /calls,
    filtered by sessions.agent_id. Drives the per-agent Call Logs drawer."""
    db = get_supabase()
    rows = (
        db.table("sessions")
        .select(_CALL_LOG_SELECT)
        .eq("agent_id", agent_id)
        .order("started_at", desc=True)
        .limit(limit)
        .execute()
        .data or []
    )
    phone_lookup = _phone_lookup_for_rooms(db, [r.get("room_name") for r in rows])
    return [_session_to_call_row(s, phone_lookup) for s in rows]


@app.get("/admin/agents", tags=["admin"])
async def admin_list_agents(_admin: dict = Depends(_get_admin_from_token)):
    """List all agents with their associated client info."""
    db = get_supabase()
    result = (
        db.table("agents")
        .select("*, clients(id,name,email)")
        .order("created_at", desc=True)
        .execute()
    )
    return result.data


@app.get("/admin/agents/{agent_id}", tags=["admin"])
async def admin_get_agent(agent_id: str, _admin: dict = Depends(_get_admin_from_token)):
    """Fetch a single agent with full builder config: client, tools, knowledge, version count."""
    db = get_supabase()
    agent = db.table("agents").select("*, clients(id,name,email)").eq("id", agent_id).single().execute()
    if not agent.data:
        raise HTTPException(status_code=404, detail="Agent not found")
    tools = db.table("agent_tools").select("*").eq("agent_id", agent_id).order("created_at").execute()
    knowledge = db.table("agent_knowledge").select("*").eq("agent_id", agent_id).order("created_at").execute()
    versions = (
        db.table("agent_versions")
        .select("version_number", count="exact")
        .eq("agent_id", agent_id)
        .execute()
    )
    return {
        **agent.data,
        "tools": tools.data,
        "knowledge": knowledge.data,
        "version_count": versions.count or 0,
    }


@app.post("/admin/agents", status_code=201, tags=["admin"])
async def admin_create_agent(body: AgentCreate, _admin: dict = Depends(_get_admin_from_token)):
    """Create a new agent. `client_id` is OPTIONAL — unassigned agents
    ('orphans') are useful for solo/test/shared agents that don't belong
    to a specific tenant. All transport fields default to the platform
    defaults (Deepgram STT + ElevenLabs TTS + gpt-4o) when omitted, so
    the DB NOT NULL constraints are always satisfied."""
    db = get_supabase()
    if body.client_id:
        # S5.3 — `.maybe_single()` returns None on no-rows instead of raising
        # APIError like `.single()` does. The previous code was unreachable on
        # the 404 path: supabase raised before we could check `not client.data`,
        # so callers saw a 500. `.maybe_single()` lets the explicit 404 fire —
        # but it returns None (not a SingleAPIResponse) when no rows, so we
        # must handle that explicitly.
        client = db.table("clients").select("id").eq("id", body.client_id).maybe_single().execute()
        if client is None or not client.data:
            raise HTTPException(status_code=404, detail="Client not found")
    # Defaults match services/agent/src/agent.py:_default_agent_config so a
    # minimal POST body produces a fully-runnable agent.
    result = db.table("agents").insert({
        "client_id": body.client_id,
        "name": body.name,
        "voice_id": body.voice_id,
        "lk_agent_name": body.lk_agent_name,
        "tts_speed": body.tts_speed if body.tts_speed is not None else 1.1,
        "llm_model": body.llm_model or "gpt-4o",
        "stt_provider": body.stt_provider or "deepgram",
        "tts_provider": body.tts_provider or "elevenlabs",
        "stt_model": body.stt_model or "nova-3",
        "tts_model": body.tts_model or "eleven_turbo_v2_5",
        "language": body.language or "es",
        "temperature": body.temperature if body.temperature is not None else 0.7,
        "tts_temperature": body.tts_temperature,
        "tts_text_normalization": body.tts_text_normalization,
        "tts_delivery_mode": body.tts_delivery_mode,
        "tts_buffer_char_threshold": body.tts_buffer_char_threshold,
        "tts_max_buffer_delay_ms": body.tts_max_buffer_delay_ms,
    }).execute()
    return result.data[0] 


@app.patch("/admin/agents/{agent_id}", tags=["admin"])
async def admin_update_agent(agent_id: str, body: AgentUpdate, _admin: dict = Depends(_get_admin_from_token)):
    """Update an agent's configuration. Snapshots the prior config to agent_versions
    whenever a builder field (prompt, voice, models, etc.) changes."""
    db = get_supabase()
    updates = body.model_dump(exclude_unset=True)
    note = updates.pop("note", None)
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    current = db.table("agents").select("*").eq("id", agent_id).single().execute()
    if not current.data:
        raise HTTPException(status_code=404, detail="Agent not found")

    # client_id reassignment validation. Skip the snapshot for this field —
    # it's an admin/relationship change, not a config change.
    if "client_id" in updates:
        new_client_id = updates["client_id"]
        if new_client_id is not None:
            target = (
                db.table("clients").select("id").eq("id", new_client_id).single().execute()
            )
            if not target.data:
                raise HTTPException(status_code=404, detail="Target client not found")
        # Block if the agent has live sessions — would orphan the running call.
        live = (
            db.table("sessions")
            .select("id")
            .eq("agent_id", agent_id)
            .is_("ended_at", "null")
            .limit(1)
            .execute()
        )
        if live.data:
            raise HTTPException(
                status_code=409,
                detail="Cannot reassign agent with active sessions — wait for calls to end",
            )

    config_changed = any(field in updates for field in AGENT_CONFIG_FIELDS)
    if config_changed:
        _snapshot_agent_version(db, current.data, note, _admin.get("id"))

    result = db.table("agents").update(updates).eq("id", agent_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Agent not found")
    return result.data[0]


@app.delete("/admin/agents/{agent_id}", tags=["admin"])
async def admin_delete_agent(agent_id: str, _admin: dict = Depends(_get_admin_from_token)):
    """Delete an agent (only if it has no campaigns)."""
    db = get_supabase()
    campaigns = (
        db.table("campaigns")
        .select("id")
        .eq("agent_id", agent_id)
        .limit(1)
        .execute()
    )
    if campaigns.data:
        raise HTTPException(
            status_code=400,
            detail="Cannot delete agent with existing campaigns",
        )
    db.table("agents").delete().eq("id", agent_id).execute()
    return {"status": "deleted"}


# -- Agent versioning (admin) --------------------------------------------------

@app.get("/admin/agents/{agent_id}/versions", tags=["admin"])
async def admin_list_agent_versions(agent_id: str, _admin: dict = Depends(_get_admin_from_token)):
    """List config snapshots for an agent, newest first — the agent's publish history."""
    db = get_supabase()
    result = (
        db.table("agent_versions")
        .select("*, admin_users(name,email)")
        .eq("agent_id", agent_id)
        .order("version_number", desc=True)
        .execute()
    )
    return result.data


class VersionRestore(BaseModel):
    note: str | None = None


@app.post("/admin/agents/{agent_id}/versions/{version_id}/restore", tags=["admin"])
async def admin_restore_agent_version(
    agent_id: str, version_id: str, body: VersionRestore, _admin: dict = Depends(_get_admin_from_token)
):
    """Roll the agent back to a prior config snapshot. Snapshots the current
    (about-to-be-replaced) config first, so restoring is itself reversible."""
    db = get_supabase()
    version = db.table("agent_versions").select("*").eq("id", version_id).eq("agent_id", agent_id).single().execute()
    if not version.data:
        raise HTTPException(status_code=404, detail="Version not found")
    current = db.table("agents").select("*").eq("id", agent_id).single().execute()
    if not current.data:
        raise HTTPException(status_code=404, detail="Agent not found")

    note = body.note or f"Restaurado desde versión {version.data['version_number']}"
    _snapshot_agent_version(db, current.data, note, _admin.get("id"))

    restored = {field: version.data.get(field) for field in AGENT_CONFIG_FIELDS}
    result = db.table("agents").update(restored).eq("id", agent_id).execute()
    return result.data[0]


# -- Agent tools (admin) --------------------------------------------------------

class AgentToolCreate(BaseModel):
    key: str
    label: str
    description: str | None = None
    tool_type: str = "webhook"
    enabled: bool = True
    config: dict = {}


class AgentToolUpdate(BaseModel):
    label: str | None = None
    description: str | None = None
    enabled: bool | None = None
    config: dict | None = None
    # Per-agent override over the global tool's config (URL, method, parameters).
    # Pass `null` explicitly to clear the override and fall back to the global
    # tool's config. The agent's `_build_tools` does a shallow merge: custom wins
    # on each key.
    custom_config: dict | None = None


# ── Global tools catalog ──────────────────────────────────────────────────────
# Reusable webhook tools that admins create once and assign to many agents.
# (Built-in presets like Transfer/HangUp are still per-agent rows in
# agent_tools with tool_type="builtin" — see BUILTIN_TOOLS in agent.py.)

class GlobalToolCreate(BaseModel):
    name: str
    key: str
    description: str | None = None
    config: dict = {}


class GlobalToolUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    config: dict | None = None


# Built-in preset tools that ship with the platform. These map to native
# functions in agent.py (see BUILTIN_TOOLS). The frontend shows them as
# always-available options in the agent's Tools tab.
BUILTIN_PRESETS = [
    {
        "key": "transfer_call",
        "name": "Transfer Call",
        "description": "Transfiere la llamada a otro número, extensión o departamento (Twilio <Dial>).",
        "tool_type": "builtin",
        "parameters": {
            "type": "object",
            "properties": {
                "to_number": {"type": "string", "description": "Número destino en formato E.164 (ej. +5072023503)."},
                "reason": {"type": "string", "description": "Razón de la transferencia (opcional)."},
            },
            "required": ["to_number"],
        },
    },
    {
        "key": "end_call",
        "name": "Hang Up / End Call",
        "description": "Termina la llamada elegantemente. Úsalo cuando el cliente dice adiós o la conversación termina.",
        "tool_type": "builtin",
        "parameters": {
            "type": "object",
            "properties": {
                "reason": {"type": "string", "description": "Razón por la que se termina la llamada (opcional)."},
            },
        },
    },
    {
        "key": "send_sms",
        "name": "Send SMS",
        "description": "Envía un SMS al cliente (resumen, link, confirmación). Solo cuando el cliente lo solicite o para reforzar un mensaje verbal.",
        "tool_type": "builtin",
        "parameters": {
            "type": "object",
            "properties": {
                "to_number": {"type": "string", "description": "Número destino en formato E.164."},
                "body": {"type": "string", "description": "Contenido del SMS (máx 1600 chars)."},
            },
            "required": ["to_number", "body"],
        },
    },
    {
        "key": "leave_voicemail",
        "name": "Leave Voicemail",
        "description": "Cuelga dejando un mensaje de voicemail predefinido (usar en buzones detectados por AMD).",
        "tool_type": "builtin",
        "parameters": {
            "type": "object",
            "properties": {
                "message": {"type": "string", "description": "Mensaje a dejar (opcional; usa uno por defecto si se omite)."},
            },
        },
    },
]


@app.get("/admin/tools", tags=["admin"])
async def admin_list_global_tools(_admin: dict = Depends(_get_admin_from_token)):
    """List the global webhook tool catalog, with usage counts per tool."""
    db = get_supabase()
    rows = db.table("tools").select("*").order("created_at", desc=True).execute().data or []
    if not rows:
        return []
    # Per-tool usage count (how many agents have this tool assigned)
    ids = [r["id"] for r in rows]
    usage_rows = (
        db.table("agent_tools")
        .select("tool_id")
        .in_("tool_id", ids)
        .execute()
        .data or []
    )
    usage: dict[str, int] = {}
    for u in usage_rows:
        tid = u.get("tool_id")
        if tid:
            usage[tid] = usage.get(tid, 0) + 1
    for r in rows:
        r["usage_count"] = usage.get(r["id"], 0)
    return rows


class GlobalToolCreatePayload(BaseModel):
    name: str
    key: str
    description: str | None = None
    config: dict = {}


@app.post("/admin/tools", status_code=201, tags=["admin"])
async def admin_create_global_tool(
    body: GlobalToolCreatePayload, _admin: dict = Depends(_get_admin_from_token)
):
    """Create a new global webhook tool in the catalog."""
    db = get_supabase()
    key = body.key.strip()
    if not key or not key.replace("_", "").isalnum():
        raise HTTPException(status_code=400, detail="key debe ser snake_case alfanumérico")
    if not body.config.get("url"):
        raise HTTPException(status_code=400, detail="config.url es requerido")
    try:
        row = db.table("tools").insert({
            "name": body.name,
            "key": key,
            "description": body.description,
            "tool_type": "webhook",
            "config": body.config,
            "created_by": _admin.get("id"),
        }).execute()
    except Exception as e:
        msg = str(e)
        if "duplicate" in msg.lower() or "unique" in msg.lower():
            raise HTTPException(status_code=409, detail=f"Ya existe un tool con key={key!r}")
        raise HTTPException(status_code=400, detail=str(e))
    if not row.data:
        raise HTTPException(status_code=500, detail="Failed to create tool")
    return row.data[0]


@app.patch("/admin/tools/{tool_id}", tags=["admin"])
async def admin_update_global_tool(
    tool_id: str, body: GlobalToolUpdate, _admin: dict = Depends(_get_admin_from_token)
):
    db = get_supabase()
    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    result = db.table("tools").update(updates).eq("id", tool_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Tool not found")
    return result.data[0]


@app.delete("/admin/tools/{tool_id}", tags=["admin"])
async def admin_delete_global_tool(tool_id: str, _admin: dict = Depends(_get_admin_from_token)):
    """Delete a global tool. CASCADE removes all agent assignments."""
    db = get_supabase()
    # Count assignments for the warning response
    count = (
        db.table("agent_tools")
        .select("id", count="exact")
        .eq("tool_id", tool_id)
        .execute()
        .count or 0
    )
    result = db.table("tools").delete().eq("id", tool_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Tool not found")
    return {"status": "deleted", "assignments_removed": count}


class ToolTestPayload(BaseModel):
    """Payload for POST /admin/tools/{id}/test — fires a real request at
    the webhook without persisting anything. Optional `url` override lets
    admins test a variant (e.g. dev vs prod) before swapping."""
    url: str | None = None
    method: str = "POST"
    headers: dict = {}
    body: dict = {}


@app.post("/admin/tools/{tool_id}/test", tags=["admin"])
async def admin_test_tool(
    tool_id: str,
    body: ToolTestPayload,
    _admin: dict = Depends(_get_admin_from_token),
):
    """Test a webhook tool without saving. Returns upstream status, latency,
    headers, and a 2000-char-truncated body. SSRF-protected (https:// or
    localhost only). When the caller supplies a `url`, the stored config is
    bypassed — useful for testing dev URLs or one-off variants.

    The webhook payload includes `_tool` and `_tool_key` metadata so the
    receiver can identify which tool fired."""
    tool = (
        get_supabase()
        .table("tools")
        .select("*")
        .eq("id", tool_id)
        .single()
        .execute()
    )
    if not tool.data:
        raise HTTPException(status_code=404, detail="Tool not found")

    # Build an effective tool dict that respects URL override.
    if body.url:
        override_cfg = {
            "url": body.url,
            "method": body.method,
            "headers": body.headers or {},
        }
        # Merge overrides on top of the stored config.
        effective = {**tool.data, "config": {**(tool.data.get("config") or {}), **override_cfg}}
    else:
        effective = tool.data

    return await _execute_webhook_tool(effective, body.body or {})


@app.get("/admin/tools/presets", tags=["admin"])
async def admin_list_builtin_presets(_admin: dict = Depends(_get_admin_from_token)):
    """List the always-available built-in tool presets (Transfer, HangUp, etc.).
    These map to native functions in agent.py and can be assigned to any agent."""
    return BUILTIN_PRESETS


@app.get("/admin/agents/{agent_id}/webhook-deliveries", tags=["admin"])
async def admin_list_webhook_deliveries(
    agent_id: str,
    limit: int = 50,
    status: str | None = None,
    _admin: dict = Depends(_get_admin_from_token),
):
    """List recent post-call webhook deliveries for this agent with optional
    status filter. Used by the dashboard's WebhooksTab so admins can see
    delivery history and identify failures that need manual retry."""
    db = get_supabase()
    q = (
        db.table("webhook_deliveries")
        .select("*")
        .eq("agent_id", agent_id)
        .order("created_at", desc=True)
        .limit(min(limit, 200))
    )
    if status:
        q = q.eq("status", status)
    rows = q.execute().data or []
    return rows


@app.post("/admin/agents/{agent_id}/webhook-deliveries/{delivery_id}/retry", tags=["admin"])
async def admin_retry_webhook_delivery(
    agent_id: str,
    delivery_id: str,
    _admin: dict = Depends(_get_admin_from_token),
):
    """Re-fire a failed webhook delivery. Reads the original session payload
    (transcript, summary, tools, costs) and re-POSTs to the agent's webhook
    URL. Updates the existing delivery row with the new attempt's result
    instead of inserting a new one — keeps the audit trail clean."""
    import aiohttp
    import hashlib
    import hmac
    db = get_supabase()
    delivery = (
        db.table("webhook_deliveries")
        .select("*")
        .eq("id", delivery_id)
        .eq("agent_id", agent_id)
        .maybe_single()
        .execute()
    )
    if not delivery.data:
        raise HTTPException(status_code=404, detail="Delivery not found")

    session = (
        db.table("sessions")
        .select("*")
        .eq("id", delivery.data["session_id"])
        .maybe_single()
        .execute()
    )
    if not session.data:
        raise HTTPException(status_code=404, detail="Session not found")

    # Reconstruct the same payload the original delivery would have sent.
    # We don't store the full payload in webhook_deliveries (storage cost),
    # so we re-build from current session data — if the session has been
    # modified since, the retried payload will reflect the latest state.
    payload = {
        "event": "end-of-call",
        "version": "1.0",
        "agent_id": agent_id,
        "session_id": session.data["id"],
        "call": {
            "room_name": session.data.get("room_name"),
            "twilio_call_sid": session.data.get("twilio_call_sid"),
            "end_reason": session.data.get("end_reason"),
        },
        "costs": {
            "total_usd": float(session.data.get("total_cost_usd") or 0),
            "by_provider": session.data.get("cost_by_provider") or {},
        },
        "summary": session.data.get("call_summary"),
        "transcript": session.data.get("transcript"),
        "tools": session.data.get("tool_calls_log") or [],
    }
    payload_json = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    # Look up the agent's current webhook config (may have changed).
    agent_row = (
        db.table("agents")
        .select("webhook_url,webhook_secret")
        .eq("id", agent_id)
        .maybe_single()
        .execute()
    )
    webhook_url = (agent_row.data or {}).get("webhook_url")
    webhook_secret = (agent_row.data or {}).get("webhook_secret")
    if not webhook_url:
        raise HTTPException(status_code=400, detail="Agent has no webhook_url configured")

    headers = {"Content-Type": "application/json"}
    if webhook_secret:
        digest = hmac.new(webhook_secret.encode("utf-8"), payload_json, hashlib.sha256).hexdigest()
        headers["X-Webhook-Signature"] = f"sha256={digest}"

    import time
    start = time.monotonic()
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as http:
            async with http.post(webhook_url, data=payload_json, headers=headers) as resp:
                text = (await resp.text())[:1000]
                elapsed_ms = int((time.monotonic() - start) * 1000)
                new_status = "delivered" if 200 <= resp.status < 300 else "failed"
                # Update the existing delivery row with the retry result
                db.table("webhook_deliveries").update({
                    "status": new_status,
                    "http_status": resp.status,
                    "latency_ms": elapsed_ms,
                    "attempts": delivery.data.get("attempts", 1) + 1,
                    "response_body": text,
                    "last_error": None if new_status == "delivered" else f"HTTP {resp.status}",
                }).eq("id", delivery_id).execute()
                return {
                    "status": new_status,
                    "http_status": resp.status,
                    "latency_ms": elapsed_ms,
                }
    except Exception as e:
        elapsed_ms = int((time.monotonic() - start) * 1000)
        db.table("webhook_deliveries").update({
            "status": "failed",
            "http_status": None,
            "latency_ms": elapsed_ms,
            "attempts": delivery.data.get("attempts", 1) + 1,
            "last_error": str(e)[:300],
        }).eq("id", delivery_id).execute()
        raise HTTPException(status_code=502, detail=f"Retry failed: {e}")


@app.get("/admin/agents/{agent_id}/tools", tags=["admin"])
async def admin_list_agent_tools(agent_id: str, _admin: dict = Depends(_get_admin_from_token)):
    """List all tools assigned to an agent — both built-in presets and
    webhook tools (whether agent-specific inline rows or assignments of
    global catalog tools via tool_id)."""
    db = get_supabase()
    rows = db.table("agent_tools").select("*").eq("agent_id", agent_id).order("created_at").execute()
    rows = rows.data or []
    if not rows:
        return []
    # Enrich rows that reference a global tool with the tool's metadata
    tool_ids = {r["tool_id"] for r in rows if r.get("tool_id")}
    if tool_ids:
        global_rows = (
            db.table("tools").select("id,name,key,description,config").in_("id", list(tool_ids)).execute().data or []
        )
        by_id = {t["id"]: t for t in global_rows}
        for r in rows:
            tpl = by_id.get(r.get("tool_id"))
            if tpl:
                r["global_tool"] = tpl
    return rows


class AgentToolAssign(BaseModel):
    tool_id: str


@app.post("/admin/agents/{agent_id}/tools", status_code=201, tags=["admin"])
async def admin_create_agent_tool(
    agent_id: str,
    body: dict,
    _admin: dict = Depends(_get_admin_from_token),
):
    """Register a tool for an agent. Supports two flows:
      A) Assign a global tool from the catalog: body = {tool_id, custom_config?, enabled?}
      B) Create a per-agent inline tool:    body = {key, label, description, tool_type, config, enabled}
    """
    db = get_supabase()
    agent = db.table("agents").select("id").eq("id", agent_id).single().execute()
    if not agent.data:
        raise HTTPException(status_code=404, detail="Agent not found")

    # Flow A: assign a global tool
    tool_id = body.get("tool_id")
    if tool_id:
        tpl = db.table("tools").select("id,key,name,description,config").eq("id", tool_id).single().execute()
        if not tpl.data:
            raise HTTPException(status_code=404, detail="Global tool not found")
        # Check if already assigned
        existing = (
            db.table("agent_tools")
            .select("id")
            .eq("agent_id", agent_id)
            .eq("tool_id", tool_id)
            .execute()
            .data or []
        )
        if existing:
            raise HTTPException(status_code=409, detail="Tool already assigned to this agent")
        try:
            row = db.table("agent_tools").insert({
                "agent_id": agent_id,
                "tool_id": tool_id,
                "key": tpl.data["key"],
                "label": tpl.data["name"],
                "description": tpl.data["description"],
                "tool_type": "webhook",
                "enabled": body.get("enabled", True),
                "config": tpl.data["config"],
                "custom_config": body.get("custom_config"),
            }).execute()
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))
        if not row.data:
            raise HTTPException(status_code=500, detail="Failed to assign tool")
        return row.data[0]

    # Flow B: legacy inline tool creation
    key = (body.get("key") or "").strip()
    label = (body.get("label") or "").strip()
    if not key or not label:
        raise HTTPException(status_code=400, detail="key y label son requeridos para tools inline")
    if body.get("tool_type") not in ("builtin", "webhook"):
        raise HTTPException(status_code=400, detail="tool_type must be 'builtin' or 'webhook'")
    try:
        row = db.table("agent_tools").insert({
            "agent_id": agent_id,
            "key": key,
            "label": label,
            "description": body.get("description"),
            "tool_type": body["tool_type"],
            "enabled": body.get("enabled", True),
            "config": body.get("config") or {},
        }).execute()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not create tool (duplicate key?): {e}")
    return row.data[0]


@app.patch("/admin/agents/{agent_id}/tools/{tool_id}", tags=["admin"])
async def admin_update_agent_tool(
    agent_id: str, tool_id: str, body: AgentToolUpdate, _admin: dict = Depends(_get_admin_from_token)
):
    db = get_supabase()
    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    result = db.table("agent_tools").update(updates).eq("id", tool_id).eq("agent_id", agent_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Tool not found")
    return result.data[0]


@app.delete("/admin/agents/{agent_id}/tools/{tool_id}", tags=["admin"])
async def admin_delete_agent_tool(agent_id: str, tool_id: str, _admin: dict = Depends(_get_admin_from_token)):
    db = get_supabase()
    result = db.table("agent_tools").delete().eq("id", tool_id).eq("agent_id", agent_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Tool not found")
    return {"status": "deleted"}


# -- Agent knowledge base (admin) -----------------------------------------------

class AgentKnowledgeCreate(BaseModel):
    title: str
    content: str


@app.get("/admin/agents/{agent_id}/knowledge", tags=["admin"])
async def admin_list_agent_knowledge(agent_id: str, _admin: dict = Depends(_get_admin_from_token)):
    db = get_supabase()
    result = db.table("agent_knowledge").select("*").eq("agent_id", agent_id).order("created_at").execute()
    return result.data


@app.post("/admin/agents/{agent_id}/knowledge", status_code=201, tags=["admin"])
async def admin_create_agent_knowledge(
    agent_id: str, body: AgentKnowledgeCreate, _admin: dict = Depends(_get_admin_from_token)
):
    """Add a text snippet to the agent's knowledge base — appended to its system
    prompt at runtime as reference material (lightweight KB, no embeddings/RAG)."""
    db = get_supabase()
    agent = db.table("agents").select("id").eq("id", agent_id).single().execute()
    if not agent.data:
        raise HTTPException(status_code=404, detail="Agent not found")
    result = db.table("agent_knowledge").insert({
        "agent_id": agent_id,
        "title": body.title,
        "content": body.content,
    }).execute()
    return result.data[0]


@app.delete("/admin/agents/{agent_id}/knowledge/{knowledge_id}", tags=["admin"])
async def admin_delete_agent_knowledge(agent_id: str, knowledge_id: str, _admin: dict = Depends(_get_admin_from_token)):
    db = get_supabase()
    result = db.table("agent_knowledge").delete().eq("id", knowledge_id).eq("agent_id", agent_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Knowledge entry not found")
    return {"status": "deleted"}


# -- Agent playground (admin) ---------------------------------------------------

class PlaygroundMessage(BaseModel):
    role: str  # "user" | "assistant"
    content: str


class PlaygroundRequest(BaseModel):
    messages: list[PlaygroundMessage]


def _agent_tools_to_openai_functions(agent_tools: list[dict]) -> list[dict]:
    """Convert agent_tools rows into OpenAI's function-calling `tools` format.
    Skips builtin tools (Transfer/HangUp/SMS) which only work in real calls."""
    functions = []
    for t in agent_tools:
        if t.get("tool_type") == "builtin":
            continue
        if not t.get("enabled", True):
            continue
        # Use custom_config if set, else fall back to config
        cfg = t.get("custom_config") or t.get("config") or {}
        params = cfg.get("parameters") or {"type": "object", "properties": {}}
        functions.append({
            "type": "function",
            "function": {
                "name": t["key"],
                "description": t.get("description") or t.get("label") or t["key"],
                "parameters": params,
            },
        })
    return functions


async def _execute_webhook_tool(tool: dict, arguments: dict) -> dict:
    """Execute a webhook tool by POSTing arguments to the configured URL.
    Returns {"ok": bool, "status": int, "body": str, "error": str|None}.

    The request body merges the LLM-supplied arguments with two metadata
    fields (`_tool` and `_tool_key`) so the receiving webhook can identify
    which tool fired without inspecting its own routing logic."""
    cfg = tool.get("custom_config") or tool.get("config") or {}
    url = cfg.get("url", "")
    method = (cfg.get("method") or "POST").upper()
    headers = cfg.get("headers") or {"Content-Type": "application/json"}
    if not url:
        return {"ok": False, "status": 0, "body": "", "error": "Tool has no URL configured"}
    if not url.startswith("https://") and not url.startswith("http://localhost"):
        return {"ok": False, "status": 0, "body": "", "error": "URL must be https:// or localhost"}
    # Merge metadata into body so the receiver can identify the tool.
    # Underscored keys avoid collision with the LLM's chosen argument names.
    tool_name = tool.get("name") or tool.get("label") or tool.get("key", "")
    tool_key = tool.get("key", "")
    if isinstance(arguments, dict):
        body_payload = {**arguments, "_tool": tool_name, "_tool_key": tool_key}
    else:
        body_payload = arguments
    import aiohttp
    import time
    start = time.monotonic()
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as session:
            async with session.request(
                method, url,
                json=body_payload if method in ("POST", "PUT", "PATCH") else None,
                headers=headers,
            ) as resp:
                body = await resp.text()
                return {
                    "ok": True,
                    "status": resp.status,
                    "body": body[:2000],
                    "error": None,
                    "latency_ms": int((time.monotonic() - start) * 1000),
                }
    except Exception as e:
        return {"ok": False, "status": 0, "body": "", "error": str(e)[:300]}


@app.post("/admin/agents/{agent_id}/playground", tags=["admin"])
async def admin_agent_playground(agent_id: str, body: PlaygroundRequest, _admin: dict = Depends(_get_admin_from_token)):
    """Text-chat sandbox for testing an agent's prompt/persona WITHOUT placing a
    real call — sends the agent's current system prompt + KB + tools + conversation
    so far to its configured LLM (OpenAI chat completions with function calling).
    Loops up to MAX_TOOL_ITERATIONS to allow tool-calling webhooks to fire and
    the LLM to react to the result. Returns the final reply + tool_calls log so
    admins can verify the LLM actually invoked each webhook."""
    db = get_supabase()
    agent = db.table("agents").select("*").eq("id", agent_id).single().execute()
    if not agent.data:
        raise HTTPException(status_code=404, detail="Agent not found")
    a = agent.data

    api_key = os.getenv("OPENAI_API_KEY", "")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY not configured on the server")

    system_prompt = a.get("system_prompt") or "Eres un asistente de voz útil y conciso."
    knowledge = db.table("agent_knowledge").select("title,content").eq("agent_id", agent_id).execute()
    if knowledge.data:
        kb_text = "\n\n".join(f"### {k['title']} ###\n{k['content']}" for k in knowledge.data)
        system_prompt = f"{system_prompt}\n\n## Base de conocimiento ##\n{kb_text}"

    # Load tools (webhook only — builtin tools need real LiveKit session)
    agent_tools_rows = (
        db.table("agent_tools")
        .select("*")
        .eq("agent_id", agent_id)
        .eq("tool_type", "webhook")
        .execute()
        .data or []
    )
    tools_for_openai = _agent_tools_to_openai_functions(agent_tools_rows)
    # Index by key for fast lookup during tool_calls loop
    tools_by_key = {t["key"]: t for t in agent_tools_rows}

    chat_messages = [{"role": "system", "content": system_prompt}]
    chat_messages += [{"role": m.role, "content": m.content} for m in body.messages]

    tool_calls_log: list[dict] = []
    total_usage: dict = {}

    import httpx
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            # Tool-calling loop. Cap iterations so a misbehaving tool can't
            # loop forever. 5 is plenty for realistic voice-agent flows.
            MAX_TOOL_ITERATIONS = 5
            for _ in range(MAX_TOOL_ITERATIONS + 1):
                payload = {
                    "model": a.get("llm_model") or "gpt-4o",
                    "temperature": float(a.get("temperature") or 0.7),
                    "messages": chat_messages,
                }
                if tools_for_openai:
                    payload["tools"] = tools_for_openai

                resp = await client.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}"},
                    json=payload,
                )
                resp.raise_for_status()
                data = resp.json()

                # Accumulate token usage (only int fields — completion_tokens_details
                # is a dict and would fail with + operator)
                if "usage" in data:
                    for k, v in data["usage"].items():
                        if isinstance(v, (int, float)):
                            total_usage[k] = total_usage.get(k, 0) + v

                choice = data["choices"][0]
                msg = choice.get("message", {})
                finish = choice.get("finish_reason")

                # Append assistant message to conversation history
                chat_messages.append(msg)

                # If LLM didn't call a tool → we have the final reply
                tool_calls = msg.get("tool_calls") or []
                if not tool_calls or finish == "stop":
                    return {
                        "reply": msg.get("content", ""),
                        "usage": total_usage,
                        "tool_calls": tool_calls_log,
                    }

                # Execute each tool call and append the result as a tool message
                for tc in tool_calls:
                    fn_name = tc["function"]["name"]
                    try:
                        fn_args = json.loads(tc["function"].get("arguments") or "{}")
                    except json.JSONDecodeError:
                        fn_args = {}
                    tool = tools_by_key.get(fn_name)
                    if not tool:
                        result = {"ok": False, "error": f"Unknown tool: {fn_name}"}
                    else:
                        result = await _execute_webhook_tool(tool, fn_args)
                    tool_calls_log.append({
                        "name": fn_name,
                        "arguments": fn_args,
                        "status": result.get("status", 0),
                        "ok": result.get("ok", False),
                        "latency_ms": result.get("latency_ms"),
                        "body_preview": (result.get("body") or "")[:500],
                        "error": result.get("error"),
                    })
                    chat_messages.append({
                        "role": "tool",
                        "tool_call_id": tc["id"],
                        "content": json.dumps({
                            "ok": result.get("ok", False),
                            "status": result.get("status", 0),
                            "body": (result.get("body") or "")[:2000],
                            "error": result.get("error"),
                        }),
                    })

                # Loop: send tool results back to LLM for follow-up reply
            # Hit MAX iterations without final answer — return what we have
            last = chat_messages[-1] if chat_messages else {}
            return {
                "reply": last.get("content", "") or "(loop agotado)",
                "usage": total_usage,
                "tool_calls": tool_calls_log,
                "warning": "MAX_TOOL_ITERATIONS reached",
            }
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"LLM request failed: {e.response.text[:300]}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM request failed: {e}")


# -- Portal endpoints (require client JWT) ------------------------------------

@app.post("/portal/login", tags=["portal"])
async def portal_login(body: dict, response: Response):
    """Exchange email+password for a Supabase session token.

    S2.4 — same cookie + CSRF flow as /admin/login but with `portal_session`
    / `csrf_portal` cookie names so the admin and portal surfaces don't
    collide in the same browser.
    """
    email = body.get("email", "")
    password = body.get("password", "")
    try:
        from supabase import create_client
        client = create_client(
            os.getenv("SUPABASE_URL", ""),
            os.getenv("SUPABASE_ANON_KEY", ""),
        )
        session = client.auth.sign_in_with_password({"email": email, "password": password})
        csrf = _set_session_cookies(response, "client", session.session.access_token)
        return {
            "access_token": session.session.access_token,
            "refresh_token": session.session.refresh_token,
            "expires_in": session.session.expires_in,
            "csrf_token": csrf,
        }
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid credentials")


@app.post("/portal/logout", tags=["portal"])
async def portal_logout(response: Response, _client: dict = Depends(_get_client_from_token)):
    """Clear the portal session + CSRF cookies."""
    _clear_session_cookies(response, "client")
    return {"status": "ok"}


@app.get("/portal/me", tags=["portal"])
async def portal_me(client: dict = Depends(_get_client_from_token)):
    """Return the authenticated client's profile and agents."""
    db = get_supabase()
    agents = db.table("agents").select("*").eq("client_id", client["id"]).execute()
    return {"client": client, "agents": agents.data}


async def _resolve_recording_url(db: object, session_id: str, row: dict) -> str:
    """Return the session's cached recording URL, fetching + caching it from Twilio if missing.
    Tries all configured Twilio accounts (PA first) so Panama calls are resolved correctly.
    """
    recording_url = row.get("recording_url")
    if recording_url:
        return recording_url

    twilio_sid = row.get("twilio_call_sid")
    if not twilio_sid:
        raise HTTPException(status_code=404, detail="No recording available")

    if not _get_twilio_accounts():
        raise HTTPException(status_code=503, detail="Twilio credentials not configured")

    recording_url = await _fetch_recording_url_from_twilio(twilio_sid)
    if not recording_url:
        raise HTTPException(status_code=404, detail="Recording not yet available")

    db.table("sessions").update({"recording_url": recording_url}).eq("id", session_id).execute()
    return recording_url


async def _proxy_twilio_recording(session_id: str, recording_url: str):
    """Stream a Twilio recording back through our API so Twilio credentials stay server-side."""
    import httpx
    from fastapi.responses import StreamingResponse

    # Detect which account owns this recording URL and use its credentials
    accounts = _get_twilio_accounts()
    account_sid, auth_token = accounts[0] if accounts else ("", "")
    for sid, token in accounts:
        if sid in recording_url:
            account_sid, auth_token = sid, token
            break

    async with httpx.AsyncClient(auth=(account_sid, auth_token)) as hclient:
        twilio_resp = await hclient.get(recording_url, follow_redirects=True)
        if twilio_resp.status_code != 200:
            raise HTTPException(status_code=502, detail="Failed to fetch recording from Twilio")
        return StreamingResponse(
            content=iter([twilio_resp.content]),
            media_type="audio/mpeg",
            headers={"Content-Disposition": f'inline; filename="recording-{session_id}.mp3"'},
        )


@app.get("/portal/recordings/{session_id}", tags=["portal"])
async def portal_recording(
    session_id: str,
    client: dict = Depends(_get_client_from_token),
):
    """Proxy Twilio recording for a session — scoped to the client's own agents."""
    db = get_supabase()
    agent_ids = _client_agent_ids(db, client["id"])
    if not agent_ids:
        raise HTTPException(status_code=404, detail="Session not found")

    row = (
        db.table("sessions")
        .select("recording_url,twilio_call_sid,agent_id")
        .eq("id", session_id)
        .single()
        .execute()
    )
    # 404 (not 403) for both "doesn't exist" and "belongs to another client" —
    # avoids leaking whether a given session ID exists to other tenants.
    if not row.data or row.data.get("agent_id") not in agent_ids:
        raise HTTPException(status_code=404, detail="Session not found")

    recording_url = await _resolve_recording_url(db, session_id, row.data)
    return await _proxy_twilio_recording(session_id, recording_url)


@app.get("/calls/recordings/{session_id}", tags=["admin"])
async def admin_recording(
    session_id: str,
    _admin: dict = Depends(_get_admin_from_token),
):
    """Proxy Twilio recording for any session — admin view, no tenant scoping."""
    db = get_supabase()
    row = (
        db.table("sessions")
        .select("recording_url,twilio_call_sid")
        .eq("id", session_id)
        .single()
        .execute()
    )
    if not row.data:
        raise HTTPException(status_code=404, detail="Session not found")

    recording_url = await _resolve_recording_url(db, session_id, row.data)
    return await _proxy_twilio_recording(session_id, recording_url)


@app.get("/portal/campaigns", tags=["portal"])
async def portal_campaigns(client: dict = Depends(_get_client_from_token)):
    """List campaigns belonging to the client's agents with real-time disposition stats."""
    db = get_supabase()
    agent_ids = _client_agent_ids(db, client["id"])
    if not agent_ids:
        return []
    campaigns = (
        db.table("campaigns")
        .select("id,name,status,total_numbers,called,answered,voicemail,no_answer,created_at,started_at,completed_at,agent_id")
        .in_("agent_id", agent_ids)
        .order("created_at", desc=True)
        .execute()
        .data or []
    )
    if not campaigns:
        return []

    # Enrich with real session dispositions (same logic as /campaigns admin endpoint)
    from collections import defaultdict
    campaign_ids = [c["id"] for c in campaigns]
    cq_rows = (
        db.table("call_queue")
        .select("campaign_id,status,room_name")
        .in_("campaign_id", campaign_ids)
        .execute()
        .data or []
    )
    room_names = [r["room_name"] for r in cq_rows if r.get("room_name")]
    end_reason_map: dict[str, str] = {}
    if room_names:
        sess_rows = (
            db.table("sessions")
            .select("room_name,end_reason")
            .in_("room_name", room_names)
            .execute()
            .data or []
        )
        end_reason_map = {s["room_name"]: s.get("end_reason") for s in sess_rows}

    _HUMAN_REASONS = {"client_hangup", "agent_hangup", "completed"}
    stats: dict[str, dict] = defaultdict(lambda: {
        "called": 0, "answered": 0, "voicemail": 0, "no_answer": 0, "failed": 0,
    })
    for row in cq_rows:
        cid = row["campaign_id"]
        q_status = row.get("status", "")
        if q_status == "pending":
            continue
        stats[cid]["called"] += 1
        room = row.get("room_name")
        end_reason = end_reason_map.get(room) if room else None
        if end_reason == "voicemail":
            stats[cid]["voicemail"] += 1
        elif end_reason in _HUMAN_REASONS:
            stats[cid]["answered"] += 1
        elif q_status == "no_answer":
            stats[cid]["no_answer"] += 1
        elif q_status == "failed":
            stats[cid]["failed"] += 1
        elif not end_reason and q_status == "completed":
            stats[cid]["answered"] += 1

    enriched = []
    for c in campaigns:
        s = stats.get(c["id"])
        if s:
            c = {**c, **s}
        enriched.append(c)
    return enriched


@app.get("/portal/calls", tags=["portal"])
async def portal_calls(
    limit: int = 200,
    client: dict = Depends(_get_client_from_token),
):
    """
    Unified call log for the client: sessions (inbound + outbound ad-hoc) PLUS
    campaign calls from call_queue (which may have no session if the call never
    connected). Both sources are merged, deduplicated by room_name, and sorted
    by started_at descending. Cost data is excluded from campaign rows.
    """
    from datetime import datetime, timezone

    db = get_supabase()
    agent_ids = _client_agent_ids(db, client["id"])
    if not agent_ids:
        return []

    # ── Source 1: sessions (agent-driven calls) ──────────────────────────────
    session_result = (
        db.table("sessions")
        .select(_CALL_LOG_SELECT)
        .like("room_name", "call-%")
        .in_("agent_id", agent_ids)
        .order("started_at", desc=True)
        .limit(limit)
        .execute()
    )
    session_rows = session_result.data or []
    phone_lookup = _phone_lookup_for_rooms(db, [r.get("room_name") for r in session_rows])
    session_entries = [_session_to_call_row(s, phone_lookup) for s in session_rows]
    session_room_names: set[str] = {e["room_name"] for e in session_entries if e.get("room_name")}

    # ── Source 2: campaign call_queue rows ───────────────────────────────────
    # Find all campaigns that belong to the client's agents
    campaign_result = (
        db.table("campaigns")
        .select("id")
        .in_("agent_id", agent_ids)
        .execute()
    )
    campaign_ids = [c["id"] for c in (campaign_result.data or [])]

    campaign_entries: list[dict] = []
    if campaign_ids:
        cq_result = (
            db.table("call_queue")
            .select(
                "id,phone_number,status,room_name,duration_seconds,"
                "transcript,recording_url,started_at,ended_at"
            )
            .in_("campaign_id", campaign_ids)
            .not_.is_("started_at", "null")   # only calls that were actually dialed
            .order("started_at", desc=True)
            .limit(limit)
            .execute()
        )
        for cq in (cq_result.data or []):
            room = cq.get("room_name")
            # Skip if already covered by a session entry (avoid duplicates)
            if room and room in session_room_names:
                continue

            # Infer end_reason from queue status (same logic as campaign_logs endpoint)
            q_status = cq.get("status", "")
            if q_status == "no_answer":
                end_reason = "no_answer"
            elif q_status == "failed":
                end_reason = "failed"
            elif q_status == "completed":
                end_reason = "client_hangup"
            else:
                end_reason = None

            status = end_reason if end_reason in _END_REASON_LABELS else (q_status or "completed")

            campaign_entries.append({
                "id": str(cq["id"]),
                "direction": "outbound",
                "from_number": None,
                "to_number": cq.get("phone_number"),
                "status": status,
                "status_label": _END_REASON_LABELS.get(status, status),
                "duration_seconds": cq.get("duration_seconds"),
                "started_at": cq.get("started_at"),
                "ended_at": cq.get("ended_at"),
                "room_name": room,
                "cost_usd": 0.0,   # cost excluded from portal
                "transcript": cq.get("transcript"),
                "recording_url": cq.get("recording_url"),
                "twilio_call_sid": None,
                "source": "campaign",
            })

    # ── Merge + sort by started_at descending ────────────────────────────────
    combined = session_entries + campaign_entries

    def _sort_key(row: dict) -> str:
        return row.get("started_at") or ""

    combined.sort(key=_sort_key, reverse=True)
    return combined[:limit]


@app.get("/portal/campaigns/{campaign_id}/calls", tags=["portal"])
async def portal_campaign_calls(
    campaign_id: str,
    client: dict = Depends(_get_client_from_token),
):
    """List calls for a campaign — NO cost data, only client-safe fields."""
    db = get_supabase()
    # Security: verify this campaign belongs to the client
    agent_ids = _client_agent_ids(db, client["id"])
    campaign = db.table("campaigns").select("agent_id").eq("id", campaign_id).single().execute()
    if not campaign.data or campaign.data["agent_id"] not in agent_ids:
        raise HTTPException(status_code=403, detail="Access denied")

    result = (
        db.table("call_queue")
        .select(
            # Explicitly exclude cost columns
            "id,phone_number,customer_name,status,room_name,duration_seconds,"
            "transcript,recording_url,started_at,ended_at,error_msg"
        )
        .eq("campaign_id", campaign_id)
        .order("created_at")
        .execute()
    )
    rows = result.data or []

    # Enrich with real disposition from sessions.end_reason (same logic as admin logs endpoint)
    room_names = [r["room_name"] for r in rows if r.get("room_name")]
    end_reason_map: dict[str, str | None] = {}
    if room_names:
        session_rows = (
            db.table("sessions")
            .select("room_name,end_reason")
            .in_("room_name", room_names)
            .execute()
            .data or []
        )
        end_reason_map = {s["room_name"]: s.get("end_reason") for s in session_rows}

    for row in rows:
        room = row.get("room_name")
        end_reason = end_reason_map.get(room) if room else None
        if not end_reason:
            q_status = row.get("status")
            if q_status == "no_answer":
                end_reason = "no_answer"
            elif q_status == "failed":
                end_reason = "failed"
            elif q_status == "completed":
                end_reason = "client_hangup"
        row["end_reason"] = end_reason

    return rows
