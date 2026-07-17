-- ─── Phase 3.6 — agent tts_speed column ──────────────────────────────────────
-- Adds a per-agent TTS speed multiplier so admins can speed up voices that
-- sound unnaturally slow without changing the agent's identity.
-- Range is wide enough to cover both ElevenLabs (0.8-1.2) and Inworld
-- (0.5-2.0); the backend clamps to the provider's actual range at runtime.

ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS tts_speed NUMERIC(3, 2) DEFAULT 1.1
    CHECK (tts_speed >= 0.5 AND tts_speed <= 2.0);

COMMENT ON COLUMN public.agents.tts_speed
  IS 'TTS speed multiplier. 1.0=normal, 1.1=10% faster, 0.9=10% slower. Clamped per-provider in agent.py.';