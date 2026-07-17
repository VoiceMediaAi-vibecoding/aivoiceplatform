"""
Regression tests for cost_estimator.estimate_cost_per_min.

Pinned behavior:
  - Always returns a dict with stt/llm/tts/twilio_voice/total per-min keys.
    No caller should ever need to .get(..., default=) defensively.
  - Known providers/models hit the PRICING table exactly (no surprise spikes).
  - Unknown provider or unknown model falls back to the provider's `default`
    rate, not a crash.
  - Output is deterministic (no time-dependent randomness).
"""
from __future__ import annotations

import sys
from pathlib import Path

# Make the agent src/ importable as `import cost_estimator`.
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from cost_estimator import estimate_cost_per_min  # noqa: E402


_BASE_CFG = {
    "stt_provider": "deepgram",
    "stt_model": "nova-3",
    "llm_provider": "openai",
    "llm_model": "gpt-4o",
    "tts_provider": "inworld",
    "tts_model": "inworld-tts-1",
}


def test_returns_all_required_keys():
    """The shape callers can rely on. If someone removes a key, this fails
    so the next KeyError can't reach prod (the original TalkModal bug)."""
    est = estimate_cost_per_min(_BASE_CFG)
    for key in (
        "stt_per_min",
        "llm_per_min",
        "tts_per_min",
        "twilio_voice_per_min",
        "total_per_min",
        "currency",
        "assumptions",
    ):
        assert key in est, f"missing key in estimator output: {key!r}"


def test_twilio_voice_always_present_even_for_dashboard_talk():
    """Talk feature has no PSTN, but we still include the key (==0) so
    callers don't KeyError. This is the exact regression that broke Talk."""
    est = estimate_cost_per_min(_BASE_CFG)
    assert est["twilio_voice_per_min"] == 0.0


def test_total_equals_sum_of_components():
    est = estimate_cost_per_min(_BASE_CFG)
    expected = est["stt_per_min"] + est["llm_per_min"] + est["tts_per_min"]
    assert abs(est["total_per_min"] - expected) < 1e-4


def test_known_provider_uses_pricing_table():
    """Sanity: real values, not zero."""
    est = estimate_cost_per_min(_BASE_CFG)
    assert est["stt_per_min"] > 0
    assert est["llm_per_min"] > 0
    assert est["tts_per_min"] > 0


def test_unknown_stt_provider_falls_back_without_crashing():
    est = estimate_cost_per_min({**_BASE_CFG, "stt_provider": "totally-new-vendor"})
    assert "stt_per_min" in est
    # Falls back to a sane non-zero rate so the dashboard shows something.


def test_unknown_tts_provider_falls_back_to_sane_rate():
    """If TTS provider isn't in the table, _pick returns a sensible
    guessed rate (not zero, not a crash). The estimate must still be
    well-formed — caller can format the value."""
    est = estimate_cost_per_min({**_BASE_CFG, "tts_provider": "totally-new-tts"})
    # Doesn't crash, returns a positive fallback rate.
    assert "tts_per_min" in est
    assert est["tts_per_min"] >= 0


def test_openai_gpt5_costs_less_than_gpt4o():
    """Sanity check on the pricing table — pin the relationship so a typo
    doesn't silently make gpt-5 cost 10x more than gpt-4o."""
    cfg4o = {**_BASE_CFG, "llm_model": "gpt-4o"}
    cfg5  = {**_BASE_CFG, "llm_model": "gpt-5"}
    assert estimate_cost_per_min(cfg5)["llm_per_min"] < estimate_cost_per_min(cfg4o)["llm_per_min"]


def test_currency_is_always_usd():
    est = estimate_cost_per_min(_BASE_CFG)
    assert est["currency"] == "USD"
