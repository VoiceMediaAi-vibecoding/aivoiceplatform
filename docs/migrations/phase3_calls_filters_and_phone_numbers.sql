-- ─── Phase 3.1 — Calls history filter indexes ────────────────────────────────
-- The /admin/calls endpoint filters on these columns when admin uses the
-- new FilterBar (agent_id, status, date range, campaign via room_name LIKE).
-- Without indexes each query scans all sessions rows.

CREATE INDEX IF NOT EXISTS sessions_started_at_idx
  ON public.sessions (started_at DESC);

CREATE INDEX IF NOT EXISTS sessions_agent_id_idx
  ON public.sessions (agent_id);

CREATE INDEX IF NOT EXISTS sessions_end_reason_idx
  ON public.sessions (end_reason);

-- room_name is already the join key for campaign calls (call-<campaignId>-…)
-- and the phone-derivation key for inbound calls. Filtering on a LIKE prefix
-- uses this index; full-text search would need a trigram index instead.
CREATE INDEX IF NOT EXISTS sessions_room_name_idx
  ON public.sessions (room_name);

-- ─── Phase 3.2 — Phone Numbers section ──────────────────────────────────────
-- A dedicated flat list of provisioned numbers (Twilio or other providers),
-- decoupled from the SIP-trunk credential layer. Trunks optionally reference
-- a phone_number for display in the new /admin/phone-numbers page.

CREATE TABLE IF NOT EXISTS public.phone_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,           -- E.164, e.g. "+5072023503"
  label text,                            -- human-friendly ("Línea principal Panama")
  provider text NOT NULL,                -- "twilio_pa" | "twilio_us" | "manual"
  provider_sid text,                     -- Twilio IncomingPhoneNumber SID (PNxxxx…)
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {"voice":true,"sms":false,...}
  agent_id uuid REFERENCES public.agents(id) ON DELETE SET NULL,
  client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  campaign_id uuid REFERENCES public.campaigns(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS phone_numbers_agent_id_idx
  ON public.phone_numbers (agent_id);
CREATE INDEX IF NOT EXISTS phone_numbers_client_id_idx
  ON public.phone_numbers (client_id);
CREATE INDEX IF NOT EXISTS phone_numbers_is_active_idx
  ON public.phone_numbers (is_active);

-- Optional FK from existing sip_trunks to phone_numbers. Lets the trunk
-- page show the friendly label instead of just the raw E.164 number.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sip_trunks' AND column_name = 'phone_number_id'
  ) THEN
    ALTER TABLE public.sip_trunks
      ADD COLUMN phone_number_id uuid REFERENCES public.phone_numbers(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ─── Backfill: pull existing numbers out of sip_trunks into phone_numbers ──
-- One-time migration: any trunk with a phone_number becomes a phone_numbers
-- row. The UPDATE below wires up sip_trunks.phone_number_id to point at the
-- newly-created row. ON CONFLICT (number) DO NOTHING skips duplicates.

INSERT INTO public.phone_numbers (number, label, provider, is_active)
SELECT
  st.phone_number,
  COALESCE(st.name, st.phone_number) AS label,
  CASE
    WHEN st.lk_trunk_id LIKE 'ST_%' THEN 'manual'
    ELSE 'twilio_us'
  END AS provider,
  st.is_active
FROM public.sip_trunks st
WHERE st.phone_number IS NOT NULL AND st.phone_number <> ''
ON CONFLICT (number) DO NOTHING;

UPDATE public.sip_trunks st
SET phone_number_id = pn.id
FROM public.phone_numbers pn
WHERE pn.number = st.phone_number
  AND st.phone_number_id IS NULL;