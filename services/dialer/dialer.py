"""
Batch outbound dialer for Camila / Tigo Panamá.
Reads call_queue from Supabase, dials via LiveKit SIP, tracks status.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "../../.env"))

from supabase import create_client, Client
from livekit import api as lk_api

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("dialer")

# ── Config ────────────────────────────────────────────────────────────────────
SUPABASE_URL        = os.environ["SUPABASE_URL"]
SUPABASE_KEY        = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
LIVEKIT_URL         = os.getenv("LIVEKIT_URL", "ws://localhost:7880")
LIVEKIT_API_KEY     = os.getenv("LIVEKIT_API_KEY")
LIVEKIT_API_SECRET  = os.getenv("LIVEKIT_API_SECRET")
DEFAULT_OUTBOUND_TRUNK_ID = os.environ["LIVEKIT_SIP_OUTBOUND_TRUNK_ID"]

# S1.2 — fail-fast if LiveKit creds are missing. The previous `devkey`/`secret`
# fallbacks silently used publicly-known credentials; the dialer is invoked as
# a subprocess per campaign, so a missing env at boot means fail-now rather
# than silently misbehave when a campaign starts.
if not LIVEKIT_API_KEY or not LIVEKIT_API_SECRET:
    raise RuntimeError(
        "LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set. "
        "Refusing to start the dialer with default credentials."
    )


def _resolve_outbound_trunk_id(campaign: dict) -> str:
    """
    Pick the LiveKit SIP outbound trunk for this campaign.

    Priority:
    1. BYOC trunk from sip_trunks table (campaign.sip_trunk_id → sip_trunks.lk_trunk_id)
    2. Legacy explicit outbound_trunk_id on the campaign row
    3. Platform default from LIVEKIT_SIP_OUTBOUND_TRUNK_ID env var
    """
    # 1. BYOC client trunk (pre-fetched as campaign["sip_trunk"])
    sip_trunk = campaign.get("sip_trunk") or {}
    if isinstance(sip_trunk, dict):
        lk_id = (sip_trunk.get("lk_trunk_id") or "").strip()
        if lk_id:
            return lk_id
    # 2. Legacy explicit trunk
    trunk_id = (campaign.get("outbound_trunk_id") or "").strip()
    if trunk_id:
        return trunk_id
    # 3. Default platform trunk
    return DEFAULT_OUTBOUND_TRUNK_ID

# ── Pricing per minute ────────────────────────────────────────────────────────
# Update these if prices change
COST_PER_MIN = {
    "twilio_outbound": 0.013,    # Twilio outbound PSTN per minute
    "deepgram_nova3":  0.0043,   # Deepgram Nova-3 per minute
    "elevenlabs_turbo": 0.009,   # ElevenLabs turbo_v2_5 ~$0.18/1K chars, ~1000 chars/min
    "openai_gpt4o":    0.015,    # GPT-4o approx per minute of conversation
}
TWILIO_PHONE_NUMBER = os.getenv("TWILIO_PHONE_NUMBER", "")

RING_TIMEOUT_SEC    = 30   # seconds to wait for answer
VOICEMAIL_TIMEOUT   = 25   # if no speech within 25s → voicemail
VOICEMAIL_TIMEOUT_EXTENDED = 50  # second checkpoint: extra time for the customer to respond
VOICEMAIL_FINAL_GRACE = 8  # extra grace period before finalizing "voicemail" at the
                           # extended checkpoint, to absorb STT/DB-write latency for a
                           # customer who started speaking right around the checkpoint
POLL_INTERVAL       = 3    # seconds between queue polls

db: Client = create_client(SUPABASE_URL, SUPABASE_KEY)


# ── Supabase helpers ──────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _calculate_call_costs(duration_seconds: int) -> dict:
    """Estimate costs for a completed call based on duration."""
    mins = duration_seconds / 60
    cost_twilio     = round(mins * COST_PER_MIN["twilio_outbound"], 6)
    cost_deepgram   = round(mins * COST_PER_MIN["deepgram_nova3"], 6)
    cost_elevenlabs = round(mins * COST_PER_MIN["elevenlabs_turbo"], 6)
    cost_openai     = round(mins * COST_PER_MIN["openai_gpt4o"], 6)
    total           = round(cost_twilio + cost_deepgram + cost_elevenlabs + cost_openai, 6)
    return {
        "cost_twilio":     cost_twilio,
        "cost_deepgram":   cost_deepgram,
        "cost_elevenlabs": cost_elevenlabs,
        "cost_openai":     cost_openai,
        "cost_usd":        total,
    }


def _update_queue(row_id: int, **fields) -> None:
    db.table("call_queue").update(fields).eq("id", row_id).execute()


def _update_campaign_counters(campaign_id: str) -> None:
    """Recalculate campaign counters from call_queue."""
    rows = db.table("call_queue").select("status").eq("campaign_id", campaign_id).execute().data or []
    total    = len(rows)
    called   = sum(1 for r in rows if r["status"] not in ("pending", "calling"))
    answered = sum(1 for r in rows if r["status"] in ("answered", "completed"))
    voicemail = sum(1 for r in rows if r["status"] == "voicemail")
    no_answer = sum(1 for r in rows if r["status"] == "no_answer")
    failed    = sum(1 for r in rows if r["status"] in ("failed", "busy"))

    pending_or_calling = sum(1 for r in rows if r["status"] in ("pending", "calling"))
    new_status = "running" if pending_or_calling > 0 else "completed"

    db.table("campaigns").update({
        "total_numbers": total,
        "called": called,
        "answered": answered,
        "voicemail": voicemail,
        "no_answer": no_answer,
        "failed": failed,
        "status": new_status,
        "completed_at": _now() if new_status == "completed" else None,
    }).eq("id", campaign_id).execute()


# ── Call logic ────────────────────────────────────────────────────────────────

# S2.5 — E.164 format check + country-code allowlist. The CSV upload endpoint
# already does basic E.164 validation, but a compromised service-role key
# could UPDATE call_queue directly with arbitrary numbers (premium-rate
# scams, dialing sanctioned countries, etc.). This guard runs at the dialer
# level so EVERY outbound call passes through it — even rows inserted by
# tools that bypass the upload endpoint.
import re as _re_e164
_E164_RE = _re_e164.compile(r"^\+[1-9]\d{6,14}$")
# Allowed country calling codes (ISO 3166-1 dialing prefix). Add more as
# needed — the Tigo deployment is Panama (507) + US (1). Keep this list
# small to make accidental premium-rate dials hard.
ALLOWED_COUNTRY_CODES = {"1", "507"}


def _validate_e164_or_skip(phone: str) -> tuple[bool, str]:
    """Returns (ok, reason). reason is empty when ok is True."""
    if not phone:
        return False, "empty phone"
    if not isinstance(phone, str):
        return False, "non-string phone"
    if not _E164_RE.match(phone):
        return False, f"not E.164 format: {phone!r}"
    cc = phone[1:].split(" ", 1)[0]  # first 1-3 digits after the +
    # Strip the leading "1" from NANP numbers like +12025550100
    # so they match the "1" country code (NA region).
    if cc.startswith("1") and cc[:1] == "1":
        cc_root = "1"
    else:
        # Extract leading digit block — country codes are 1-3 digits
        for length in (3, 2, 1):
            candidate = phone[1:1 + length]
            if candidate in ALLOWED_COUNTRY_CODES:
                cc_root = candidate
                break
        else:
            return False, f"country code not allowed: +{phone[1:4]}"
    if cc_root not in ALLOWED_COUNTRY_CODES:
        return False, f"country code +{cc_root} not in allowlist"
    return True, ""


async def _dial(row: dict, semaphore: asyncio.Semaphore, outbound_trunk_id: str, agent_id: str | None) -> None:
    """Make a single outbound call and track its result."""
    row_id      = row["id"]
    campaign_id = row["campaign_id"]
    phone       = row["phone_number"]
    name        = row.get("customer_name") or phone
    room_name   = f"call-out-{uuid.uuid4().hex[:10]}"

    # S2.5 — final E.164 + country-code gate before passing to LiveKit/Twilio.
    # Rows that fail the check are marked failed and logged; they do NOT
    # block the rest of the campaign. This protects against a tampered
    # call_queue row trying to dial a premium-rate or sanctioned number.
    ok, reason = _validate_e164_or_skip(phone)
    if not ok:
        logger.warning(f"[S2.5] Skipping dial for {name}: {reason}")
        _update_queue(row_id, status="failed", ended_at=_now(),
                      error_msg=f"blocked by E.164/allowlist: {reason}", attempts=row["attempts"] + 1)
        _update_campaign_counters(campaign_id)
        return

    async with semaphore:
        # S4.1 — redact PII in INFO logs (phone last 4 + name truncated).
        masked_phone = f"***-***-{phone[-4:]}"
        logger.info(f"Dialing {name[:24]} ({masked_phone}) → room {room_name}")
        _update_queue(row_id, status="calling", started_at=_now(), room_name=room_name, attempts=row["attempts"] + 1)

        lkapi = lk_api.LiveKitAPI(url=LIVEKIT_URL, api_key=LIVEKIT_API_KEY, api_secret=LIVEKIT_API_SECRET)
        try:
            # Step 1: Create the room with the agent pre-configured
            # `metadata` carries the DB agent_id so the worker loads that agent's
            # builder config (prompt/voice/models/tools) at session start — see
            # _load_agent_config in services/agent/src/agent.py.
            dispatch_metadata = json.dumps({"agent_id": agent_id}) if agent_id else None
            await lkapi.room.create_room(
                lk_api.CreateRoomRequest(
                    name=room_name,
                    empty_timeout=120,
                    agents=[lk_api.RoomAgentDispatch(agent_name="voice-agent", metadata=dispatch_metadata)],
                )
            )
            logger.info(f"Room created with agent dispatch: {room_name}")

            # Step 3: Create SIP participant (makes the actual phone call)
            await lkapi.sip.create_sip_participant(
                lk_api.CreateSIPParticipantRequest(
                    sip_trunk_id=outbound_trunk_id,
                    sip_call_to=phone,
                    room_name=room_name,
                    participant_identity=f"phone-{phone}",
                    participant_name=name,
                    play_ringtone=True,
                )
            )
        except Exception as e:
            logger.error(f"SIP dial failed for {masked_phone}: {e}")
            _update_queue(row_id, status="failed", ended_at=_now(), error_msg=str(e))
            _update_campaign_counters(campaign_id)
            await lkapi.aclose()
            return

        # Poll room for call outcome
        result = await _wait_for_call_result(lkapi, room_name)
        await lkapi.aclose()

        ended_at = _now()
        duration = 0

        if result["status"] == "answered":
            duration = result.get("duration_seconds", 0)
            costs    = _calculate_call_costs(duration)
            logger.info(f"Call cost for {masked_phone}: ${costs["cost_usd"]:.4f} ({duration}s)")
            _update_queue(row_id,
                status="completed",
                ended_at=ended_at,
                duration_seconds=duration,
                **costs,
            )
        elif result["status"] == "voicemail":
            logger.info(f"[AMD] Call to {masked_phone} → voicemail, marking accordingly")
            _update_queue(row_id,
                status="voicemail",
                ended_at=ended_at,
                duration_seconds=result.get("duration_seconds", 0),
                error_msg=result.get("reason", "voicemail_detected"),
            )
        else:
            _update_queue(row_id,
                status=result["status"],
                ended_at=ended_at,
                error_msg=result.get("reason", ""),
            )

        _update_campaign_counters(campaign_id)
        logger.info(f"Call to {masked_phone} finished: {result["status"]}")


async def _check_session_has_ai_activity(room_name: str) -> dict:
    """
    Return AMD signal info for the LiveKit session backing this room.

    Returns a dict:
        - has_activity: True if `api_usage` has any rows for this session
          (written in real-time by CostLogger as ElevenLabs/Deepgram/OpenAI
          calls happen — unlike `sessions.total_cost_usd` which is only
          updated at the END of the call and would always be 0 mid-call).
        - customer_spoke: True if `sessions.customer_spoke` is true, i.e. the
          human side said something that didn't look like a voicemail/IVR
          prompt (set by the agent in `_mark_customer_spoke_sync`).
        - session_found: False if the session row doesn't exist yet.

    On any DB error, returns has_activity=True/customer_spoke=True/session_found
    so callers don't false-positive hang up a real call.
    """
    loop = asyncio.get_event_loop()
    fallback = {"has_activity": True, "customer_spoke": True, "session_found": True}
    try:
        # Look up the session_id for this room
        session_result = await loop.run_in_executor(
            None,
            lambda: db.table("sessions")
                .select("id, customer_spoke")
                .eq("room_name", room_name)
                .maybe_single()
                .execute()
        )
        if not session_result.data:
            # Session row not yet created — agent may still be loading; assume live
            return {"has_activity": True, "customer_spoke": True, "session_found": False}

        session_id = session_result.data["id"]
        customer_spoke = bool(session_result.data.get("customer_spoke"))

        # Check if any api_usage rows exist for this session (written in real-time)
        usage_result = await loop.run_in_executor(
            None,
            lambda: db.table("api_usage")
                .select("id", count="exact")
                .eq("session_id", session_id)
                .limit(1)
                .execute()
        )
        has_usage = (usage_result.count or 0) > 0
        return {"has_activity": has_usage, "customer_spoke": customer_spoke, "session_found": True}
    except Exception as e:
        logger.warning(f"[AMD] Session activity check failed for {room_name}: {e}")
        # On error, assume activity so we don't false-positive hang up a real call
        return fallback


async def _check_customer_spoke(room_name: str) -> bool:
    """Re-check `sessions.customer_spoke` only (used at the second AMD checkpoint)."""
    loop = asyncio.get_event_loop()
    try:
        session_result = await loop.run_in_executor(
            None,
            lambda: db.table("sessions")
                .select("customer_spoke")
                .eq("room_name", room_name)
                .maybe_single()
                .execute()
        )
        if not session_result.data:
            return True  # assume live if we can't find the row
        return bool(session_result.data.get("customer_spoke"))
    except Exception as e:
        logger.warning(f"[AMD] customer_spoke recheck failed for {room_name}: {e}")
        return True


async def _wait_for_call_result(lkapi: lk_api.LiveKitAPI, room_name: str) -> dict:
    """
    Poll the LiveKit room to determine call outcome.
    Returns dict with status and optional transcript/duration.

    Strategy:
    - Detect "answered" by finding the SIP participant (identity starts with "phone-")
      in the room's participant list — NOT by total count (agent may not be counted).
    - NEVER delete the room while the call is active — let Twilio send BYE naturally.
    - Timeout only if the SIP participant never joins within RING_TIMEOUT_SEC.
    - AMD (Answering Machine Detection): after VOICEMAIL_TIMEOUT seconds with the call
      "answered" but zero AI activity (no ElevenLabs/Deepgram cost, no transcript),
      assume the call went to voicemail and force-hang up.
    """
    elapsed = 0
    answered = False
    answer_time: Optional[float] = None
    sip_was_in_room = False
    amd_checked = False        # First AMD checkpoint (VOICEMAIL_TIMEOUT) done
    amd_pending_recheck = False  # Waiting on second checkpoint (VOICEMAIL_TIMEOUT_EXTENDED)
    amd_pending_final = False    # Waiting on final grace re-check (VOICEMAIL_FINAL_GRACE)

    while True:
        await asyncio.sleep(3)
        elapsed += 3

        try:
            # List participants to detect the SIP participant specifically
            participants = await lkapi.room.list_participants(
                lk_api.ListParticipantsRequest(room=room_name)
            )
            sip_participants = [
                p for p in participants.participants
                if p.identity.startswith("phone-") or p.identity.startswith("sip_")
            ]

            if sip_participants:
                sip_was_in_room = True
                if not answered:
                    answered = True
                    answer_time = asyncio.get_event_loop().time()
                    logger.info(f"Call answered by SIP participant in room {room_name}")

                # ── AMD check ─────────────────────────────────────────────────
                # After VOICEMAIL_TIMEOUT seconds of a connected call, verify the
                # AI pipeline has actually started (ElevenLabs said something or
                # Deepgram heard something). If not → voicemail/machine → hang up.
                #
                # If there IS AI activity but the customer hasn't said anything
                # yet (the AI's own greeting always generates api_usage rows, so
                # `has_activity` alone can't tell apart "live person who hasn't
                # replied yet" from "voicemail recording the greeting silently"),
                # give it a second checkpoint at VOICEMAIL_TIMEOUT_EXTENDED before
                # deciding it's a voicemail.
                elif not amd_checked and answer_time is not None:
                    time_since_answer = asyncio.get_event_loop().time() - answer_time
                    if time_since_answer >= VOICEMAIL_TIMEOUT:
                        amd_checked = True
                        amd = await _check_session_has_ai_activity(room_name)
                        if not amd["has_activity"]:
                            logger.info(
                                f"[AMD] No AI activity after {VOICEMAIL_TIMEOUT}s in {room_name}"
                                f" → voicemail detected, hanging up"
                            )
                            try:
                                await lkapi.room.delete_room(lk_api.DeleteRoomRequest(room=room_name))
                            except Exception:
                                pass
                            return {
                                "status": "voicemail",
                                "reason": "no_ai_activity_timeout",
                                "duration_seconds": int(time_since_answer),
                            }
                        elif not amd["customer_spoke"]:
                            amd_pending_recheck = True
                            logger.info(
                                f"[AMD] AI activity but customer hasn't spoken yet in {room_name}"
                                f" — deferring decision to {VOICEMAIL_TIMEOUT_EXTENDED}s checkpoint"
                            )
                        else:
                            logger.info(f"[AMD] AI activity confirmed in {room_name}, call is live")

                # ── AMD second checkpoint ────────────────────────────────────
                elif amd_pending_recheck and answer_time is not None:
                    time_since_answer = asyncio.get_event_loop().time() - answer_time
                    if time_since_answer >= VOICEMAIL_TIMEOUT_EXTENDED:
                        amd_pending_recheck = False
                        customer_spoke = await _check_customer_spoke(room_name)
                        if customer_spoke:
                            logger.info(f"[AMD] Customer spoke before {VOICEMAIL_TIMEOUT_EXTENDED}s, call is live")
                        else:
                            # Don't hang up immediately — STT finalization + the
                            # async DB write for `customer_spoke` can lag a few
                            # seconds behind the customer actually speaking right
                            # around this checkpoint. Give it one more grace window.
                            amd_pending_final = True
                            logger.info(
                                f"[AMD] Customer hasn't spoken after {VOICEMAIL_TIMEOUT_EXTENDED}s in {room_name}"
                                f" — final grace check in {VOICEMAIL_FINAL_GRACE}s"
                            )

                # ── AMD final grace check ─────────────────────────────────────
                elif amd_pending_final and answer_time is not None:
                    time_since_answer = asyncio.get_event_loop().time() - answer_time
                    if time_since_answer >= VOICEMAIL_TIMEOUT_EXTENDED + VOICEMAIL_FINAL_GRACE:
                        amd_pending_final = False
                        customer_spoke = await _check_customer_spoke(room_name)
                        if not customer_spoke:
                            logger.info(
                                f"[AMD] Customer still hasn't spoken after "
                                f"{VOICEMAIL_TIMEOUT_EXTENDED + VOICEMAIL_FINAL_GRACE}s"
                                f" in {room_name} → voicemail detected, hanging up"
                            )
                            duration = int(time_since_answer)
                            try:
                                await lkapi.room.delete_room(lk_api.DeleteRoomRequest(room=room_name))
                            except Exception:
                                pass
                            return {
                                "status": "voicemail",
                                "reason": "no_customer_speech_timeout",
                                "duration_seconds": duration,
                            }
                        else:
                            logger.info(f"[AMD] Customer spoke during final grace window, call is live")

            elif sip_was_in_room:
                # SIP participant was in room but left — call ended normally
                duration = int(asyncio.get_event_loop().time() - answer_time) if answer_time else 0
                logger.info(f"Call completed normally in room {room_name} (duration ~{duration}s)")
                # Clean up room
                try:
                    await lkapi.room.delete_room(lk_api.DeleteRoomRequest(room=room_name))
                except Exception:
                    pass
                return {"status": "answered", "duration_seconds": duration}

        except Exception as e:
            err_msg = str(e)
            if "room not found" in err_msg.lower() or "not found" in err_msg.lower():
                # Room was deleted externally
                if answered:
                    duration = int(asyncio.get_event_loop().time() - answer_time) if answer_time else 0
                    return {"status": "answered", "duration_seconds": duration}
                elif sip_was_in_room:
                    return {"status": "answered", "duration_seconds": 0}
                else:
                    return {"status": "failed", "reason": "room disappeared before answer"}
            logger.warning(f"Room poll error: {e}")

        # Ring timeout — SIP participant never joined
        if not answered and elapsed >= RING_TIMEOUT_SEC:
            logger.info(f"Ring timeout for room {room_name}, cleaning up")
            try:
                await lkapi.room.delete_room(lk_api.DeleteRoomRequest(room=room_name))
            except Exception:
                pass
            return {"status": "no_answer", "reason": "ring timeout"}

        # Safety max: 15 minutes
        if elapsed >= 900:
            return {"status": "answered", "duration_seconds": elapsed}


# ── Campaign runner ───────────────────────────────────────────────────────────

async def run_campaign(campaign_id: str) -> None:
    """Process all pending calls in a campaign."""
    campaign = db.table("campaigns").select("*").eq("id", campaign_id).single().execute().data
    if not campaign:
        logger.error(f"Campaign {campaign_id} not found")
        return

    # Pre-fetch BYOC trunk if this campaign has one
    if campaign.get("sip_trunk_id"):
        trunk_row = db.table("sip_trunks").select("lk_trunk_id,phone_number,name").eq("id", campaign["sip_trunk_id"]).maybe_single().execute()
        campaign["sip_trunk"] = trunk_row.data or {}
        if campaign["sip_trunk"].get("lk_trunk_id"):
            logger.info(f"Using BYOC trunk '{campaign['sip_trunk'].get('name')}' ({campaign['sip_trunk'].get('phone_number')})")

    max_concurrent = campaign.get("max_concurrent", 3)
    semaphore = asyncio.Semaphore(max_concurrent)
    outbound_trunk_id = _resolve_outbound_trunk_id(campaign)

    logger.info(
        f"Starting campaign '{campaign['name']}' (max {max_concurrent} concurrent, "
        f"trunk={outbound_trunk_id}, caller_id={campaign.get('caller_id_number') or 'default'})"
    )
    db.table("campaigns").update({"status": "running", "started_at": _now()}).eq("id", campaign_id).execute()

    tasks = []
    while True:
        # Check if campaign was paused/cancelled
        current = db.table("campaigns").select("status").eq("id", campaign_id).single().execute().data
        if current and current["status"] in ("paused", "cancelled"):
            logger.info(f"Campaign {campaign_id} {current['status']} — stopping")
            break

        # Fetch next batch of pending calls
        pending = (
            db.table("call_queue")
            .select("*")
            .eq("campaign_id", campaign_id)
            .eq("status", "pending")
            .limit(max_concurrent * 2)
            .execute()
            .data or []
        )

        if not pending:
            # Wait for in-flight calls to finish
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
                tasks = []
            # Check again
            still_pending = db.table("call_queue").select("id").eq("campaign_id", campaign_id).eq("status", "pending").execute().data
            if not still_pending:
                break
            continue

        for row in pending:
            task = asyncio.create_task(_dial(row, semaphore, outbound_trunk_id, campaign.get("agent_id")))
            tasks.append(task)
            # Mark as "calling" immediately to avoid double-dialing
            _update_queue(row["id"], status="calling")

        # Prune completed tasks
        tasks = [t for t in tasks if not t.done()]
        await asyncio.sleep(POLL_INTERVAL)

    # Final wait
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)

    _update_campaign_counters(campaign_id)
    logger.info(f"Campaign {campaign_id} finished")


# ── CLI entry ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python dialer.py <campaign_id>")
        sys.exit(1)
    asyncio.run(run_campaign(sys.argv[1]))
