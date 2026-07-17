"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import { adminFetch, getAPI, getToken } from "@/lib/admin-auth";
import AdminAuthGuard from "@/app/admin/AdminAuthGuard";
import AppShell from "@/components/AppShell";
import { Loader2, Play, Pause, Rewind, FastForward, Pencil, Check, X } from "lucide-react";

interface Campaign {
  id: string;
  name: string;
  status: string;
  max_concurrent: number;
  total_numbers: number;
  called: number;
  answered: number;
  voicemail: number;
  no_answer: number;
  failed: number;
  created_at: string;
  outbound_trunk_id: string | null;
  caller_id_number: string | null;
  agent_id: string | null;
}

interface AgentOption {
  id: string;
  name: string;
  is_active: boolean;
}

interface OutboundNumberOption {
  trunk_id: string;
  number: string;
  label: string;
}

interface CallRow {
  id: number;
  phone_number: string;
  customer_name: string | null;
  status: string;
  end_reason: string | null;
  duration_seconds: number | null;
  transcript: string | null;
  recording_url: string | null;
  session_id: string | null;
  twilio_call_sid: string | null;
  started_at: string | null;
  ended_at: string | null;
  error_msg: string | null;
  metadata: Record<string, string>;
}

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-white/10 text-gray-300",
  running: "bg-green-600/30 text-green-300",
  paused: "bg-yellow-600/30 text-yellow-300",
  completed: "bg-blue-600/30 text-blue-300",
  cancelled: "bg-red-600/30 text-red-400",
  pending: "bg-white/10 text-gray-400",
  calling: "bg-brand-purple/25 text-fuchsia-300",
  answered: "bg-green-600/30 text-green-300",
  voicemail: "bg-purple-600/30 text-purple-300",
  no_answer: "bg-yellow-600/30 text-yellow-300",
  failed: "bg-red-600/30 text-red-400",
  busy: "bg-orange-600/30 text-orange-300",
  // Real agent dispositions (from sessions.end_reason)
  client_hangup: "bg-slate-600/30 text-slate-300",
  agent_hangup: "bg-blue-600/30 text-blue-300",
  in_progress: "bg-green-600/30 text-green-400",
};

const STATUS_LABELS: Record<string, string> = {
  completed: "contestó",
  no_answer: "sin respuesta",
  failed: "fallida",
  calling: "marcando",
  pending: "pendiente",
  voicemail: "buzón",
  client_hangup: "cliente colgó",
  agent_hangup: "agente colgó",
  in_progress: "en curso",
  busy: "ocupado",
};

// For campaign call rows: prefer end_reason (real disposition) over raw queue status
// ── Audio Player ──────────────────────────────────────────────────────────────

