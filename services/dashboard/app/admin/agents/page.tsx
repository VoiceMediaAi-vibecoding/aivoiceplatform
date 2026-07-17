"use client";

import React, { useEffect, useState, useCallback } from "react";
import { adminFetch } from "@/lib/admin-auth";
import AdminAuthGuard from "@/app/admin/AdminAuthGuard";
import AppShell from "@/components/AppShell";
import GlassCard from "@/components/ui/GlassCard";
import StatusPill from "@/components/ui/StatusPill";
import ModelVoiceForm, { type ModelVoiceValue } from "./[id]/ModelVoiceForm";

interface Client {
  id: string;
  name: string;
  email: string;
}

interface Agent {
  id: string;
  client_id: string | null;
  name: string;
  voice_id: string | null;
  lk_agent_name: string;
  is_active: boolean;
  created_at: string;
  clients: Client | null;
}

const DEFAULT_VOICE = "6uZeZ0TKIeJahuKIBwp7";

const DEFAULT_CREATE_CONFIG: ModelVoiceValue = {
  llm_model: "gpt-4o",
  stt_provider: "deepgram",
  tts_provider: "elevenlabs",
  stt_model: "nova-3",
  tts_model: "eleven_turbo_v2_5",
  voice_id: DEFAULT_VOICE,
  language: "es",
  temperature: 0.7,
  tts_speed: 1.1,
  tts_temperature: null,
  tts_text_normalization: null,
  tts_delivery_mode: null,
  tts_buffer_char_threshold: null,
  tts_max_buffer_delay_ms: null,
};

