"""
Logs API usage from each provider and persists to Supabase.
"""
from __future__ import annotations

import os
import asyncio
import logging
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

# Pricing as of 2025 — update these constants to reflect current rates
PRICING = {
    # OpenAI: cost per 1M tokens
    "openai": {
        "gpt-4o": {"input": 2.50, "output": 10.00},
        "gpt-4o-mini": {"input": 0.15, "output": 0.60},
        "gpt-5": {"input": 1.25, "output": 10.00},
        "gpt-5-mini": {"input": 0.25, "output": 2.00},
        "gpt-5-nano": {"input": 0.05, "output": 0.40},
    },
    # Deepgram: cost per minute of audio
    "deepgram": {
        "nova-3": 0.0043,
        "nova-2": 0.0043,
    },
    # ElevenLabs: cost per 1K characters
    "elevenlabs": {
        "eleven_turbo_v2_5": 0.18,
        "eleven_flash_v2_5": 0.11,
    },
    # Inworld STT: cost per minute of audio (TODO: verify against inworld.ai/pricing)
    "inworld_stt": {
        "inworld/inworld-stt-1": 0.0025,
    },
    # Inworld TTS: cost per 1K characters (TODO: verify against inworld.ai/pricing)
    "inworld_tts": {
        "inworld-tts-1": 0.05,
        "inworld-tts-1.5-max": 0.05,
    },
}


@dataclass
class UsageRecord:
    session_id: str
    provider: str
    model: str
    metric_type: str          # tokens_input | tokens_output | audio_seconds | characters
    metric_value: float
    cost_usd: float
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    metadata: dict = field(default_factory=dict)


def _calc_openai_cost(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    rates = PRICING["openai"].get(model, PRICING["openai"]["gpt-4o"])
    return (prompt_tokens / 1_000_000) * rates["input"] + (completion_tokens / 1_000_000) * rates["output"]


def _calc_deepgram_cost(model: str, duration_seconds: float) -> float:
    rate_per_min = PRICING["deepgram"].get(model, 0.0043)
    return (duration_seconds / 60) * rate_per_min


def _calc_elevenlabs_cost(model: str, characters: int) -> float:
    rate_per_k = PRICING["elevenlabs"].get(model, 0.18)
    return (characters / 1000) * rate_per_k


def _calc_inworld_stt_cost(model: str, duration_seconds: float) -> float:
    rate_per_min = PRICING["inworld_stt"].get(model, 0.0025)
    return (duration_seconds / 60) * rate_per_min


def _calc_inworld_tts_cost(model: str, characters: int) -> float:
    rate_per_k = PRICING["inworld_tts"].get(model, 0.05)
    return (characters / 1000) * rate_per_k


class CostLogger:
    def __init__(self, session_id: str):
        self.session_id = session_id
        self._records: list[UsageRecord] = []
        self._supabase = None
        self._init_supabase()

    def _init_supabase(self):
        url = os.getenv("SUPABASE_URL")
        key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        if url and key:
            try:
                from supabase import create_client
                self._supabase = create_client(url, key)
            except Exception as e:
                logger.warning(f"Supabase init failed: {e} — logging to console only")

    def log_openai(self, model: str, prompt_tokens: int, completion_tokens: int):
        cost = _calc_openai_cost(model, prompt_tokens, completion_tokens)
        record = UsageRecord(
            session_id=self.session_id,
            provider="openai",
            model=model,
            metric_type="tokens",
            metric_value=prompt_tokens + completion_tokens,
            cost_usd=cost,
            metadata={"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens},
        )
        self._save(record)

    def log_deepgram(self, model: str, duration_seconds: float):
        cost = _calc_deepgram_cost(model, duration_seconds)
        record = UsageRecord(
            session_id=self.session_id,
            provider="deepgram",
            model=model,
            metric_type="audio_seconds",
            metric_value=duration_seconds,
            cost_usd=cost,
        )
        self._save(record)

    def log_elevenlabs(self, model: str, characters: int):
        cost = _calc_elevenlabs_cost(model, characters)
        record = UsageRecord(
            session_id=self.session_id,
            provider="elevenlabs",
            model=model,
            metric_type="characters",
            metric_value=characters,
            cost_usd=cost,
        )
        self._save(record)

    def log_inworld_stt(self, model: str, duration_seconds: float):
        cost = _calc_inworld_stt_cost(model, duration_seconds)
        record = UsageRecord(
            session_id=self.session_id,
            provider="inworld",
            model=model,
            metric_type="audio_seconds",
            metric_value=duration_seconds,
            cost_usd=cost,
        )
        self._save(record)

    def log_inworld_tts(self, model: str, characters: int):
        cost = _calc_inworld_tts_cost(model, characters)
        record = UsageRecord(
            session_id=self.session_id,
            provider="inworld",
            model=model,
            metric_type="characters",
            metric_value=characters,
            cost_usd=cost,
        )
        self._save(record)

    def _save(self, record: UsageRecord):
        self._records.append(record)
        logger.info(
            f"[cost] {record.provider}/{record.model} "
            f"{record.metric_type}={record.metric_value:.2f} "
            f"cost=${record.cost_usd:.6f}"
        )
        if self._supabase:
            try:
                self._supabase.table("api_usage").insert(asdict(record)).execute()
            except Exception as e:
                logger.error(f"Failed to save usage record to Supabase: {e}")

    @property
    def total_cost(self) -> float:
        return sum(r.cost_usd for r in self._records)

    def session_summary(self) -> dict:
        by_provider: dict[str, float] = {}
        for r in self._records:
            by_provider[r.provider] = by_provider.get(r.provider, 0) + r.cost_usd
        return {"session_id": self.session_id, "total_usd": self.total_cost, "by_provider": by_provider}