function AudioPlayerInline({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [dragging, setDragging] = useState(false);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    playing ? a.pause() : a.play();
  };

  const skip = (delta: number) => {
    const a = audioRef.current;
    if (!a || !duration) return;
    const next = Math.max(0, Math.min(duration, a.currentTime + delta));
    a.currentTime = next;
    setCurrent(next);
    setProgress((next / duration) * 100);
  };

  const seekToClientX = useCallback((clientX: number) => {
    const a = audioRef.current;
    const bar = barRef.current;
    if (!a || !bar || !duration) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    a.currentTime = ratio * duration;
    setCurrent(ratio * duration);
    setProgress(ratio * 100);
  }, [duration]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    setDragging(true);
    seekToClientX(e.clientX);
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => seekToClientX(e.clientX);
    const onUp = () => setDragging(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, seekToClientX]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => {
      if (dragging) return;
      setCurrent(a.currentTime);
      setProgress(a.duration ? (a.currentTime / a.duration) * 100 : 0);
    };
    a.addEventListener("timeupdate", onTime);
    return () => a.removeEventListener("timeupdate", onTime);
  }, [dragging]);

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  return (
    <div className="flex items-center gap-1.5">
      <audio ref={audioRef} src={src} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setProgress(0); setCurrent(0); }}
        onLoadedMetadata={() => setDuration(audioRef.current?.duration ?? 0)} />
      <button onClick={() => skip(-10)} title="Retroceder 10s" className="shrink-0 w-5 h-5 flex items-center justify-center rounded-full text-gray-400 hover:text-white transition-colors">
        <Rewind className="w-3.5 h-3.5" />
      </button>
      <button onClick={toggle} className="flex items-center justify-center w-6 h-6 rounded-full bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-300 transition-colors">
        {playing ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3 ml-0.5" />}
      </button>
      <button onClick={() => skip(10)} title="Adelantar 10s" className="shrink-0 w-5 h-5 flex items-center justify-center rounded-full text-gray-400 hover:text-white transition-colors">
        <FastForward className="w-3.5 h-3.5" />
      </button>
      <div className="flex items-center gap-1.5 min-w-0">
        <div
          ref={barRef}
          className="relative w-20 h-3 flex items-center cursor-pointer group touch-none"
          onPointerDown={onPointerDown}
        >
          <div className="absolute inset-x-0 h-1 rounded-full bg-white/10" />
          <div className="absolute left-0 h-1 rounded-full bg-emerald-500" style={{ width: `${progress}%` }} />
          <div className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-white shadow opacity-0 group-hover:opacity-100 transition-opacity" style={{ left: `calc(${progress}% - 5px)` }} />
        </div>
        <span className="text-[10px] text-gray-500 tabular-nums">{fmt(current)}{duration ? `/${fmt(duration)}` : ""}</span>
      </div>
    </div>
  );
}