function AgentsPageContent() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [selected, setSelected] = useState<Agent | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // Create form
  const [newName, setNewName] = useState("");
  const [newClientId, setNewClientId] = useState("");
  const [newLkName, setNewLkName] = useState("voice-agent");
  const [createConfig, setCreateConfig] = useState<ModelVoiceValue>(DEFAULT_CREATE_CONFIG);

  // Edit form
  const [editName, setEditName] = useState("");
  const [editVoiceId, setEditVoiceId] = useState("");
  const [editLkName, setEditLkName] = useState("");
  const [editActive, setEditActive] = useState(true);
  // editClientId === "" means "sin asignar" (will be sent as client_id: null
  // in the PATCH). Initialized in openEdit() from the selected agent.
  const [editClientId, setEditClientId] = useState("");

  const fetchAgents = useCallback(async () => {
    try {
      setAgents(await adminFetch<Agent[]>("/admin/agents"));
    } catch {
      // adminFetch already redirects to login on 401
    }
  }, []);

  const fetchClients = useCallback(async () => {
    try {
      setClients(await adminFetch<{ id: string; name: string; email: string }[]>("/admin/clients"));
    } catch {
      // adminFetch already redirects to login on 401
    }
  }, []);

  useEffect(() => {
    fetchAgents();
    fetchClients();
  }, [fetchAgents, fetchClients]);

  const notify = (type: "ok" | "err", text: string) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 4000);
  };

  const createAgent = async () => {
    if (!newName.trim()) return;
    try {
      await adminFetch("/admin/agents", {
        method: "POST",
        body: JSON.stringify({
          name: newName,
          voice_id: createConfig.voice_id || null,
          client_id: newClientId || null,
          lk_agent_name: newLkName,
          llm_model: createConfig.llm_model,
          stt_provider: createConfig.stt_provider,
          tts_provider: createConfig.tts_provider,
          stt_model: createConfig.stt_model,
          tts_model: createConfig.tts_model,
          language: createConfig.language,
          temperature: createConfig.temperature,
          tts_speed: createConfig.tts_speed,
          tts_temperature: createConfig.tts_temperature,
          tts_text_normalization: createConfig.tts_text_normalization,
          tts_delivery_mode: createConfig.tts_delivery_mode,
          tts_buffer_char_threshold: createConfig.tts_buffer_char_threshold,
          tts_max_buffer_delay_ms: createConfig.tts_max_buffer_delay_ms,
        }),
      });
      notify("ok", "✅ Agente creado");
      setCreating(false);
      setNewName("");
      setNewClientId("");
      setNewLkName("voice-agent");
      setCreateConfig(DEFAULT_CREATE_CONFIG);
      fetchAgents();
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error al crear"}`);
    }
  };

  const openEdit = (agent: Agent) => {
    setEditName(agent.name);
    setEditVoiceId(agent.voice_id ?? "");
    setEditLkName(agent.lk_agent_name);
    setEditActive(agent.is_active);
    // Pre-select the current client (if any). Empty string = sin asignar.
    setEditClientId(agent.client_id ?? "");
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!selected) return;
    try {
      // client_id uses the "" → null convention. The PATCH endpoint
      // distinguishes "field not sent" from "field sent as null" via
      // model_dump(exclude_unset=True), so this only fires reassignment
      // when the dropdown actually changed from the current value.
      const body: Record<string, unknown> = {
        name: editName,
        voice_id: editVoiceId || null,
        lk_agent_name: editLkName,
        is_active: editActive,
      };
      const initialClient = selected.client_id ?? "";
      if (editClientId !== initialClient) {
        body.client_id = editClientId === "" ? null : editClientId;
      }
      await adminFetch(`/admin/agents/${selected.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      notify("ok", "✅ Agente actualizado");
      setEditing(false);
      fetchAgents();
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error al guardar"}`);
    }
  };

  const deleteAgent = async (id: string) => {
    if (!confirm("¿Eliminar este agente?")) return;
    try {
      await adminFetch(`/admin/agents/${id}`, { method: "DELETE" });
      notify("ok", "✅ Agente eliminado");
      if (selected?.id === id) setSelected(null);
      fetchAgents();
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error al eliminar"}`);
    }
  };

  const fmt = (s: string) => new Date(s).toLocaleDateString("es-MX", { day: "2-digit", month: "short", year: "numeric" });

  return (
    <AppShell title="Agentes de Voz" description="Crea y gestiona los agentes vinculados a tus clientes">
      <div className="flex justify-end mb-6">
          <button
            onClick={() => setCreating(true)}
            className="px-4 py-2 bg-brand-pink hover:bg-brand-purple rounded-lg text-sm font-medium transition-colors"
          >
            + Nuevo agente
          </button>
        </div>

        {/* Notification */}
        {msg && (
          <div className={`mb-4 p-3 rounded-lg text-sm border flex justify-between items-center ${msg.type === "ok" ? "bg-emerald-500/10 border-emerald-400/20 text-emerald-300" : "bg-rose-500/10 border-rose-400/20 text-rose-300"}`}>
            {msg.text}
            <button onClick={() => setMsg(null)} className="ml-3 opacity-60 hover:opacity-100">✕</button>
          </div>
        )}

        {/* Create modal */}
        {creating && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 overflow-y-auto py-8">
            <div className="glass-card rounded-2xl p-6 w-[640px] max-w-[92vw]">
              <h2 className="font-semibold text-lg mb-5 text-gray-100">Nuevo agente</h2>

              <div className="grid grid-cols-2 gap-3 mb-4">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Nombre del agente</label>
                  <input
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    placeholder="Ej: Camila"
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-pink/60"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Cliente</label>
                  <select
                    value={newClientId}
                    onChange={e => setNewClientId(e.target.value)}
                    className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-brand-pink/60"
                  >
                    <option value="">— Sin cliente (huérfano) —</option>
                    <option disabled value="">──────────────</option>
                    {clients.map(c => (
                      <option key={c.id} value={c.id}>{c.name} ({c.email})</option>
                    ))}
                  </select>
                </div>
                <div className="col-span-2">
                  <label className="block text-xs text-gray-400 mb-1">Nombre worker LiveKit</label>
                  <input
                    value={newLkName}
                    onChange={e => setNewLkName(e.target.value)}
                    placeholder="voice-agent"
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-brand-pink/60"
                  />
                </div>
              </div>

              <div className="border-t border-white/10 pt-4 mb-4">
                <ModelVoiceForm
                  value={createConfig}
                  onChange={setCreateConfig}
                  notify={notify}
                  enablePreview
                />
              </div>

              <div className="flex gap-2">
                <button
                  onClick={createAgent}
                  disabled={!newName.trim()}
                  className="flex-1 py-2 bg-brand-pink hover:bg-brand-purple disabled:opacity-40 rounded-lg text-sm font-medium transition-colors"
                >
                  Crear
                </button>
                <button
                  onClick={() => setCreating(false)}
                  className="flex-1 py-2 bg-white/5 hover:bg-white/10 rounded-lg text-sm transition-colors"
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Edit modal */}
        {editing && selected && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
            <div className="glass-card rounded-2xl p-6 w-96">
              <h2 className="font-semibold text-lg mb-5 text-gray-100">Editar agente</h2>

              <label className="block text-xs text-gray-400 mb-1">Nombre</label>
              <input
                value={editName}
                onChange={e => setEditName(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:border-brand-pink/60"
              />

              <label className="block text-xs text-gray-400 mb-1">Voice ID (ElevenLabs)</label>
              <input
                value={editVoiceId}
                onChange={e => setEditVoiceId(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm font-mono mb-3 focus:outline-none focus:border-brand-pink/60"
              />

              <label className="block text-xs text-gray-400 mb-1">Nombre worker LiveKit</label>
              <input
                value={editLkName}
                onChange={e => setEditLkName(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm font-mono mb-3 focus:outline-none focus:border-brand-pink/60"
              />

              <label className="flex items-center gap-2 text-sm mb-4 cursor-pointer text-gray-300">
                <input
                  type="checkbox"
                  checked={editActive}
                  onChange={e => setEditActive(e.target.checked)}
                  className="w-4 h-4 rounded accent-brand-pink"
                />
                Agente activo
              </label>

              <label className="block text-xs text-gray-400 mb-1">
                Cliente asignado
                <span className="text-gray-500 ml-1">(cambiar reasigna el agente)</span>
              </label>
              <select
                value={editClientId}
                onChange={e => setEditClientId(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:border-brand-pink/60"
              >
                <option value="">— Sin asignar —</option>
                {clients.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>

              <div className="flex gap-2">
                <button
                  onClick={saveEdit}
                  className="flex-1 py-2 bg-brand-pink hover:bg-brand-purple rounded-lg text-sm font-medium transition-colors"
                >
                  Guardar
                </button>
                <button
                  onClick={() => setEditing(false)}
                  className="flex-1 py-2 bg-white/5 hover:bg-white/10 rounded-lg text-sm transition-colors"
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Content */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Agent list */}
          <div className="lg:col-span-1 flex flex-col gap-3">
            {agents.length === 0 && (
              <GlassCard className="p-8 text-center text-gray-500 text-sm">
                No hay agentes. Crea el primero.
              </GlassCard>
            )}
            {agents.map(a => (
              <div
                key={a.id}
                onClick={() => setSelected(a)}
                className={`cursor-pointer glass-card rounded-2xl p-4 transition-colors ${selected?.id === a.id ? "border-brand-pink/50" : ""}`}
              >
                <div className="flex justify-between items-start mb-1.5">
                  <p className="font-medium text-sm text-gray-100">{a.name}</p>
                  <StatusPill label={a.is_active ? "activo" : "inactivo"} tone={a.is_active ? "active" : "neutral"} pulse={a.is_active} />
                </div>
                <p className="text-xs text-gray-400">
                  {a.client_id
                    ? <>{a.clients?.name ?? "—"} · <span className="text-gray-500">{a.clients?.email}</span></>
                    : <span className="text-amber-400 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-[10px]">Sin cliente</span>
                  }
                </p>
                <p className="text-xs text-gray-600 mt-1 font-mono">{a.lk_agent_name}</p>
              </div>
            ))}
          </div>

          {/* Agent detail */}
          <div className="lg:col-span-2">
            {!selected ? (
              <GlassCard className="p-8 text-center text-gray-500 text-sm h-full flex items-center justify-center">
                Selecciona un agente para ver sus detalles
              </GlassCard>
            ) : (
              <div className="glass-card rounded-2xl overflow-hidden">
                {/* Detail header */}
                <div className="p-5 border-b border-white/10 flex justify-between items-center flex-wrap gap-3">
                  <div>
                    <h2 className="font-semibold text-lg text-gray-100">{selected.name}</h2>
                    <p className="text-xs text-gray-400 mt-0.5">Creado {fmt(selected.created_at)}</p>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    <a
                      href={`/admin/agents/${selected.id}`}
                      className="px-3 py-1.5 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 rounded-lg text-xs font-medium transition-colors"
                    >
                      🛠 Constructor (prompt, voz, tools…)
                    </a>
                    <button
                      onClick={() => openEdit(selected)}
                      className="px-3 py-1.5 bg-brand-pink hover:bg-brand-purple rounded-lg text-xs font-medium transition-colors"
                    >
                      ✏️ Editar
                    </button>
                    <button
                      onClick={() => deleteAgent(selected.id)}
                      className="px-3 py-1.5 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 rounded-lg text-xs font-medium transition-colors"
                    >
                      🗑 Eliminar
                    </button>
                  </div>
                </div>

                {/* Detail fields */}
                <div className="p-5 grid grid-cols-2 gap-4">
                  <Field label="ID del agente" value={selected.id} mono />
                  <Field label="Estado" value={selected.is_active ? "Activo ✅" : "Inactivo ⏸"} />
                  <Field
                    label="Cliente"
                    value={selected.client_id
                      ? (selected.clients?.name ?? "—")
                      : "Sin cliente (huérfano)"}
                  />
                  <Field label="Email del cliente" value={selected.clients?.email ?? "—"} />
                  <Field label="Voice ID (ElevenLabs)" value={selected.voice_id ?? "—"} mono />
                  <Field label="Worker LiveKit" value={selected.lk_agent_name} mono />
                  <Field label="Client ID" value={selected.client_id ?? "— (huérfano)"} mono />
                  <Field label="Creado" value={new Date(selected.created_at).toLocaleString("es-MX")} />
                </div>

                {/* Quick actions */}
                <div className="px-5 pb-5">
                  <p className="text-xs text-gray-500 mb-2 uppercase tracking-wider">Acciones rápidas</p>
                  <div className="flex gap-2 flex-wrap">
                    <a
                      href={`/campaigns`}
                      className="px-3 py-1.5 bg-white/5 hover:bg-white/10 rounded-lg text-xs transition-colors"
                    >
                      📋 Ver campañas
                    </a>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(selected.id);
                        notify("ok", "✅ ID copiado al portapapeles");
                      }}
                      className="px-3 py-1.5 bg-white/5 hover:bg-white/10 rounded-lg text-xs transition-colors"
                    >
                      📋 Copiar ID
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
    </AppShell>
  );
}

export default function AgentsPage() {
  return (
    <AdminAuthGuard>
      <AgentsPageContent />
    </AdminAuthGuard>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="bg-white/5 border border-white/10 rounded-lg p-3">
      <p className="text-xs text-gray-400 mb-1">{label}</p>
      <p className={`text-sm text-gray-100 break-all ${mono ? "font-mono text-xs" : ""}`}>{value}</p>
    </div>
  );
}
