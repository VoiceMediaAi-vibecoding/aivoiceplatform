-- ─── Phase 3.5 — client_id opcional en agents ────────────────────────────────
-- Permite crear agents sin asignarlos a un cliente (huérfanos / test / shared).
-- RLS se actualiza para que solo admins puedan leer agents huérfanos; los
-- clientes siguen viendo únicamente sus propios agents.

-- 1. Hacer client_id opcional
ALTER TABLE public.agents
  ALTER COLUMN client_id DROP NOT NULL;

-- 2. Actualizar RLS policy: clients ven sus propios agents, admins ven todo
--    (incluyendo huérfanos)
DROP POLICY IF EXISTS agents_tenant_read ON public.agents;
CREATE POLICY agents_tenant_read ON public.agents
  FOR SELECT TO authenticated
  USING (
    -- Caso 1: agent asignado al cliente actual
    client_id IN (
      SELECT id FROM public.clients WHERE supabase_uid = auth.uid()
    )
    OR
    -- Caso 2: agent huérfano → solo visible para admins
    (
      client_id IS NULL
      AND EXISTS (
        SELECT 1 FROM public.admin_users WHERE supabase_uid = auth.uid()
      )
    )
  );

-- 3. Misma lógica para agent_tools / agent_knowledge / agent_versions
DROP POLICY IF EXISTS agent_tools_tenant_read ON public.agent_tools;
CREATE POLICY agent_tools_tenant_read ON public.agent_tools
  FOR SELECT TO authenticated
  USING (
    agent_id IN (
      SELECT a.id FROM public.agents a
      LEFT JOIN public.clients c ON c.id = a.client_id
      WHERE c.supabase_uid = auth.uid()
         OR (a.client_id IS NULL AND EXISTS (
              SELECT 1 FROM public.admin_users WHERE supabase_uid = auth.uid()
            ))
    )
  );

DROP POLICY IF EXISTS agent_knowledge_tenant_read ON public.agent_knowledge;
CREATE POLICY agent_knowledge_tenant_read ON public.agent_knowledge
  FOR SELECT TO authenticated
  USING (
    agent_id IN (
      SELECT a.id FROM public.agents a
      LEFT JOIN public.clients c ON c.id = a.client_id
      WHERE c.supabase_uid = auth.uid()
         OR (a.client_id IS NULL AND EXISTS (
              SELECT 1 FROM public.admin_users WHERE supabase_uid = auth.uid()
            ))
    )
  );

DROP POLICY IF EXISTS agent_versions_tenant_read ON public.agent_versions;
CREATE POLICY agent_versions_tenant_read ON public.agent_versions
  FOR SELECT TO authenticated
  USING (
    agent_id IN (
      SELECT a.id FROM public.agents a
      LEFT JOIN public.clients c ON c.id = a.client_id
      WHERE c.supabase_uid = auth.uid()
         OR (a.client_id IS NULL AND EXISTS (
              SELECT 1 FROM public.admin_users WHERE supabase_uid = auth.uid()
            ))
    )
  );
