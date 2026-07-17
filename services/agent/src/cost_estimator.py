"""
Predictive cost estimator for LiveKit voice agents.
Given an agent runtime config, returns the estimated USD/min broken down by STT, LLM, TTS.
"""
from __future__ import annotations

import os


# Default conversation assumptions for a 1-minute phone call.
# Override via env vars if your agents have very different patterns.
ASSUMED_AUDIO_SECONDS_PER_MIN = float(os.getenv("ASSUMED_AUDIO_SECONDS_PER_MIN", "60"))
ASSUMED_LLM_TOKENS_PER_MIN = float(os.getenv("ASSUMED_LLM_TOKENS_PER_MIN", "750"))
ASSUMED_TTS_CHARS_PER_MIN = float(os.getenv("ASSUMED_TTS_CHARS_PER_MIN", "750"))


# Provider pricing per unit. Rates verified Q3 2025 — refresh when contracts change.
#   STT/TTS shape: provider -> model_or_default -> {unit, rate}
#   LLM shape:     provider -> model_or_default -> {input, output}  (per 1M tokens)
PRICING: dict = {
    "stt": {
        "deepgram": {
            "nova-3":  {"unit": "second", "rate": 0.0000043},   # $0.0043/min
            "nova-2":  {"unit": "second", "rate": 0.0000043},
            "default": {"unit": "second", "rate": 0.0000050},
        },
        "inworld": {
            "default": {"unit": "second", "rate": 0.0000050},   # est. ~$0.005/min
        },
    },
    "llm": {
        "openai": {
            "gpt-4o":       {"input": 2.50, "output": 10.00},   # per 1M tokens
            "gpt-4o-mini":  {"input": 0.15, "output": 0.60},
            "gpt-4.1":      {"input": 3.00, "output": 12.00},
            "gpt-4.1-mini": {"input": 0.40, "output": 1.60},
            "gpt-5":        {"input": 1.25, "output": 10.00},
            "gpt-5-mini":   {"input": 0.25, "output": 2.00},
            "gpt-5-nano":   {"input": 0.05, "output": 0.40},
            "default":      {"input": 2.50, "output": 10.00},
        },
    },
    "tts": {
        "elevenlabs": {
            "eleven_turbo_v2_5":     {"unit": "char", "rate": 0.00005},   # $0.05/1K
            "eleven_multilingual_v2": {"unit": "char", "rate": 0.00010},
            "default":               {"unit": "char", "rate": 0.00005},
        },
        "inworld": {
            "inworld-tts-1": {"unit": "char", "rate": 0.00005},   # $0.05/1K (observed)
            "default":       {"unit": "char", "rate": 0.00005},
        },
    },
}


def _pick(table: dict, provider: str, model: str | None) -> dict:
    """Look up `provider -> model` in a pricing table, falling back to the
    provider's `default` and finally to a hard-coded fallback so the estimator
    never crashes on an unknown model — it just overestimates with a sensible rate."""
    row = (table.get(provider) or {}).get(model) if model else None
    if row:
        return row
    row = (table.get(provider) or {}).get("default")
    if row:
        return row
    return {"input": 2.50, "output": 10.00} if "input" in str(table) else {"unit": "second", "rate": 0.00001}


def estimate_cost_per_min(cfg: dict) -> dict:
    """
    Estimate per-minute cost for an agent with the given runtime config.
    Returns a dict with per-component USD/min, total, and the assumptions used.
    """
    # STT — billed per audio-second, assume 60s of speech per minute of call
    stt = _pick(PRICING["stt"], cfg.get("stt_provider", "deepgram"), cfg.get("stt_model", "nova-3"))
    stt_per_min = stt["rate"] * ASSUMED_AUDIO_SECONDS_PER_MIN

    # LLM — assume 60/40 input/output split (typical conversational agent)
    llm = _pick(PRICING["llm"], cfg.get("llm_provider", "openai"), cfg.get("llm_model", "gpt-4o"))
    in_tok = ASSUMED_LLM_TOKENS_PER_MIN * 0.6
    out_tok = ASSUMED_LLM_TOKENS_PER_MIN * 0.4
    llm_per_min = (in_tok * llm["input"] + out_tok * llm["output"]) / 1_000_000

    # TTS — billed per character (ElevenLabs, Inworld) or per second
    tts = _pick(PRICING["tts"], cfg.get("tts_provider", "inworld"), cfg.get("tts_model", "inworld-tts-1"))
    if tts["unit"] == "char":
        tts_per_min = tts["rate"] * ASSUMED_TTS_CHARS_PER_MIN
    elif tts["unit"] == "second":
        tts_per_min = tts["rate"] * ASSUMED_AUDIO_SECONDS_PER_MIN
    else:
        tts_per_min = 0.0

    total = stt_per_min + llm_per_min + tts_per_min
    return {
        "stt_per_min":  round(stt_per_min,  5),
        "llm_per_min":  round(llm_per_min,  5),
        "tts_per_min":  round(tts_per_min,  5),
        # Twilio voice only applies when calls are routed over PSTN (SIP trunks).
        # The dashboard "Talk" feature uses LiveKit rooms directly, so it's
        # 0 there — but we always include the key so callers can format
        # the line unconditionally without KeyError. See agent.py:1356.
        "twilio_voice_per_min":  0.0,
        "total_per_min": round(total, 5),
        "currency": "USD",
        "assumptions": {
            "audio_seconds_per_min": ASSUMED_AUDIO_SECONDS_PER_MIN,
            "llm_tokens_per_min":    ASSUMED_LLM_TOKENS_PER_MIN,
            "tts_chars_per_min":     ASSUMED_TTS_CHARS_PER_MIN,
        },
    }


if __name__ == "__main__":
    import json
    import sys
    cfg = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {
        "stt_provider": "deepgram", "stt_model": "nova-3",
        "llm_provider": "openai",   "llm_model":  "gpt-4o",
        "tts_provider": "inworld",  "tts_model":  "inworld-tts-1",
    }
    print(json.dumps(estimate_cost_per_min(cfg), indent=2))