function RecordingButton({ sessionId, hasUrl, canFetch }: { sessionId: string | null; hasUrl: boolean; canFetch: boolean }) {
  const [loading, setLoading] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  // S4.5 — revoke blob URL on unmount + when audio changes.
  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  if (!sessionId || (!hasUrl && !canFetch)) return <span className="text-xs text-gray-600">—</span>;
  if (error) return <span className="text-xs text-rose-400">No disp.</span>;
  if (audioUrl) return <AudioPlayerInline src={audioUrl} />;

  const load = async () => {
    setLoading(true);
    setError(false);
    try {
      const token = getToken();
      const res = await fetch(`${getAPI()}/calls/recordings/${sessionId}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: "include",
      });
      if (!res.ok) throw new Error("not found");
      const blob = await res.blob();
      setAudioUrl(URL.createObjectURL(blob));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button onClick={load} disabled={loading}
      className="flex items-center gap-1 text-xs text-emerald-300 hover:text-emerald-200 disabled:opacity-50 transition-colors">
      {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
      {loading ? "…" : "Escuchar"}
    </button>
  );
}

function callDisplayStatus(row: CallRow): { key: string; label: string } {
  if (row.end_reason) return { key: row.end_reason, label: STATUS_LABELS[row.end_reason] ?? row.end_reason };
  if (row.status === "completed") return { key: "completed", label: "contestó" };
  return { key: row.status, label: STATUS_LABELS[row.status] ?? row.status };
}

function CampaignsPageContent() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selected, setSelected] = useState<Campaign | null>(null);
  const [logs, setLogs] = useState<CallRow[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [agents, setAgents] = useState<AgentOption[]>([]);
  // Inline rename state — which campaign is being edited + the draft name.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [newAgentId, setNewAgentId] = useState<string>("");
  const [outboundOptions, setOutboundOptions] = useState<OutboundNumberOption[]>([]);
  const [newTrunkId, setNewTrunkId] = useState<string>("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const fetchCampaigns = useCallback(async () => {
    try {
      setCampaigns(await adminFetch<Campaign[]>("/campaigns"));
    } catch {
      // adminFetch already redirects to login on 401
    }
  }, []);

  const fetchLogs = useCallback(async (id: string) => {
    try {
      setLogs(await adminFetch<CallRow[]>(`/campaigns/${id}/logs`));
    } catch {
      // adminFetch already redirects to login on 401
    }
  }, []);

  const fetchOutboundOptions = useCallback(async () => {
    try {
      const opts = await adminFetch<OutboundNumberOption[]>("/campaigns/outbound-numbers");
      setOutboundOptions(opts);
      if (opts.length > 0) setNewTrunkId(prev => prev || opts[0].trunk_id);
    } catch {
      // adminFetch already redirects to login on 401
    }
  }, []);

  useEffect(() => {
    adminFetch<AgentOption[]>("/admin/agents")
      .then(data => {
        const list = Array.isArray(data) ? data : [];
        setAgents(list);
        if (list.length > 0) setNewAgentId(prev => prev || list[0].id);
      })
      .catch(() => setAgents([]));
    fetchCampaigns();
    fetchOutboundOptions();
    const t = setInterval(fetchCampaigns, 5000);
    return () => clearInterval(t);
  }, [fetchCampaigns, fetchOutboundOptions]);

  useEffect(() => {
    if (!selected) return;
    fetchLogs(selected.id);
    const t = setInterval(() => fetchLogs(selected.id), 4000);
    return () => clearInterval(t);
  }, [selected, fetchLogs]);

  // Keep selected in sync with campaigns list
  useEffect(() => {
    if (selected) {
      const updated = campaigns.find(c => c.id === selected.id);
      if (updated) setSelected(updated);
    }
  }, [campaigns]);

  const createCampaign = async () => {
    if (!newName.trim()) return;
    const chosen = outboundOptions.find(o => o.trunk_id === newTrunkId);
    try {
      await adminFetch("/campaigns", {
        method: "POST",
        body: JSON.stringify({
          name: newName,
          max_concurrent: 3,
          outbound_trunk_id: chosen?.trunk_id ?? null,
          caller_id_number: chosen?.number ?? null,
          agent_id: newAgentId || null,
        }),
      });
      setNewName("");
      setCreating(false);
      fetchCampaigns();
    } catch {
      // adminFetch already redirects to login on 401
    }
  };

  const uploadCSV = async (campaignId: string) => {
    if (!uploadFile) return;
    const fd = new FormData();
    fd.append("file", uploadFile);
    try {
      const data = await adminFetch<{ inserted?: number }>(`/campaigns/${campaignId}/upload`, {
        method: "POST",
        body: fd,
      });
      setMsg(`✅ ${data.inserted} números cargados`);
      setUploadFile(null);
      if (fileRef.current) fileRef.current.value = "";
      fetchCampaigns();
    } catch (err: unknown) {
      setMsg(`❌ ${err instanceof Error ? err.message : "Error al subir"}`);
    }
  };

  const action = async (campaignId: string, endpoint: string) => {
    try {
      await adminFetch(`/campaigns/${campaignId}/${endpoint}`, { method: "POST" });
      fetchCampaigns();
    } catch {
      // adminFetch already redirects to login on 401
    }
  };

  const startRename = (c: Campaign) => {
    setEditingId(c.id);
    setEditingName(c.name);
    setRenameError(null);
  };

  const cancelRename = () => {
    setEditingId(null);
    setEditingName("");
    setRenameError(null);
  };

  const saveRename = async (c: Campaign) => {
    const next = editingName.trim();
    if (!next) {
      setRenameError("El nombre no puede estar vacío");
      return;
    }
    if (next === c.name) {
      cancelRename();
      return;
    }
    setRenaming(true);
    setRenameError(null);
    try {
      await adminFetch(`/campaigns/${c.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: next }),
      });
      // Optimistic local update so the row flips immediately; the next
      // 5-second poll will reconcile against the server.
      setCampaigns((prev) => prev.map((x) => (x.id === c.id ? { ...x, name: next } : x)));
      if (selected?.id === c.id) setSelected((s) => (s ? { ...s, name: next } : s));
      cancelRename();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error al renombrar";
      setRenameError(msg);
    } finally {
      setRenaming(false);
    }
  };

  const deleteCampaign = async (campaignId: string, name: string) => {
    if (!confirm(`¿Eliminar la campaña "${name}"? Esta acción no se puede deshacer.`)) return;
    try {
      await adminFetch(`/campaigns/${campaignId}`, { method: "DELETE" });
      if (selected?.id === campaignId) setSelected(null);
      fetchCampaigns();
    } catch (err) {
      setMsg(`❌ ${err instanceof Error ? err.message : "Error al eliminar"}`);
    }
  };

  const fmt = (s: string | null) => s ? new Date(s).toLocaleString("es-MX") : "—";
  const dur = (sec: number | null) => sec ? `${Math.floor(sec / 60)}m ${sec % 60}s` : "—";

  // ── helpers ──────────────────────────────────────────────────────────────
  const pct = (n: number, total: number) =>
    total > 0 ? `${Math.round((n / total) * 100)}%` : "0%";

  // Map campaign status to a readable Spanish badge
  const CAMPAIGN_STATUS_LABELS: Record<string, string> = {
    draft: "Borrador",
    running: "En progreso",
    paused: "Pausada",
    completed: "Completada",
    cancelled: "Cancelada",
  };

  const CAMPAIGN_STATUS_STYLES: Record<string, string> = {
    draft:      "bg-white/10 text-gray-400",
    running:    "bg-amber-500/20 text-amber-300 border border-amber-500/30",
    paused:     "bg-yellow-500/15 text-yellow-300",
    completed:  "bg-blue-500/20 text-blue-300",
    cancelled:  "bg-red-500/15 text-red-400",
  };

  return (
    <AppShell title="Campañas de llamadas" description="Marcador masivo: sube un CSV y supervisa el progreso en vivo">

      {/* ── Toolbar ────────────────────────────────────────────────────────── */}
      <div className="flex justify-end mb-6">
        <button
          onClick={() => setCreating(true)}
          className="px-4 py-2 bg-brand-pink hover:bg-brand-purple rounded-lg text-sm font-medium transition-colors"
        >
          + Nueva campaña
        </button>
      </div>

      {msg && (
        <div className="mb-4 p-3 bg-white/5 border border-white/10 rounded-lg text-sm flex items-center justify-between">
          {msg}
          <button onClick={() => setMsg(null)} className="ml-2 text-gray-500 hover:text-white">✕</button>
        </div>
      )}

      {/* ── Create modal ───────────────────────────────────────────────────── */}
      {creating && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="glass-card rounded-2xl p-6 w-80">
            <h2 className="font-semibold mb-4">Nueva campaña</h2>
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="Nombre de la campaña"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:border-brand-pink/60"
              onKeyDown={e => e.key === "Enter" && createCampaign()}
              autoFocus
            />
            <label className="block text-xs text-gray-400 mb-1">Agente (define prompt, voz y cliente asignado)</label>
            <select
              value={newAgentId}
              onChange={e => setNewAgentId(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:border-brand-pink/60"
            >
              {agents.length === 0 && <option value="">Sin agentes</option>}
              {agents.map(a => (
                <option key={a.id} value={a.id}>
                  {a.name}{a.is_active ? "" : " (inactivo)"}
                </option>
              ))}
            </select>
            <label className="block text-xs text-gray-400 mb-1">Número de salida (Caller ID)</label>
            <select
              value={newTrunkId}
              onChange={e => setNewTrunkId(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:border-brand-pink/60"
            >
              {outboundOptions.map(opt => (
                <option key={opt.trunk_id} value={opt.trunk_id}>
                  {opt.label} — {opt.number}
                </option>
              ))}
            </select>
            <div className="flex gap-2">
              <button onClick={createCampaign} className="flex-1 py-2 bg-brand-pink hover:bg-brand-purple rounded-lg text-sm transition-colors">Crear</button>
              <button onClick={() => setCreating(false)} className="flex-1 py-2 bg-white/5 hover:bg-white/10 rounded-lg text-sm transition-colors">Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Campaigns table ────────────────────────────────────────────────── */}
      <div className="glass-card rounded-2xl overflow-hidden mb-4">
        {campaigns.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-10">No hay campañas aún. Crea la primera.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-white/[0.03] border-b border-white/10">
              <tr>
                <th className="px-5 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider w-48">
                  Campaña
                </th>
                <th className="px-5 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-5 py-3 text-center text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Total llamadas
                </th>
                <th className="px-5 py-3 text-center text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Marcadas
                </th>
                <th className="px-5 py-3 text-center text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Contestó
                </th>
                <th className="px-5 py-3 text-center text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Buzón
                </th>
                <th className="px-5 py-3 text-center text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Sin resp.
                </th>
                <th className="px-5 py-3 text-center text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Progreso
                </th>
                <th className="px-5 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Acciones
                </th>
                <th className="px-3 py-3 w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {campaigns.map(c => (
                <React.Fragment key={c.id}>
                  {/* ── Campaign row ── */}
                  <tr
                    className={`hover:bg-white/[0.03] transition-colors cursor-pointer ${selected?.id === c.id ? "bg-white/[0.05]" : ""}`}
                    onClick={() => setSelected(selected?.id === c.id ? null : c)}
                  >
                    {/* Name + caller ID (inline-editable) */}
                    <td className="px-5 py-3.5" onClick={(e) => e.stopPropagation()}>
                      {editingId === c.id ? (
                        <div className="space-y-1">
                          <div className="flex items-center gap-1.5">
                            <input
                              autoFocus
                              value={editingName}
                              onChange={(e) => setEditingName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveRename(c);
                                if (e.key === "Escape") cancelRename();
                              }}
                              disabled={renaming}
                              className="flex-1 min-w-0 bg-white/[0.06] border border-white/15 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-brand-pink/60"
                              placeholder="Nombre de la campaña"
                            />
                            <button
                              onClick={() => saveRename(c)}
                              disabled={renaming}
                              title="Guardar"
                              className="p-1.5 rounded text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-40"
                            >
                              <Check className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={cancelRename}
                              disabled={renaming}
                              title="Cancelar"
                              className="p-1.5 rounded text-gray-400 hover:bg-white/5 disabled:opacity-40"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                          {renameError && (
                            <p className="text-[10px] text-rose-400">{renameError}</p>
                          )}
                        </div>
                      ) : (
                        <div className="group flex items-center gap-2">
                          <p className="font-medium text-gray-100 text-sm">{c.name}</p>
                          <button
                            onClick={() => startRename(c)}
                            title="Renombrar campaña"
                            className="p-1 rounded text-gray-500 hover:text-white hover:bg-white/5 opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                        </div>
                      )}
                      {c.caller_id_number && (
                        <p className="text-xs text-gray-500 mt-0.5">📞 {c.caller_id_number}</p>
                      )}
                    </td>

                    {/* Status badge */}
                    <td className="px-5 py-3.5">
                      <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${CAMPAIGN_STATUS_STYLES[c.status] ?? "bg-white/10 text-gray-400"}`}>
                        {CAMPAIGN_STATUS_LABELS[c.status] ?? c.status}
                      </span>
                    </td>

                    {/* Total numbers */}
                    <td className="px-5 py-3.5 text-center">
                      <span className="font-semibold text-gray-100">{c.total_numbers}</span>
                    </td>

                    {/* Called (marcadas) */}
                    <td className="px-5 py-3.5 text-center">
                      <span className="font-semibold text-gray-100">{c.called}</span>
                      <span className="text-xs text-gray-500 ml-1">({pct(c.called, c.total_numbers)})</span>
                    </td>

                    {/* Answered / Pick up */}
                    <td className="px-5 py-3.5 text-center">
                      <span className="font-semibold text-emerald-400">{c.answered}</span>
                      {c.called > 0 && (
                        <span className="text-xs text-gray-500 ml-1">({pct(c.answered, c.called)})</span>
                      )}
                    </td>

                    {/* Voicemail */}
                    <td className="px-5 py-3.5 text-center">
                      <span className="font-semibold text-purple-400">{c.voicemail}</span>
                      {c.called > 0 && (
                        <span className="text-xs text-gray-500 ml-1">({pct(c.voicemail, c.called)})</span>
                      )}
                    </td>

                    {/* No answer */}
                    <td className="px-5 py-3.5 text-center">
                      <span className="font-semibold text-yellow-400">{c.no_answer}</span>
                      {c.called > 0 && (
                        <span className="text-xs text-gray-500 ml-1">({pct(c.no_answer, c.called)})</span>
                      )}
                    </td>

                    {/* Progress bar */}
                    <td className="px-5 py-3.5 min-w-[100px]">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 bg-white/5 rounded-full h-1.5">
                          <div
                            className="bg-brand-pink h-1.5 rounded-full transition-all"
                            style={{ width: pct(c.called, c.total_numbers) }}
                          />
                        </div>
                        <span className="text-xs text-gray-500 w-8 text-right">{pct(c.called, c.total_numbers)}</span>
                      </div>
                    </td>

                    {/* Action buttons */}
                    <td className="px-5 py-3.5" onClick={e => e.stopPropagation()}>
                      <div className="flex gap-1 flex-wrap">
                        {c.status === "draft" && (
                          <>
                            <label className="px-2 py-1 bg-white/5 hover:bg-white/10 rounded text-xs cursor-pointer transition-colors text-gray-300">
                              📎 CSV
                              <input
                                type="file"
                                accept=".csv,text/csv"
                                className="hidden"
                                onChange={e => {
                                  // S3.4 — client-side size + MIME guard. The
                                  // server also enforces 25 MB (see
                                  // _body_size_limit_middleware), but failing
                                  // fast in the browser gives the user a
                                  // better error and avoids a wasted upload.
                                  const f = e.target.files?.[0];
                                  if (!f) { setUploadFile(null); return; }
                                  const MAX = 25 * 1024 * 1024;
                                  if (f.size > MAX) {
                                    alert(`CSV demasiado grande (${(f.size / 1024 / 1024).toFixed(1)} MB). Máximo 25 MB.`);
                                    e.target.value = "";
                                    setUploadFile(null);
                                    return;
                                  }
                                  const isCSV = f.name.toLowerCase().endsWith(".csv") || f.type === "text/csv";
                                  if (!isCSV) {
                                    alert("Solo se aceptan archivos .csv");
                                    e.target.value = "";
                                    setUploadFile(null);
                                    return;
                                  }
                                  setUploadFile(f);
                                  setSelected(c);
                                }}
                              />
                            </label>
                            {uploadFile && selected?.id === c.id && (
                              <button onClick={() => uploadCSV(c.id)} className="px-2 py-1 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 rounded text-xs transition-colors">
                                Subir
                              </button>
                            )}
                            <button onClick={() => action(c.id, "start")} className="px-2 py-1 bg-brand-pink hover:bg-brand-purple rounded text-xs transition-colors">
                              ▶ Iniciar
                            </button>
                          </>
                        )}
                        {c.status === "running" && (
                          <button onClick={() => action(c.id, "pause")} className="px-2 py-1 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 rounded text-xs transition-colors">
                            ⏸ Pausar
                          </button>
                        )}
                        {c.status === "paused" && (
                          <button onClick={() => action(c.id, "resume")} className="px-2 py-1 bg-brand-pink hover:bg-brand-purple rounded text-xs transition-colors">
                            ▶ Reanudar
                          </button>
                        )}
                        {["running", "paused"].includes(c.status) && (
                          <button onClick={() => action(c.id, "stop")} className="px-2 py-1 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 rounded text-xs transition-colors">
                            ■ Stop
                          </button>
                        )}
                        {["completed", "cancelled"].includes(c.status) && (
                          <button onClick={() => action(c.id, "restart")} className="px-2 py-1 bg-brand-pink hover:bg-brand-purple rounded text-xs transition-colors">
                            🔄 Relanzar
                          </button>
                        )}
                        {c.status !== "running" && (
                          <button
                            onClick={() => deleteCampaign(c.id, c.name)}
                            className="px-2 py-1 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 rounded text-xs transition-colors"
                          >
                            🗑
                          </button>
                        )}
                      </div>
                    </td>

                    {/* Expand arrow */}
                    <td className="px-3 py-3.5 text-gray-500 text-sm">
                      <span className={`transition-transform inline-block ${selected?.id === c.id ? "rotate-90" : ""}`}>›</span>
                    </td>
                  </tr>

                  {/* ── Inline call logs (expanded) ── */}
                  {selected?.id === c.id && (
                    <tr key={`${c.id}-logs`}>
                      <td colSpan={10} className="px-0 py-0 bg-black/20 border-t border-white/5">
                        <div className="px-6 py-4">
                          <div className="flex items-center justify-between mb-3">
                            <h3 className="text-sm font-semibold text-gray-200">
                              Llamadas — {c.name}
                            </h3>
                            <span className="text-xs text-gray-500">{logs.length} registros</span>
                          </div>
                          <div className="overflow-y-auto max-h-[55vh] rounded-xl border border-white/5">
                            <table className="w-full text-sm">
                              <thead className="bg-white/[0.03] text-xs text-gray-400 uppercase sticky top-0">
                                <tr>
                                  <th className="px-4 py-2 text-left">Número</th>
                                  <th className="px-4 py-2 text-left">Nombre</th>
                                  <th className="px-4 py-2 text-left">Estado</th>
                                  <th className="px-4 py-2 text-left">Duración</th>
                                  <th className="px-4 py-2 text-left">Inicio</th>
                                  <th className="px-4 py-2 text-left">Grabación</th>
                                  <th className="px-4 py-2 text-left">Transcript</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-white/5">
                                {logs.map(row => (
                                  <React.Fragment key={row.id}>
                                    <tr className="hover:bg-white/[0.03]">
                                      <td className="px-4 py-2 font-mono text-xs">{row.phone_number}</td>
                                      <td className="px-4 py-2 text-xs text-gray-300">{row.customer_name ?? "—"}</td>
                                      <td className="px-4 py-2">
                                        {(() => { const d = callDisplayStatus(row); return (
                                          <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[d.key] ?? "bg-white/10 text-gray-400"}`}>
                                            {d.label}
                                          </span>
                                        ); })()}
                                      </td>
                                      <td className="px-4 py-2 text-xs text-gray-400">{dur(row.duration_seconds)}</td>
                                      <td className="px-4 py-2 text-xs text-gray-400">{fmt(row.started_at)}</td>
                                      <td className="px-4 py-2">
                                        <RecordingButton
                                          sessionId={row.session_id}
                                          hasUrl={!!row.recording_url}
                                          canFetch={!!row.twilio_call_sid}
                                        />
                                      </td>
                                      <td className="px-4 py-2">
                                        {row.transcript && (
                                          <button
                                            onClick={() => setExpandedRow(expandedRow === row.id ? null : row.id)}
                                            className="text-xs text-fuchsia-300 hover:text-fuchsia-200"
                                          >
                                            {expandedRow === row.id ? "▲ Ocultar" : "▼ Ver"}
                                          </button>
                                        )}
                                      </td>
                                    </tr>
                                    {expandedRow === row.id && row.transcript && (
                                      <tr key={`${row.id}-transcript`}>
                                        <td colSpan={7} className="px-4 py-3 bg-black/20">
                                          <pre className="text-xs text-gray-300 whitespace-pre-wrap font-mono leading-relaxed">
                                            {row.transcript}
                                          </pre>
                                          {row.error_msg && (
                                            <p className="text-xs text-rose-300 mt-2">Error: {row.error_msg}</p>
                                          )}
                                        </td>
                                      </tr>
                                    )}
                                  </React.Fragment>
                                ))}
                              </tbody>
                            </table>
                            {logs.length === 0 && (
                              <p className="text-center text-gray-500 py-8 text-sm">Sin registros aún</p>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </AppShell>
  );
}

export default function CampaignsPage() {
  return (
    <AdminAuthGuard>
      <CampaignsPageContent />
    </AdminAuthGuard>
  );
}
