-- ─── Phase 3.7 — Inworld TTS fine-tuning knobs ───────────────────────────────
-- Adds per-agent controls for Inworld's advanced TTS parameters so admins
-- can tune voice stability, expressiveness, text normalization, delivery
-- style, and streaming latency without leaving the dashboard.
--
-- All fields are NULLABLE (use Inworld defaults when not set).

ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS tts_temperature NUMERIC(3, 2)
    CHECK (tts_temperature IS NULL OR (tts_temperature >= 0 AND tts_temperature <= 2)),
  ADD COLUMN IF NOT EXISTS tts_text_normalization BOOLEAN,
  ADD COLUMN IF NOT EXISTS tts_delivery_mode TEXT
    CHECK (tts_delivery_mode IS NULL OR tts_delivery_mode IN ('STABLE','BALANCED','CREATIVE')),
  ADD COLUMN IF NOT EXISTS tts_buffer_char_threshold INTEGER
    CHECK (tts_buffer_char_threshold IS NULL OR tts_buffer_char_threshold >= 100),
  ADD COLUMN IF NOT EXISTS tts_max_buffer_delay_ms INTEGER
    CHECK (tts_max_buffer_delay_ms IS NULL OR tts_max_buffer_delay_ms >= 100);

COMMENT ON COLUMN public.agents.tts_temperature
  IS 'Inworld voice generation randomness. 0.0=stable/monotone, 2.0=expressive/dramatic. Default 1.0. Only inworld-tts-2.';
COMMENT ON COLUMN public.agents.tts_text_normalization
  IS 'true=ON (Dr. → Doctor), false=OFF, NULL=auto. Recommended ON for phone calls.';
COMMENT ON COLUMN public.agents.tts_delivery_mode
  IS 'STABLE|BALANCED|CREATIVE. Only honored by inworld-tts-2.';
COMMENT ON COLUMN public.agents.tts_buffer_char_threshold
  IS 'Minimum chars buffered before triggering audio generation. Lower = less latency, default 1000.';
COMMENT ON COLUMN public.agents.tts_max_buffer_delay_ms
  IS 'Maximum ms to wait for more text before flushing. Lower = less latency, default 3000.';