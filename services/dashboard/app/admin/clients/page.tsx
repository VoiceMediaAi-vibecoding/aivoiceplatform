"use client";

import React, { useEffect, useState, useCallback } from "react";
import { Plus, X } from "lucide-react";
import { adminFetch } from "@/lib/admin-auth";
import AdminAuthGuard from "@/app/admin/AdminAuthGuard";
import AppShell from "@/components/AppShell";
import StatusPill from "@/components/ui/StatusPill";

interface Agent {
  id: string;
  client_id: string;
  name: string;
  voice_id: string | null;
  lk_agent_name: string;
  is_active: boolean;
  created_at: string;
}

interface Client {
  id: string;
  name: string;
  email: string;
  supabase_uid: string | null;
  is_active: boolean;
  created_at: string;
  agents: Agent[];
}

function ClientsPageContent() {
  const [clients, setClients] = useState<Client[]>([]);
  const [selected, setSelected] = useState<Client | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // Agent-assignment UI state. `availableAgents` is the full list (from
  // /admin/agents) — we filter out the ones already linked to this client
  // and let the admin pick one to attach. `assigning` / `unassigning` give
  // the row buttons a busy state so double-clicks don't double-fire.
  const [availableAgents, setAvailableAgents] = useState<Agent[]>([]);
  const [assigning, setAssigning] = useState(false);
  const [unassigning, setUnassigning] = useState<string | null>(null);

  // Create form
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  

  // Edit form
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");

  const fetchClients = useCallback(async () => {
    try {
      const data = await adminFetch<Client[]>("/admin/clients");
      setClients(data);
      // Keep the selection in sync with fresh data
      setSelected((prev) => (prev ? data.find((c) => c.id === prev.id) ?? null : null));
    } catch {
      // adminFetch already redirects to login on 401
    }
  }, []);

  const fetchAllAgents = useCallback(async () => {
    try {
      const data = await adminFetch<Agent[]>("/admin/agents");
      setAvailableAgents(data);
    } catch {
      // adminFetch already redirects to login on 401
    }
  }, []);

  useEffect(() => {
    fetchClients();
    fetchAllAgents();
  }, [fetchClients, fetchAllAgents]);

  const notify = (type: "ok" | "err", text: string) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 4500);
  };

  const resetCreateForm = () => {
    setNewName("");
    setNewEmail("");
    setNewPassword("");
  };

  const createClient = async () => {
    if (!newName.trim() || !newEmail.trim() || !newPassword.trim()) return;
    try {
      await adminFetch("/admin/clients", {
        method: "POST",
        body: JSON.stringify({
          name: newName,
          email: newEmail,
          password: newPassword,
        }),
      });
      notify("ok", "✅ Cliente creado junto con su agente");
      setCreating(false);
      resetCreateForm();
      fetchClients();
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error al crear cliente"}`);
    }
  };

  const openEdit = (client: Client) => {
    setEditName(client.name);
    setEditEmail(client.email);
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!selected) return;
    try {
      await adminFetch(`/admin/clients/${selected.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: editName, email: editEmail }),
      });
      notify("ok", "✅ Cliente actualizado");
      setEditing(false);
      fetchClients();
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error al guardar"}`);
    }
  };

  const toggleActive = async (client: Client) => {
    const action = client.is_active ? "desactivar" : "reactivar";
    if (!confirm(`¿Seguro que quieres ${action} a "${client.name}"?`)) return;
    try {
      await adminFetch(`/admin/clients/${client.id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_active: !client.is_active }),
      });
      notify("ok", client.is_active ? "⏸ Cliente desactivado" : "✅ Cliente reactivado");
      fetchClients();
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error al cambiar estado"}`);
    }
  };

  const deleteClient = async (client: Client) => {
    if (!confirm(`¿Eliminar permanentemente a "${client.name}"? Esta acción no se puede deshacer.`)) return;
    try {
      await adminFetch(`/admin/clients/${client.id}`, { method: "DELETE" });
      notify("ok", "✅ Cliente eliminado");
      if (selected?.id === client.id) setSelected(null);
      fetchClients();
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error al eliminar"}`);
    }
  };

  // Agent reassignment — the relationship lives in `agents.client_id`, so we
  // PATCH the agent (not the client). Validation happens server-side: refuses
  // if the agent has a live session, returns 404 if the target client is gone.
  const handleAssignAgent = async (agentId: string) => {
    if (!selected) return;
    setAssigning(true);
    try {
      await adminFetch(`/admin/agents/${agentId}`, {
        method: "PATCH",
        body: JSON.stringify({ client_id: selected.id }),
      });
      notify("ok", "✅ Agente asignado al cliente");
      await fetchClients();
      await fetchAllAgents();
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error al asignar agente"}`);
    } finally {
      setAssigning(false);
    }
  };

  const handleUnassignAgent = async (agentId: string, agentName: string) => {
    if (!selected) return;
    if (!confirm(`¿Quitar "${agentName}" de este cliente? El agente quedará sin asignar.`)) return;
    setUnassigning(agentId);
    try {
      await adminFetch(`/admin/agents/${agentId}`, {
        method: "PATCH",
        body: JSON.stringify({ client_id: null }),
      });
      notify("ok", "✅ Agente desasignado");
      await fetchClients();
      await fetchAllAgents();
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error al desasignar"}`);
    } finally {
      setUnassigning(null);
    }
  };

  const fmt = (s: string) =>
    new Date(s).toLocaleDateString("es-MX", { day: "2-digit", month: "short", year: "numeric" });

  return (
    <AppShell title="Clientes" description="Administra cuentas de clientes, su estado y los agentes asignados">
      <div className="flex justify-end mb-6">
        <button
          onClick={() => setCreating(true)}
          className="px-4 py-2 bg-brand-pink hover:bg-brand-purple rounded-lg text-sm font-medium transition-colors"
        >
          + Nuevo cliente
        </button>
      </div>

      {/* Notification */}
      {msg && (
        <div
          className={`mb-4 p-3 rounded-lg text-sm border flex justify-between items-center ${
            msg.type === "ok" ? "bg-emerald-500/10 border-emerald-400/20 text-emerald-300" : "bg-rose-500/10 border-rose-400/20 text-rose-300"
          }`}
        >
          {msg.text}
          <button onClick={() => setMsg(null)} className="ml-3 opacity-60 hover:opacity-100">✕</button>
        </div>
      )}

      {/* Create modal */}
      {creating && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="glass-card rounded-xl p-6 w-[28rem] border border-white/10 shadow-2xl">
            <h2 className="font-semibold text-lg mb-5 text-white">Nuevo cliente</h2>

            <label className="block text-xs text-gray-400 mb-1">Nombre</label>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Ej: Acme Corp"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:border-brand-pink/60"
              autoFocus
            />

            <label className="block text-xs text-gray-400 mb-1">Correo</label>
            <input
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="cliente@empresa.com"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:border-brand-pink/60"
            />

            <label className="block text-xs text-gray-400 mb-1">Contraseña inicial</label>
<input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm mb-5 focus:outline-none focus:border-brand-pink/60"
            />

            <div className="flex gap-2">
              <button
                onClick={createClient}
                disabled={!newName.trim() || !newEmail.trim() || !newPassword.trim()}
                className="flex-1 py-2 bg-brand-pink hover:bg-brand-purple disabled:opacity-40 rounded-lg text-sm font-medium transition-colors"
              >
                Crear
              </button>
              <button
                onClick={() => {
                  setCreating(false);
                  resetCreateForm();
                }}
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
          <div className="glass-card rounded-xl p-6 w-96 border border-white/10 shadow-2xl">
            <h2 className="font-semibold text-lg mb-5 text-white">Editar cliente</h2>

            <label className="block text-xs text-gray-400 mb-1">Nombre</label>
            <input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:border-brand-pink/60"
            />

            <label className="block text-xs text-gray-400 mb-1">Correo</label>
            <input
              type="email"
              value={editEmail}
              onChange={(e) => setEditEmail(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm mb-5 focus:outline-none focus:border-brand-pink/60"
            />

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
        {/* Client list */}
        <div className="lg:col-span-1 flex flex-col gap-3">
          {clients.length === 0 && (
            <div className="glass-card rounded-xl p-8 border border-white/5 text-center text-gray-500 text-sm">
              No hay clientes todavía. Crea el primero.
            </div>
          )}
          {clients.map((c) => (
            <div
              key={c.id}
              onClick={() => setSelected(c)}
              className={`cursor-pointer glass-card rounded-xl p-4 border transition-colors ${
                selected?.id === c.id ? "border-brand-pink" : "border-white/5 hover:border-white/15"
              }`}
            >
              <div className="flex justify-between items-start mb-1">
                <p className="font-medium text-sm text-white">{c.name}</p>
                <StatusPill
                  label={c.is_active ? "activo" : "inactivo"}
                  tone={c.is_active ? "active" : "neutral"}
                  pulse={c.is_active}
                />
              </div>
              <p className="text-xs text-gray-400">{c.email}</p>
              <p className="text-xs text-gray-600 mt-1">
                {c.agents?.length ?? 0} agente{(c.agents?.length ?? 0) === 1 ? "" : "s"} asignado{(c.agents?.length ?? 0) === 1 ? "" : "s"}
              </p>
            </div>
          ))}
        </div>

        {/* Client detail / assignment view */}
        <div className="lg:col-span-2">
          {!selected ? (
            <div className="glass-card rounded-xl p-8 border border-white/5 text-center text-gray-500 text-sm h-full flex items-center justify-center">
              Selecciona un cliente para ver sus detalles y agentes asignados
            </div>
          ) : (
            <div className="glass-card rounded-xl border border-white/5 overflow-hidden">
              {/* Detail header */}
              <div className="p-5 border-b border-white/5 flex justify-between items-center">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="font-semibold text-lg text-white">{selected.name}</h2>
                    <StatusPill
                      label={selected.is_active ? "activo" : "inactivo"}
                      tone={selected.is_active ? "active" : "neutral"}
                      pulse={selected.is_active}
                    />
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5">Cliente desde {fmt(selected.created_at)}</p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => openEdit(selected)}
                    className="px-3 py-1.5 bg-brand-pink hover:bg-brand-purple rounded-lg text-xs font-medium transition-colors"
                  >
                    ✏️ Editar
                  </button>
                  <button
                    onClick={() => toggleActive(selected)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      selected.is_active
                        ? "bg-amber-700/60 hover:bg-amber-700 text-amber-100"
                        : "bg-green-700/60 hover:bg-green-700 text-green-100"
                    }`}
                  >
                    {selected.is_active ? "⏸ Desactivar" : "▶ Reactivar"}
                  </button>
                  <button
                    onClick={() => deleteClient(selected)}
                    className="px-3 py-1.5 bg-red-700/60 hover:bg-red-700 rounded-lg text-xs font-medium transition-colors"
                  >
                    🗑 Eliminar
                  </button>
                </div>
              </div>

              {/* Detail fields */}
              <div className="p-5 grid grid-cols-2 gap-4 border-b border-white/5">
                <Field label="ID del cliente" value={selected.id} mono />
                <Field label="Estado" value={selected.is_active ? "Activo ✅" : "Inactivo ⏸"} />
                <Field label="Correo" value={selected.email} />
                <Field label="Supabase UID" value={selected.supabase_uid ?? "—"} mono />
                <Field label="Creado" value={new Date(selected.created_at).toLocaleString("es-MX")} />
              </div>

              {/* Assignment view: agents linked to this client */}
              <div className="p-5">
                <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
                  <p className="text-xs text-gray-500 uppercase tracking-wider">
                    Agentes asignados ({selected.agents?.length ?? 0})
                  </p>
                  {(() => {
                    // Only show agents that are NOT already linked to this
                    // client. We pass the dropdown its own state to keep the
                    // selection ephemeral (avoids a controlled-input value
                    // mismatch when the assigned list refreshes).
                    const assignedIds = new Set((selected.agents ?? []).map((a) => a.id));
                    const pool = availableAgents.filter((a) => !assignedIds.has(a.id));
                    if (pool.length === 0) return null;
                    return (
                      <div className="flex items-center gap-2">
                        <select
                          disabled={assigning}
                          defaultValue=""
                          onChange={(e) => {
                            const aid = e.target.value;
                            if (aid) {
                              handleAssignAgent(aid);
                              e.currentTarget.value = "";
                            }
                          }}
                          className="text-xs bg-white/[0.05] border border-white/10 rounded-lg px-2 py-1.5 text-white focus:outline-none focus:border-brand-pink/50 disabled:opacity-50"
                        >
                          <option value="">+ Asignar agente existente…</option>
                          {pool.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                              {a.lk_agent_name ? ` (${a.lk_agent_name})` : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })()}
                </div>

                {(!selected.agents || selected.agents.length === 0) ? (
                  <div className="bg-white/[0.02] border border-white/5 rounded-lg p-6 text-center text-gray-500 text-sm">
                    Este cliente no tiene agentes asignados todavía. Usa el
                    dropdown de arriba para vincular uno existente.
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {selected.agents.map((a) => (
                      <div
                        key={a.id}
                        className="flex items-center justify-between bg-white/[0.02] border border-white/5 rounded-lg px-4 py-3"
                      >
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium text-white">{a.name}</p>
                            <StatusPill
                              label={a.is_active ? "activo" : "inactivo"}
                              tone={a.is_active ? "active" : "neutral"}
                            />
                          </div>
                          <p className="text-xs text-gray-500 font-mono mt-0.5">{a.lk_agent_name}</p>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="text-right">
                            <p className="text-xs text-gray-400">Voice ID</p>
                            <p className="text-xs font-mono text-gray-300">{a.voice_id ?? "—"}</p>
                          </div>
                          <button
                            onClick={() => handleUnassignAgent(a.id, a.name)}
                            disabled={unassigning === a.id}
                            title="Quitar de este cliente"
                            className="p-1.5 rounded-lg text-rose-400 hover:bg-rose-500/10 disabled:opacity-40 transition-colors"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

export default function ClientsPage() {
  return (
    <AdminAuthGuard>
      <ClientsPageContent />
    </AdminAuthGuard>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="bg-white/[0.02] border border-white/5 rounded-lg p-3">
      <p className="text-xs text-gray-400 mb-1">{label}</p>
      <p className={`text-sm text-gray-100 break-all ${mono ? "font-mono text-xs" : ""}`}>{value}</p>
    </div>
  );
}
