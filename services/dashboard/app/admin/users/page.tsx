"use client";

import React, { useEffect, useState, useCallback } from "react";
import { adminFetch } from "@/lib/admin-auth";
import AdminAuthGuard from "@/app/admin/AdminAuthGuard";
import AppShell from "@/components/AppShell";
import { Users as UsersIcon, Plus, Mail, KeyRound, XCircle, CheckCircle, Eye, EyeOff, Send } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type Role = "admin" | "cliente";
type Status = "active" | "invited";

interface PlatformUser {
  id: string;
  name: string | null;
  email: string | null;
  role: Role;
  supabase_uid: string | null;
  is_active: boolean;
  status: Status;
  created_at: string;
}

const EMPTY_INVITE_FORM = {
  name: "",
  email: "",
  role: "cliente" as Role,
};

const EMPTY_CREATE_FORM = {
  name: "",
  email: "",
  password: "",
  role: "cliente" as Role,
};

function generatePassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  let out = "";
  for (let i = 0; i < 14; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// ── Page content ──────────────────────────────────────────────────────────────

function UsersContent() {
  const [users, setUsers] = useState<PlatformUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [inviteForm, setInviteForm] = useState({ ...EMPTY_INVITE_FORM });
  const [createForm, setCreateForm] = useState({ ...EMPTY_CREATE_FORM });
  const [showPassword, setShowPassword] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Active tab — splits the unified /admin/users list into two surfaces
  // so platform admins don't have to visually filter clients away.
  const [roleTab, setRoleTab] = useState<Role>("admin");

  const notify = (type: "ok" | "err", text: string) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 6000);
  };

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminFetch<PlatformUser[]>("/admin/users");
      setUsers(data);
    } catch {
      notify("err", "Error cargando usuarios");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteForm.name.trim() || !inviteForm.email.trim()) {
      notify("err", "Completa todos los campos requeridos");
      return;
    }
    setSaving(true);
    try {
      await adminFetch("/admin/users/invite", {
        method: "POST",
        body: JSON.stringify({
          name: inviteForm.name.trim(),
          email: inviteForm.email.trim(),
          role: inviteForm.role,
        }),
      });
      notify("ok", "Invitación enviada. El usuario recibirá un correo para configurar su contraseña.");
      setInviteForm({ ...EMPTY_INVITE_FORM });
      setShowInvite(false);
      await fetchUsers();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Error enviando invitación";
      notify("err", message);
    } finally {
      setSaving(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createForm.name.trim() || !createForm.email.trim() || createForm.password.length < 8) {
      notify("err", "Completa todos los campos (la contraseña debe tener al menos 8 caracteres)");
      return;
    }
    setSaving(true);
    try {
      await adminFetch("/admin/users", {
        method: "POST",
        body: JSON.stringify({
          name: createForm.name.trim(),
          email: createForm.email.trim(),
          password: createForm.password,
          role: createForm.role,
        }),
      });
      notify("ok", "Cuenta creada. El usuario puede iniciar sesión de inmediato con la contraseña asignada.");
      setCreateForm({ ...EMPTY_CREATE_FORM });
      setShowCreate(false);
      await fetchUsers();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Error creando la cuenta";
      notify("err", message);
    } finally {
      setSaving(false);
    }
  };

  const handleResendInvite = async (user: PlatformUser) => {
    setBusyId(user.id);
    try {
      await adminFetch(`/admin/users/${user.role}/${user.id}/resend-invite`, { method: "POST" });
      notify("ok", `Invitación reenviada a ${user.email}.`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Error reenviando la invitación";
      notify("err", message);
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleActive = async (user: PlatformUser) => {
    setBusyId(user.id);
    try {
      if (user.is_active) {
        await adminFetch(`/admin/users/${user.role}/${user.id}`, { method: "DELETE" });
      } else {
        await adminFetch(`/admin/users/${user.role}/${user.id}`, {
          method: "PATCH",
          body: JSON.stringify({ is_active: true }),
        });
      }
      await fetchUsers();
    } catch {
      notify("err", "Error actualizando el estado del usuario");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Actions bar */}
      <div className="flex items-center justify-end gap-3">
        <button
          onClick={() => { setShowCreate(false); setShowInvite((v) => !v); }}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/5 text-white text-sm font-medium hover:bg-white/10 transition-colors border border-white/10"
        >
          <Mail className="w-4 h-4" />
          Invitar por correo
        </button>
        <button
          onClick={() => { setShowInvite(false); setShowCreate((v) => !v); }}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-pink text-white text-sm font-medium hover:bg-brand-pink/80 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Crear cuenta directa
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

      {/* Invite form */}
      {showInvite && (
        <form onSubmit={handleInvite} className="glass-panel border border-white/10 rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold text-white mb-1">Invitar usuario por correo</h2>
          <p className="text-xs text-gray-500">
            Se enviará un correo de invitación de Supabase para que la persona configure su propia contraseña.
            Requiere que el SMTP esté configurado en el proyecto de Supabase (Authentication → Settings → SMTP).
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Nombre *</label>
              <input
                className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-pink/50"
                placeholder="Ana Pérez"
                value={inviteForm.name}
                onChange={(e) => setInviteForm((f) => ({ ...f, name: e.target.value }))}
                required
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Correo *</label>
              <input
                type="email"
                className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-pink/50"
                placeholder="ana@empresa.com"
                value={inviteForm.email}
                onChange={(e) => setInviteForm((f) => ({ ...f, email: e.target.value }))}
                required
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Rol *</label>
              <select
                className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-brand-pink/50"
                value={inviteForm.role}
                onChange={(e) => setInviteForm((f) => ({ ...f, role: e.target.value as Role }))}
              >
                <option value="cliente">Cliente</option>
                <option value="admin">Administrador</option>
              </select>
            </div>
          </div>
          <div className="flex gap-3 pt-1">
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2 rounded-lg bg-brand-pink text-white text-sm font-medium hover:bg-brand-pink/80 disabled:opacity-50 transition-colors"
            >
              {saving ? "Enviando…" : "Enviar invitación"}
            </button>
            <button
              type="button"
              onClick={() => { setShowInvite(false); setInviteForm({ ...EMPTY_INVITE_FORM }); }}
              className="px-5 py-2 rounded-lg bg-white/5 text-gray-400 text-sm hover:text-white hover:bg-white/10 transition-colors"
            >
              Cancelar
            </button>
          </div>
        </form>
      )}

      {/* Direct create form */}
      {showCreate && (
        <form onSubmit={handleCreate} className="glass-panel border border-white/10 rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold text-white mb-1">Crear cuenta directa</h2>
          <p className="text-xs text-gray-500">
            La cuenta se crea de inmediato con la contraseña que definas. No se envía ningún correo y no se forzará un cambio de contraseña.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Nombre *</label>
              <input
                className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-pink/50"
                placeholder="Ana Pérez"
                value={createForm.name}
                onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                required
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Correo *</label>
              <input
                type="email"
                className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-pink/50"
                placeholder="ana@empresa.com"
                value={createForm.email}
                onChange={(e) => setCreateForm((f) => ({ ...f, email: e.target.value }))}
                required
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Rol *</label>
              <select
                className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-brand-pink/50"
                value={createForm.role}
                onChange={(e) => setCreateForm((f) => ({ ...f, role: e.target.value as Role }))}
              >
                <option value="cliente">Cliente</option>
                <option value="admin">Administrador</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Contraseña * (mín. 8 caracteres)</label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-3 py-2 pr-16 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-pink/50 font-mono"
                  placeholder="••••••••"
                  value={createForm.password}
                  onChange={(e) => setCreateForm((f) => ({ ...f, password: e.target.value }))}
                  required
                  minLength={8}
                />
                <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-1">
                  <button
                    type="button"
                    title="Generar contraseña"
                    onClick={() => setCreateForm((f) => ({ ...f, password: generatePassword() }))}
                    className="p-1.5 rounded text-gray-500 hover:text-white hover:bg-white/10 transition-colors"
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    title={showPassword ? "Ocultar" : "Mostrar"}
                    onClick={() => setShowPassword((v) => !v)}
                    className="p-1.5 rounded text-gray-500 hover:text-white hover:bg-white/10 transition-colors"
                  >
                    {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="flex gap-3 pt-1">
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2 rounded-lg bg-brand-pink text-white text-sm font-medium hover:bg-brand-pink/80 disabled:opacity-50 transition-colors"
            >
              {saving ? "Creando…" : "Crear cuenta"}
            </button>
            <button
              type="button"
              onClick={() => { setShowCreate(false); setCreateForm({ ...EMPTY_CREATE_FORM }); }}
              className="px-5 py-2 rounded-lg bg-white/5 text-gray-400 text-sm hover:text-white hover:bg-white/10 transition-colors"
            >
              Cancelar
            </button>
          </div>
        </form>
      )}

      {/* User list */}
      {loading ? (
        <div className="text-center py-12 text-gray-500 text-sm">Cargando…</div>
      ) : users.length === 0 ? (
        <div className="glass-panel border border-white/10 rounded-xl p-12 text-center">
          <UsersIcon className="w-10 h-10 text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400 text-sm">No hay usuarios registrados aún.</p>
        </div>
      ) : (
        (() => {
          // Filter to the active tab. Counts drive the badges on each tab.
          const admins = users.filter((u) => u.role === "admin");
          const clients = users.filter((u) => u.role === "cliente");
          const visible = roleTab === "admin" ? admins : clients;
          return (
            <>
              {/* ── Role tabs ─────────────────────────────────────────────── */}
              <div className="flex items-center gap-1 border-b border-white/10 mb-4">
                <button
                  onClick={() => setRoleTab("admin")}
                  className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px flex items-center gap-2 ${
                    roleTab === "admin"
                      ? "text-white border-brand-pink"
                      : "text-gray-400 border-transparent hover:text-white"
                  }`}
                >
                  Administradores
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${roleTab === "admin" ? "bg-brand-pink/15 text-brand-pink" : "bg-white/5 text-gray-500"}`}>
                    {admins.length}
                  </span>
                </button>
                <button
                  onClick={() => setRoleTab("cliente")}
                  className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px flex items-center gap-2 ${
                    roleTab === "cliente"
                      ? "text-white border-brand-pink"
                      : "text-gray-400 border-transparent hover:text-white"
                  }`}
                >
                  Clientes
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${roleTab === "cliente" ? "bg-brand-pink/15 text-brand-pink" : "bg-white/5 text-gray-500"}`}>
                    {clients.length}
                  </span>
                </button>
                <p className="ml-auto text-[11px] text-gray-500 pb-2">
                  {roleTab === "admin"
                    ? "Usuarios internos con acceso completo a la plataforma."
                    : "Cuentas externas con acceso limitado a sus agentes y reportes."}
                </p>
              </div>

              {visible.length === 0 ? (
                <div className="glass-panel border border-white/10 rounded-xl p-12 text-center">
                  <UsersIcon className="w-10 h-10 text-gray-600 mx-auto mb-3" />
                  <p className="text-gray-400 text-sm">
                    {roleTab === "admin"
                      ? "No hay administradores registrados."
                      : "No hay clientes registrados todavía."}
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {visible.map((user) => (
            <div key={`${user.role}-${user.id}`} className="glass-panel border border-white/10 rounded-xl overflow-hidden">
              <div className="flex items-center gap-4 px-5 py-4">
                <div className={`w-2 h-2 rounded-full shrink-0 ${user.is_active ? "bg-green-400" : "bg-gray-600"}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white truncate">{user.name || "—"}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${user.role === "admin" ? "bg-brand-pink/10 text-brand-pink border-brand-pink/20" : "bg-blue-500/10 text-blue-400 border-blue-500/20"}`}>
                      {user.role === "admin" ? "ADMINISTRADOR" : "CLIENTE"}
                    </span>
                    {user.status === "invited" && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
                        INVITADO
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-0.5">
                    <span className="text-xs text-gray-400">{user.email}</span>
                    <span className="text-xs text-gray-600">·</span>
                    <span className="text-xs text-gray-500">{new Date(user.created_at).toLocaleDateString("es-PA")}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => handleResendInvite(user)}
                    disabled={busyId === user.id}
                    title={user.status === "invited" ? "Reenviar invitación" : "Enviar enlace para crear/restablecer contraseña"}
                    className="p-1.5 rounded-lg text-gray-500 hover:text-white hover:bg-white/5 transition-colors disabled:opacity-40"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleToggleActive(user)}
                    disabled={busyId === user.id}
                    title={user.is_active ? "Desactivar" : "Activar"}
                    className="p-1.5 rounded-lg text-gray-500 hover:text-white hover:bg-white/5 transition-colors disabled:opacity-40"
                  >
                    {user.is_active ? <CheckCircle className="w-4 h-4 text-green-400" /> : <XCircle className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>
                  ))}
                </div>
              )}
            </>
          );
        })()
      )}
    </div>
  );
}

// ── Page export ───────────────────────────────────────────────────────────────

export default function UsersPage() {
  return (
    <AdminAuthGuard>
      <AppShell title="Usuarios" description="Invita usuarios o crea cuentas directas con un rol asignado">
        <UsersContent />
      </AppShell>
    </AdminAuthGuard>
  );
}
