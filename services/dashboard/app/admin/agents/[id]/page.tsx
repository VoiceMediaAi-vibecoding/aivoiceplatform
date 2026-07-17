"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { adminFetch } from "@/lib/admin-auth";
import AdminAuthGuard from "@/app/admin/AdminAuthGuard";
import AppShell from "@/components/AppShell";
import StatusPill from "@/components/ui/StatusPill";
import { type AgentDetail, type Notify } from "./types";
import ModelVoiceTab from "./ModelVoiceTab";
import BehaviorTab from "./BehaviorTab";
import PromptTab from "./PromptTab";
import ToolsTab from "./ToolsTab";
import KnowledgeTab from "./KnowledgeTab";
import VersionsTab from "./VersionsTab";
import PlaygroundTab from "./PlaygroundTab";
import WebhooksTab from "./WebhooksTab";
import CostTab from "./CostTab";
import TalkModal from "./TalkModal";
import CallLogsDrawer from "./CallLogsDrawer";
import PhoneNumberModal from "./PhoneNumberModal";
import { Phone } from "lucide-react";

const TABS = [
  { key: "prompt", label: "Prompt y saludo", icon: "✎" },
  { key: "model", label: "Modelo y voz", icon: "◈" },
  { key: "behavior", label: "Comportamiento", icon: "⏱" },
  { key: "tools", label: "Herramientas", icon: "⚙" },
  { key: "knowledge", label: "Base de conocimiento", icon: "▤" },
  { key: "versions", label: "Versiones", icon: "↺" },
  { key: "playground", label: "Playground", icon: "▶" },
  { key: "webhooks", label: "Webhooks", icon: "🪝" },
  { key: "cost",     label: "Costos",    icon: "💰" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

/**
 * VAPI-style agent builder — full control over a single agent's runtime
 * persona: prompt, models, voice, tools, knowledge base, version history and
 * a text playground to iterate without placing real calls.
 */
function AgentBuilderContent() {
  const params = useParams<{ id: string }>();
  const agentId = params.id;

  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabKey>("prompt");
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [togglingActive, setTogglingActive] = useState(false);
  const [showTalk, setShowTalk] = useState(false);
  const [showCallLogs, setShowCallLogs] = useState(false);
  const [showPhoneModal, setShowPhoneModal] = useState(false);
  const [duplicating, setDuplicating] = useState(false);

  const notify: Notify = (type, text) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 4500);
  };

  const fetchAgent = useCallback(async () => {
    try {
      setAgent(await adminFetch<AgentDetail>(`/admin/agents/${agentId}`));
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "No se pudo cargar el agente"}`);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    fetchAgent();
  }, [fetchAgent]);

  const toggleActive = async () => {
    if (!agent) return;
    setTogglingActive(true);
    try {
      await adminFetch(`/admin/agents/${agentId}`, {
        method: "PATCH",
        body: JSON.stringify({ is_active: !agent.is_active }),
      });
      notify("ok", `✅ Agente ${!agent.is_active ? "activado" : "pausado"}`);
      fetchAgent();
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error al actualizar"}`);
    } finally {
      setTogglingActive(false);
    }
  };

  const handleDuplicate = async () => {
    if (!agent) return;
    if (!confirm(`¿Duplicar el agente "${agent.name}"? Se creará una copia idéntica (config, tools, knowledge) llamada "${agent.name} (Copia)" que empezará pausada.`)) {
      return;
    }
    setDuplicating(true);
    try {
      const newAgent = await adminFetch<{ id: string; name: string }>(
        `/admin/agents/${agentId}/duplicate`,
        { method: "POST" },
      );
      notify("ok", `✅ Duplicado: "${newAgent.name}"`);
      // Navigate to the new agent's builder so the user can immediately start tweaking
      window.location.href = `/admin/agents/${newAgent.id}`;
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error al duplicar"}`);
    } finally {
      setDuplicating(false);
    }
  };

  if (loading) {
    return (
      <AppShell title="Constructor de agente" description="Cargando…">
        <div className="text-sm text-gray-500">Cargando configuración del agente…</div>
      </AppShell>
    );
  }

  if (!agent) {
    return (
      <AppShell title="Constructor de agente" description="No se encontró el agente">
        <Link href="/admin/agents" className="text-sm text-fuchsia-300 hover:text-fuchsia-200">
          ← Volver a agentes
        </Link>
      </AppShell>
    );
  }

  return (
    <AppShell
      title={agent.name}
      description={agent.description || "Constructor de agente — control total estilo VAPI"}
    >
      {/* Header / identity bar */}
      <div className="glass-card rounded-2xl p-5 mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3 flex-wrap">
          <Link href="/admin/agents" className="text-sm text-gray-400 hover:text-gray-200 transition-colors">
            ← Agentes
          </Link>
          <span className="text-gray-700">/</span>
          <span className="text-sm font-medium text-gray-100">{agent.name}</span>
          <StatusPill label={agent.is_active ? "activo" : "pausado"} tone={agent.is_active ? "active" : "neutral"} pulse={agent.is_active} />
          <StatusPill label={agent.clients?.name ?? "sin cliente"} tone="info" />
          <code className="text-[11px] text-gray-500 bg-black/30 px-2 py-1 rounded">{agent.lk_agent_name}</code>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => {
              navigator.clipboard.writeText(agent.id);
              notify("ok", "✅ ID copiado al portapapeles");
            }}
            className="text-xs px-3 py-1.5 bg-white/5 hover:bg-white/10 rounded-lg transition-colors font-mono"
            title={agent.id}
          >
            📋 {agent.id.slice(0, 8)}…
          </button>
          <button
            onClick={() => setShowTalk(true)}
            className="text-xs px-3 py-1.5 rounded-lg font-medium transition-colors bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
            title="Probar el agente con su config actual (voz, prompt, tools)"
          >
            🎙 Talk
          </button>
          <button
            onClick={() => setShowPhoneModal(true)}
            className="text-xs px-3 py-1.5 rounded-lg font-medium transition-colors bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500/25 flex items-center gap-1"
            title="Agregar un número de teléfono (crea inbound trunk + dispatch rule automáticamente)"
          >
            <Phone className="w-3 h-3" /> + Número
          </button>
          <button
            onClick={() => setShowCallLogs(true)}
            className="text-xs px-3 py-1.5 rounded-lg font-medium transition-colors bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500/25"
            title="Ver el historial de llamadas de este agente"
          >
            📞 Call Logs
          </button>
          <button
            onClick={handleDuplicate}
            disabled={duplicating}
            className="text-xs px-3 py-1.5 rounded-lg font-medium transition-colors bg-indigo-500/15 text-indigo-300 hover:bg-indigo-500/25 disabled:opacity-40"
            title="Crear una copia idéntica (config, tools, knowledge)"
          >
            {duplicating ? "⏳ Duplicando…" : "⎘ Duplicar"}
          </button>
          <button
            onClick={toggleActive}
            disabled={togglingActive}
            className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors disabled:opacity-40 ${
              agent.is_active
                ? "bg-amber-500/15 text-amber-300 hover:bg-amber-500/25"
                : "bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
            }`}
          >
            {agent.is_active ? "⏸ Pausar" : "▶ Activar"}
          </button>
        </div>
      </div>

      {/* Toast */}
      {msg && (
        <div
          className={`mb-4 p-3 rounded-lg text-sm border flex justify-between items-center ${
            msg.type === "ok" ? "bg-emerald-900/20 border-emerald-700/40 text-emerald-300" : "bg-rose-900/20 border-rose-700/40 text-rose-300"
          }`}
        >
          {msg.text}
          <button onClick={() => setMsg(null)} className="ml-3 opacity-60 hover:opacity-100">✕</button>
        </div>
      )}

      {/* Tab navigation */}
      <div className="flex flex-wrap gap-1.5 mb-5 border-b border-white/10 pb-3">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3.5 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 ${
              tab === t.key ? "bg-brand-pink text-white" : "text-gray-400 hover:text-gray-200 hover:bg-white/5"
            }`}
          >
            <span className="opacity-70">{t.icon}</span>
            {t.label}
            {t.key === "tools" && agent.tools.length > 0 && (
              <span className="text-[10px] bg-white/10 px-1.5 py-0.5 rounded-full">{agent.tools.length}</span>
            )}
            {t.key === "knowledge" && agent.knowledge.length > 0 && (
              <span className="text-[10px] bg-white/10 px-1.5 py-0.5 rounded-full">{agent.knowledge.length}</span>
            )}
            {t.key === "versions" && agent.version_count > 0 && (
              <span className="text-[10px] bg-white/10 px-1.5 py-0.5 rounded-full">{agent.version_count}</span>
            )}
          </button>
        ))}
      </div>

      {/* Active tab */}
      <div className="glass-card rounded-2xl p-6">
        {tab === "prompt" && <PromptTab agent={agent} agentId={agentId} onRefresh={fetchAgent} notify={notify} />}
        {tab === "model" && <ModelVoiceTab agent={agent} agentId={agentId} onRefresh={fetchAgent} notify={notify} />}
        {tab === "behavior" && <BehaviorTab agent={agent} agentId={agentId} onRefresh={fetchAgent} notify={notify} />}
        {tab === "tools" && <ToolsTab agent={agent} agentId={agentId} onRefresh={fetchAgent} notify={notify} />}
        {tab === "knowledge" && <KnowledgeTab agent={agent} agentId={agentId} onRefresh={fetchAgent} notify={notify} />}
        {tab === "versions" && <VersionsTab agent={agent} agentId={agentId} onRefresh={fetchAgent} notify={notify} />}
        {tab === "playground" && <PlaygroundTab agent={agent} agentId={agentId} onRefresh={fetchAgent} notify={notify} />}
        {tab === "webhooks" && <WebhooksTab agent={agent} agentId={agentId} onRefresh={fetchAgent} notify={notify} />}
        {tab === "cost"     && <CostTab agentId={agentId} agentName={agent.name} />}
      </div>

      {/* Quick-action modals / drawers */}
      {showTalk && (
        <TalkModal
          agentId={agentId}
          agentName={agent.name}
          isActive={agent.is_active}
          onClose={() => setShowTalk(false)}
        />
      )}
      <CallLogsDrawer
        agentId={agentId}
        agentName={agent.name}
        open={showCallLogs}
        onClose={() => setShowCallLogs(false)}
      />
      {showPhoneModal && (
        <PhoneNumberModal
          agentId={agentId}
          agentName={agent.name}
          onClose={() => setShowPhoneModal(false)}
          onAdded={() => {
            notify("ok", "✅ Número agregado — listo para recibir llamadas");
            fetchAgent();
          }}
        />
      )}
    </AppShell>
  );
}

export default function AgentBuilderPage() {
  return (
    <AdminAuthGuard>
      <AgentBuilderContent />
    </AdminAuthGuard>
  );
}
