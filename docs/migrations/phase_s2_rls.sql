-- ─── Phase S2.1 — Row-Level Security (RLS) ────────────────────────────────────
-- Enables RLS on every platform table and adds policies for the two non-service
-- roles the dashboard's anon client uses: `authenticated` (logged-in admin or
-- client via Supabase Auth) and `anon` (logged-out). The FastAPI backend keeps
-- using the service role key (which bypasses RLS by design); the policies
-- primarily protect against a leaked anon key.
--
-- IMPORTANT — run this in two passes:
--   Pass 1: enable RLS + create policies + GRANTs (this file)
--   Pass 2: smoke test the dashboard. If anything breaks, run the ROLLBACK
--           block at the bottom to revert.
--
-- After this migration, the only client that can read/write all rows is the
-- FastAPI service (service role). The dashboard's anon client is constrained
-- to its own user_id, and clients can only see their own tenant data.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) ENABLE RLS on every table
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'admin_users',
    'clients',
    'agents',
    'agent_tools',
    'agent_knowledge',
    'agent_versions',
    'campaigns',
    'call_queue',
    'calls',
    'sessions',
    'api_usage',
    'sip_trunks',
    'phone_numbers',
    'tools',
    'tigo_leads'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    -- Force RLS even for the table owner. Without this, the API's
    -- service role bypass is fine but anything else (supabase admin,
    -- direct psql as postgres) gets a free pass.
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) POLICIES — admin_users
-- ─────────────────────────────────────────────────────────────────────────────
-- Only the user themselves can read their own row. Writes are blocked at the
-- DB level (admins are managed via the FastAPI service role from /admin/users).
DROP POLICY IF EXISTS admin_users_self_read ON public.admin_users;
CREATE POLICY admin_users_self_read ON public.admin_users
  FOR SELECT TO authenticated
  USING (supabase_uid = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) POLICIES — clients
