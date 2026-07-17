-- ─── Phase 3.5 — LiveKit IDs on phone_numbers ─────────────────────────────────
-- Wires the flat phone_numbers catalog to LiveKit SIP resources so the
-- dashboard can import existing Twilio-owned numbers end-to-end:
--
--   Twilio number  →  Twilio Elastic SIP Trunk (shared)
--                 →  LiveKit SipInboundTrunk (lk_inbound_trunk_id)
--                 →  LiveKit SipDispatchRule with metadata.agent_id (lk_dispatch_rule_id)
--
-- Rows without LiveKit IDs are still valid (manual entries, backfill from
-- Phase 3.2 migration). They render in the UI with a "Provisionar" button.

ALTER TABLE public.phone_numbers
  ADD COLUMN IF NOT EXISTS lk_inbound_trunk_id text,
  ADD COLUMN IF NOT EXISTS lk_dispatch_rule_id  text,
  ADD COLUMN IF NOT EXISTS twilio_trunk_sid     text;

CREATE INDEX IF NOT EXISTS phone_numbers_lk_inbound_trunk_id_idx
  ON public.phone_numbers (lk_inbound_trunk_id)
  WHERE lk_inbound_trunk_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS phone_numbers_lk_dispatch_rule_id_idx
  ON public.phone_numbers (lk_dispatch_rule_id)
  WHERE lk_dispatch_rule_id IS NOT NULL;

COMMENT ON COLUMN public.phone_numbers.lk_inbound_trunk_id
  IS 'LiveKit SipInboundTrunk.id assigned to this number';
COMMENT ON COLUMN public.phone_numbers.lk_dispatch_rule_id
  IS 'LiveKit SipDispatchRule.sip_dispatch_rule_id routing to the assigned agent';
COMMENT ON COLUMN public.phone_numbers.twilio_trunk_sid
  IS 'Twilio Elastic SIP Trunk SID that owns this number and routes to LiveKit';
