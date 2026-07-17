-- ─── Phase 4 — Post-Call Webhook Server (VAPI-style) ─────────────────────
-- Lets each agent define a post-call webhook URL. When a call ends, the
-- worker generates a call summary (via GPT-4o-mini), assembles an
-- end-of-call report, and POSTs it to that URL with HMAC-SHA256 signing.
--
-- Equivalent to VAPI's "Server URL" feature.

-- Agent-level: webhook destination + HMAC secret (kept as plain text for
-- now; can be encrypted with Fernet later if compliance requires it).
ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS webhook_url TEXT,
  ADD COLUMN IF NOT EXISTS webhook_secret TEXT;

COMMENT ON COLUMN public.agents.webhook_url
  IS 'Endpoint that receives the end-of-call JSON report (HMAC-SHA256 signed). Null = webhook disabled.';
COMMENT ON COLUMN public.agents.webhook_secret
  IS 'Optional HMAC secret. When set, requests include X-Webhook-Signature: sha256=<hex>.';

-- Session-level: accumulation + summary. tool_calls_log mirrors what the
-- worker captured mid-call so the dashboard can replay the full sequence.
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS call_summary TEXT,
  ADD COLUMN IF NOT EXISTS tool_calls_log JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.sessions.call_summary
  IS 'LLM-generated 2-3 sentence summary of the call (or extractive fallback if LLM unavailable).';
COMMENT ON COLUMN public.sessions.tool_calls_log
  IS 'Array of {name, tool_key, called_at, arguments, status, ok, latency_ms, response_preview}.';

-- Audit log for webhook deliveries so admins can see what was sent, retry
-- failures, and debug integration issues from the dashboard.
CREATE TABLE IF NOT EXISTS public.webhook_deliveries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid REFERENCES public.sessions(id) ON DELETE CASCADE,
  agent_id      uuid REFERENCES public.agents(id) ON DELETE CASCADE,
  webhook_url   text NOT NULL,
  status        text NOT NULL,
  http_status   int,
  latency_ms    int,
  attempts      int NOT NULL DEFAULT 1,
  response_body text,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_session_idx ON public.webhook_deliveries (session_id);
CREATE INDEX IF NOT EXISTS webhook_deliveries_agent_idx   ON public.webhook_deliveries (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS webhook_deliveries_status_idx  ON public.webhook_deliveries (status);