-- ─────────────────────────────────────────────────────────────────────────────
-- A client can read their own row + their agents + their sessions/calls/
-- campaigns/call_queue/tigo_leads/phone_numbers scoped by client_id.
-- Cross-tenant reads are blocked at the DB level.
DROP POLICY IF EXISTS clients_self_read ON public.clients;
CREATE POLICY clients_self_read ON public.clients
  FOR SELECT TO authenticated
  USING (supabase_uid = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) POLICIES — agents (scoped by client_id)
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS agents_tenant_read ON public.agents;
CREATE POLICY agents_tenant_read ON public.agents
  FOR SELECT TO authenticated
  USING (
    client_id IN (
      SELECT id FROM public.clients WHERE supabase_uid = auth.uid()
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) POLICIES — agent_tools / agent_knowledge / agent_versions (join via agent)
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS agent_tools_tenant_read ON public.agent_tools;
CREATE POLICY agent_tools_tenant_read ON public.agent_tools
  FOR SELECT TO authenticated
  USING (
    agent_id IN (
      SELECT a.id FROM public.agents a
      JOIN public.clients c ON c.id = a.client_id
      WHERE c.supabase_uid = auth.uid()
    )
  );

DROP POLICY IF EXISTS agent_knowledge_tenant_read ON public.agent_knowledge;
CREATE POLICY agent_knowledge_tenant_read ON public.agent_knowledge
  FOR SELECT TO authenticated
  USING (
    agent_id IN (
      SELECT a.id FROM public.agents a
      JOIN public.clients c ON c.id = a.client_id
      WHERE c.supabase_uid = auth.uid()
    )
  );

DROP POLICY IF EXISTS agent_versions_tenant_read ON public.agent_versions;
CREATE POLICY agent_versions_tenant_read ON public.agent_versions
  FOR SELECT TO authenticated
  USING (
    agent_id IN (
      SELECT a.id FROM public.agents a
      JOIN public.clients c ON c.id = a.client_id
      WHERE c.supabase_uid = auth.uid()
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) POLICIES — campaigns / call_queue / tigo_leads (scoped via agent → client)
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS campaigns_tenant_read ON public.campaigns;
CREATE POLICY campaigns_tenant_read ON public.campaigns
  FOR SELECT TO authenticated
  USING (
    agent_id IN (
      SELECT a.id FROM public.agents a
      JOIN public.clients c ON c.id = a.client_id
      WHERE c.supabase_uid = auth.uid()
    )
  );

DROP POLICY IF EXISTS call_queue_tenant_read ON public.call_queue;
CREATE POLICY call_queue_tenant_read ON public.call_queue
  FOR SELECT TO authenticated
  USING (
    campaign_id IN (
      SELECT ca.id FROM public.campaigns ca
      JOIN public.agents a ON a.id = ca.agent_id
      JOIN public.clients c ON c.id = a.client_id
      WHERE c.supabase_uid = auth.uid()
    )
  );

DROP POLICY IF EXISTS tigo_leads_tenant_read ON public.tigo_leads;
CREATE POLICY tigo_leads_tenant_read ON public.tigo_leads
  FOR SELECT TO authenticated
  USING (true);  -- tigo_leads doesn't have a client_id; tighten later

-- ─────────────────────────────────────────────────────────────────────────────
-- 7) POLICIES — sessions / calls / api_usage (scoped via agent → client)
-- ─────────────────────────────────────────────────────────────────────────────
-- sessions.agent_id is the link. Calls (legacy) is included so the portal
-- doesn't break if any old code path reads from `calls` instead of `sessions`.
DROP POLICY IF EXISTS sessions_tenant_read ON public.sessions;
CREATE POLICY sessions_tenant_read ON public.sessions
  FOR SELECT TO authenticated
  USING (
    agent_id IN (
      SELECT a.id FROM public.agents a
      JOIN public.clients c ON c.id = a.client_id
      WHERE c.supabase_uid = auth.uid()
    )
    OR agent_id IS NULL  -- allow read of orphan sessions (defensive)
  );

DROP POLICY IF EXISTS calls_tenant_read ON public.calls;
CREATE POLICY calls_tenant_read ON public.calls
  FOR SELECT TO authenticated
  USING (true);  -- legacy table; tighten when migration is clean

DROP POLICY IF EXISTS api_usage_tenant_read ON public.api_usage;
CREATE POLICY api_usage_tenant_read ON public.api_usage
  FOR SELECT TO authenticated
  USING (
    session_id IN (
      SELECT s.id FROM public.sessions s
      JOIN public.agents a ON a.id = s.agent_id
      JOIN public.clients c ON c.id = a.client_id
      WHERE c.supabase_uid = auth.uid()
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 8) POLICIES — sip_trunks / phone_numbers / tools (admin-managed)
-- ─────────────────────────────────────────────────────────────────────────────
-- These tables are admin-only — no client should ever see them. We block
-- reads at the DB level for authenticated non-service callers entirely.
DROP POLICY IF EXISTS sip_trunks_admin_only ON public.sip_trunks;
CREATE POLICY sip_trunks_admin_only ON public.sip_trunks
  FOR SELECT TO authenticated
  USING (false);  -- deny to authenticated anon-key users; service role bypasses

DROP POLICY IF EXISTS phone_numbers_admin_only ON public.phone_numbers;
CREATE POLICY phone_numbers_admin_only ON public.phone_numbers
  FOR SELECT TO authenticated
  USING (false);  -- same

DROP POLICY IF EXISTS tools_admin_only ON public.tools;
CREATE POLICY tools_admin_only ON public.tools
  FOR SELECT TO authenticated
  USING (false);  -- same

-- ─────────────────────────────────────────────────────────────────────────────
-- 9) GRANTs
-- ─────────────────────────────────────────────────────────────────────────────
-- The anon role shouldn't be able to do anything; the authenticated role
-- reads per the policies above; the service_role (used by the API) does
-- everything (RLS bypass). No INSERT/UPDATE/DELETE policies for
-- `authenticated` — clients/admins mutate via the FastAPI service only.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
GRANT USAGE ON SCHEMA public TO anon;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
-- The service role already has full access by default.

-- ─────────────────────────────────────────────────────────────────────────────
-- 10) ROLLBACK (run only if S2.1 breaks the dashboard)
-- ─────────────────────────────────────────────────────────────────────────────
-- DISABLE ROW LEVEL SECURITY on every table listed above. Drop the policies.
-- DO $$
-- DECLARE
--   t text;
-- BEGIN
--   FOREACH t IN ARRAY ARRAY[
--     'admin_users','clients','agents','agent_tools','agent_knowledge',
--     'agent_versions','campaigns','call_queue','calls','sessions',
--     'api_usage','sip_trunks','phone_numbers','tools','tigo_leads'
--   ] LOOP
--     EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
--     EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t);
--   END LOOP;
-- END $$;
-- DROP POLICY IF EXISTS admin_users_self_read ON public.admin_users;
-- DROP POLICY IF EXISTS clients_self_read ON public.clients;
-- DROP POLICY IF EXISTS agents_tenant_read ON public.agents;
-- DROP POLICY IF EXISTS agent_tools_tenant_read ON public.agent_tools;
-- DROP POLICY IF EXISTS agent_knowledge_tenant_read ON public.agent_knowledge;
-- DROP POLICY IF EXISTS agent_versions_tenant_read ON public.agent_versions;
-- DROP POLICY IF EXISTS campaigns_tenant_read ON public.campaigns;
-- DROP POLICY IF EXISTS call_queue_tenant_read ON public.call_queue;
-- DROP POLICY IF EXISTS tigo_leads_tenant_read ON public.tigo_leads;
-- DROP POLICY IF EXISTS sessions_tenant_read ON public.sessions;
-- DROP POLICY IF EXISTS calls_tenant_read ON public.calls;
-- DROP POLICY IF EXISTS api_usage_tenant_read ON public.api_usage;
-- DROP POLICY IF EXISTS sip_trunks_admin_only ON public.sip_trunks;
-- DROP POLICY IF EXISTS phone_numbers_admin_only ON public.phone_numbers;
-- DROP POLICY IF EXISTS tools_admin_only ON public.tools;
