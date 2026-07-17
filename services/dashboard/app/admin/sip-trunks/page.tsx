"use client";

import React, { useEffect, useState, useCallback } from "react";
import { adminFetch } from "@/lib/admin-auth";
import AdminAuthGuard from "@/app/admin/AdminAuthGuard";
import AppShell from "@/components/AppShell";
import { Network, Plus, Trash2, CheckCircle, XCircle, Copy, ChevronDown, ChevronUp } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Agent {
  id: string;
  name: string;
}

interface SipTrunk {
  id: string;
  name: string;
  client_name: string | null;
  sip_server: string;
  sip_username: string;
  phone_number: string;
  lk_trunk_id: string | null;
  lk_dispatch_rule_id: string | null;
  inbound_enabled: boolean;
  agent_id: string | null;
  is_active: boolean;
  created_at: string;
}

const EMPTY_FORM = {
  name: "",
  client_name: "",
  sip_server: "",
  sip_username: "",
  sip_password: "",
  phone_number: "",
  agent_id: "",
  inbound_enabled: false,
};

// ── Page content ──────────────────────────────────────────────────────────────

function SipTrunksContent() {
  const [trunks, setTrunks] = useState<SipTrunk[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const notify = (type: "ok" | "err", text: string) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 5000);
  };

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [trunkData, agentData] = await Promise.all([
        adminFetch<SipTrunk[]>("/admin/sip-trunks"),
        adminFetch<Agent[]>("/admin/agents").catch(() => []),
      ]);
      setTrunks(trunkData);
      setAgents(agentData);
    } catch {
      notify("err", "Error cargando datos");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.sip_server.trim() || !form.sip_username.trim() || !form.sip_password.trim() || !form.phone_number.trim()) {
      notify("err", "Completa todos los campos requeridos");
      return;
    }
    setSaving(true);
    try {
      await adminFetch("/admin/sip-trunks", {
        method: "POST",
        body: JSON.stringify({
          name: form.name.trim(),
          client_name: form.client_name.trim() || null,
          sip_server: form.sip_server.trim(),
          sip_username: form.sip_username.trim(),
          sip_password: form.sip_password.trim(),
          phone_number: form.phone_number.trim(),
          agent_id: form.agent_id || null,
          inbound_enabled: form.inbound_enabled,
        }),
      });
      notify("ok", "Trunk creado y registrado en LiveKit");
      setForm({ ...EMPTY_FORM });
      setShowForm(false);
      await fetchAll();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Error creando trunk";
      notify("err", message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (trunk: SipTrunk) => {
    if (!confirm(`¿Eliminar "${trunk.name}"? Esta acción también lo eliminará de LiveKit.`)) return;
    setDeletingId(trunk.id);
    try {
      await adminFetch(`/admin/sip-trunks/${trunk.id}`, { method: "DELETE" });
      notify("ok", `Trunk "${trunk.name}" eliminado`);
      await fetchAll();
    } catch {
      notify("err", "Error al eliminar el trunk");
    } finally {
      setDeletingId(null);
    }
  };

  const handleToggleActive = async (trunk: SipTrunk) => {
    try {
      await adminFetch(`/admin/sip-trunks/${trunk.id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_active: !trunk.is_active }),
      });
      await fetchAll();
    } catch {
      notify("err", "Error actualizando estado");
    }
  };

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => null);
    notify("ok", "Copiado al portapapeles");
  };

  const agentName = (id: string | null) => {
    if (!id) return "—";
    return agents.find((a) => a.id === id)?.name ?? id.slice(0, 8) + "…";
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Actions bar */}
      <div className="flex items-center justify-end">
        <button
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-pink text-white text-sm font-medium hover:bg-brand-pink/80 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Nuevo trunk
        </button>
      </div>

      {/* Notification */}
      {msg && (
        <div
          className={`rounded-lg px-4 py-3 text-sm font-medium ${
            msg.type === "ok" ? "bg-green-500/10 text-green-400 border border-green-500/20" : "bg-red-500/10 text-red-400 border border-red-500/20"
          }`}
        >
          {msg.text}
        </div>
      )}

      {/* Create form */}
      {showForm && (
        <form onSubmit={handleCreate} className="glass-panel border border-white/10 rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold text-white mb-1">Registrar nuevo trunk</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Nombre descriptivo *</label>
              <input
                className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-pink/50"
                placeholder="Tigo Panamá - SIP"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                required
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Cliente</label>
              <input
                className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-pink/50"
                placeholder="Tigo Panamá"
                value={form.client_name}
                onChange={(e) => setForm((f) => ({ ...f, client_name: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Servidor SIP *</label>
              <input
                className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-pink/50"
                placeholder="sip.carrier.com"
                value={form.sip_server}
                onChange={(e) => setForm((f) => ({ ...f, sip_server: e.target.value }))}
                required
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Número E.164 *</label>
              <input
                className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-pink/50"
                placeholder="+50761234567"
                value={form.phone_number}
                onChange={(e) => setForm((f) => ({ ...f, phone_number: e.target.value }))}
                required
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Usuario SIP *</label>
              <input
                className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-pink/50"
                placeholder="usuario@carrier.com"
                value={form.sip_username}
                onChange={(e) => setForm((f) => ({ ...f, sip_username: e.target.value }))}
                required
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Contraseña SIP *</label>
              <input
                type="password"
                className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-pink/50"
                placeholder="••••••••"
                value={form.sip_password}
                onChange={(e) => setForm((f) => ({ ...f, sip_password: e.target.value }))}
                required
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Agente asignado (inbound)</label>
              <select
                className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-brand-pink/50"
                value={form.agent_id}
                onChange={(e) => setForm((f) => ({ ...f, agent_id: e.target.value }))}
              >
                <option value="">Sin asignar</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-3 pt-5">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <div
                  onClick={() => setForm((f) => ({ ...f, inbound_enabled: !f.inbound_enabled }))}
                  className={`relative w-9 h-5 rounded-full transition-colors ${form.inbound_enabled ? "bg-brand-pink" : "bg-white/10"}`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${form.inbound_enabled ? "translate-x-4" : ""}`} />
                </div>
                <span className="text-sm text-gray-300">Activar llamadas entrantes</span>
              </label>
            </div>
          </div>

          {form.inbound_enabled && (
            <div className="rounded-lg bg-blue-500/5 border border-blue-500/20 px-4 py-3 text-xs text-blue-300 space-y-1">
              <p className="font-medium">Instrucción para el cliente (inbound):</p>
              <p>Configurar el número <strong>{form.phone_number || "+507XXXXXXXX"}</strong> en su carrier para apuntar a:</p>
              <div className="flex items-center gap-2 mt-1">
                <code className="font-mono bg-black/30 px-2 py-1 rounded">sip.voicemedia.com:5060</code>
                <button type="button" onClick={() => copyText("sip.voicemedia.com:5060")} className="text-blue-400 hover:text-blue-200">
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2 rounded-lg bg-brand-pink text-white text-sm font-medium hover:bg-brand-pink/80 disabled:opacity-50 transition-colors"
            >
              {saving ? "Registrando…" : "Registrar trunk"}
            </button>
            <button
              type="button"
              onClick={() => { setShowForm(false); setForm({ ...EMPTY_FORM }); }}
              className="px-5 py-2 rounded-lg bg-white/5 text-gray-400 text-sm hover:text-white hover:bg-white/10 transition-colors"
            >
              Cancelar
            </button>
          </div>
        </form>
      )}

      {/* Trunk list */}
      {loading ? (
        <div className="text-center py-12 text-gray-500 text-sm">Cargando…</div>
      ) : trunks.length === 0 ? (
        <div className="glass-panel border border-white/10 rounded-xl p-12 text-center">
          <Network className="w-10 h-10 text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400 text-sm">No hay SIP trunks registrados aún.</p>
          <p className="text-gray-600 text-xs mt-1">Agrega el primero con el botón de arriba.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {trunks.map((trunk) => {
            const expanded = expandedId === trunk.id;
            return (
              <div key={trunk.id} className="glass-panel border border-white/10 rounded-xl overflow-hidden">
                {/* Row header */}
                <div className="flex items-center gap-4 px-5 py-4">
                  <div
                    className={`w-2 h-2 rounded-full shrink-0 ${trunk.is_active ? "bg-green-400" : "bg-gray-600"}`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-white truncate">{trunk.name}</span>
                      {trunk.client_name && (
                        <span className="text-xs text-gray-500 shrink-0">· {trunk.client_name}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="text-xs text-gray-400 font-mono">{trunk.phone_number}</span>
                      <span className="text-xs text-gray-600">·</span>
                      <span className="text-xs text-gray-500">{trunk.sip_server}</span>
                      {trunk.inbound_enabled && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">INBOUND</span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {/* Toggle active */}
                    <button
                      onClick={() => handleToggleActive(trunk)}
                      title={trunk.is_active ? "Desactivar" : "Activar"}
                      className="p-1.5 rounded-lg text-gray-500 hover:text-white hover:bg-white/5 transition-colors"
                    >
                      {trunk.is_active ? <CheckCircle className="w-4 h-4 text-green-400" /> : <XCircle className="w-4 h-4" />}
                    </button>

                    {/* Delete */}
                    <button
                      onClick={() => handleDelete(trunk)}
                      disabled={deletingId === trunk.id}
                      title="Eliminar trunk"
                      className="p-1.5 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-500/5 transition-colors disabled:opacity-40"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>

                    {/* Expand */}
                    <button
                      onClick={() => setExpandedId(expanded ? null : trunk.id)}
                      className="p-1.5 rounded-lg text-gray-500 hover:text-white hover:bg-white/5 transition-colors"
                    >
                      {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* Expanded detail */}
                {expanded && (
                  <div className="border-t border-white/5 px-5 py-4 bg-black/20 space-y-3">
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-xs">
                      <div>
                        <span className="text-gray-500">LiveKit Trunk ID</span>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="text-white font-mono">{trunk.lk_trunk_id ?? "—"}</span>
                          {trunk.lk_trunk_id && (
                            <button onClick={() => copyText(trunk.lk_trunk_id!)} className="text-gray-500 hover:text-gray-300">
                              <Copy className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </div>
                      <div>
                        <span className="text-gray-500">Dispatch Rule ID</span>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="text-white font-mono">{trunk.lk_dispatch_rule_id ?? "—"}</span>
                          {trunk.lk_dispatch_rule_id && (
                            <button onClick={() => copyText(trunk.lk_dispatch_rule_id!)} className="text-gray-500 hover:text-gray-300">
                              <Copy className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </div>
                      <div>
                        <span className="text-gray-500">Agente asignado</span>
                        <p className="text-white mt-0.5">{agentName(trunk.agent_id)}</p>
                      </div>
                      <div>
                        <span className="text-gray-500">Usuario SIP</span>
                        <p className="text-white mt-0.5">{trunk.sip_username}</p>
                      </div>
                      <div>
                        <span className="text-gray-500">Estado</span>
                        <p className={`mt-0.5 font-medium ${trunk.is_active ? "text-green-400" : "text-gray-500"}`}>
                          {trunk.is_active ? "Activo" : "Inactivo"}
                        </p>
                      </div>
                      <div>
                        <span className="text-gray-500">Registrado</span>
                        <p className="text-white mt-0.5">{new Date(trunk.created_at).toLocaleDateString("es-PA")}</p>
                      </div>
                    </div>

                    {trunk.inbound_enabled && (
                      <div className="rounded-lg bg-blue-500/5 border border-blue-500/20 px-4 py-3 text-xs text-blue-300 space-y-1">
                        <p className="font-medium">Instrucción para el cliente (inbound):</p>
                        <p>Configurar <strong>{trunk.phone_number}</strong> para apuntar a:</p>
                        <div className="flex items-center gap-2 mt-1">
                          <code className="font-mono bg-black/30 px-2 py-1 rounded">sip.voicemedia.com:5060</code>
                          <button onClick={() => copyText("sip.voicemedia.com:5060")} className="text-blue-400 hover:text-blue-200">
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Page export ───────────────────────────────────────────────────────────────

export default function SipTrunksPage() {
  return (
    <AdminAuthGuard>
      <AppShell title="SIP Trunks (BYOC)" description="Números propios de clientes vía carrier externo">
        <SipTrunksContent />
      </AppShell>
    </AdminAuthGuard>
  );
}
