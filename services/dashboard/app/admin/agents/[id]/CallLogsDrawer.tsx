"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  X,
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  Loader2,
  Mic,
  Play,
  Pause,
  FileText,
  Rewind,
  FastForward,
  Search,
} from "lucide-react";
import { adminFetch, getAPI, getToken } from "@/lib/admin-auth";
import { cn } from "@/lib/utils";

interface Call {
  id: string;
  direction: "inbound" | "outbound";
  from_number: string | null;
  to_number: string | null;
  room_name: string | null;
  status: string;
  status_label?: string;
  duration_seconds: number;
  cost_usd: number;
  started_at: string;
  ended_at: string | null;
  transcript?: string | null;
  recording_url?: string | null;
  twilio_call_sid?: string | null;
}

interface Props {
  agentId: string;
  agentName: string;
  open: boolean;
  onClose: () => void;
}

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  in_progress:   { label: "En curso",      className: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300" },
  completed:     { label: "Completada",    className: "border-blue-500/40 bg-blue-500/15 text-blue-300" },
  client_hangup: { label: "Colgó cliente", className: "border-slate-500/40 bg-slate-500/15 text-slate-300" },
  voicemail:     { label: "Buzón",         className: "border-purple-500/40 bg-purple-500/15 text-purple-300" },
  no_answer:     { label: "Sin respuesta", className: "border-yellow-500/40 bg-yellow-500/15 text-yellow-300" },
  failed:        { label: "Fallida",       className: "border-red-500/40 bg-red-500/15 text-red-300" },
};

const fmt = (s: string) => new Date(s).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" });
const dur = (sec: number) => (sec > 0 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : "—");

/**
 * Slide-over that shows calls belonging to a single agent.
 * Polls /admin/agents/{id}/calls every 5s while open; cleans up on close.
 */
export default function CallLogsDrawer({ agentId, agentName, open, onClose }: Props) {
  const [calls, setCalls] = useState<Call[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await adminFetch<Call[]>(`/admin/agents/${agentId}/calls?limit=100`);
      setCalls(Array.isArray(data) ? data : []);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "No se pudo cargar el historial");
    }
  }, [agentId]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    load().finally(() => setLoading(false));
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [open, load]);

  if (!open) return null;

  const filtered = search.trim()
    ? calls.filter((c) => {
        const q = search.toLowerCase();
        return (
          (c.to_number ?? "").toLowerCase().includes(q) ||
          (c.from_number ?? "").toLowerCase().includes(q) ||
          (c.status ?? "").toLowerCase().includes(q) ||
          (c.id ?? "").toLowerCase().includes(q)
        );
      })
    : calls;

  // Per-call totals by status for the header summary
  const counts = filtered.reduce(
    (acc, c) => {
      acc[c.status] = (acc[c.status] || 0) + 1;
      acc.total += 1;
      return acc;
    },
    { total: 0 } as Record<string, number>,
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-gray-900 border-l border-white/10 h-full flex flex-col shadow-2xl">
        {/* Header */}
        <header className="p-4 border-b border-white/10 flex justify-between items-center gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-gray-100 flex items-center gap-2">
              <Phone className="w-4 h-4 text-emerald-300" />
              Llamadas de {agentName}
            </h3>
            <p className="text-[10px] text-gray-500 mt-0.5">
              {counts.total} {counts.total === 1 ? "llamada" : "llamadas"}
              {Object.entries(counts).filter(([k]) => k !== "total" && counts[k]).length > 0 && (
                <span className="ml-2">
                  {Object.entries(counts)
                    .filter(([k, v]) => k !== "total" && v > 0)
                    .map(([k, v]) => `${STATUS_CONFIG[k]?.label ?? k}: ${v}`)
                    .join(" · ")}
                </span>
              )}
            </p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
            aria-label="Cerrar"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {/* Search */}
        <div className="p-3 border-b border-white/5">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por número, estado, ID…"
              className="w-full bg-white/5 border border-white/10 rounded-lg pl-8 pr-3 py-1.5 text-xs focus:outline-none focus:border-brand-pink/60"
            />
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {loading && calls.length === 0 ? (
            <div className="flex justify-center py-10">
              <Loader2 className="w-5 h-5 animate-spin text-gray-500" />
            </div>
          ) : error ? (
            <p className="text-rose-300 text-xs p-3 rounded bg-rose-500/10 border border-rose-400/20">
              ❌ {error}
            </p>
          ) : filtered.length === 0 ? (
            <div className="text-center py-10">
              <Phone className="w-8 h-8 text-gray-700 mx-auto mb-2" />
              <p className="text-sm text-gray-500">
                {calls.length === 0 ? "Este agente aún no tiene llamadas." : "Sin resultados para esa búsqueda."}
              </p>
            </div>
          ) : (
            filtered.map((c) => <CallRow key={c.id} call={c} />)
          )}
        </div>
      </div>
    </div>
  );
}

function CallRow({ call: c }: { call: Call }) {
  const [expanded, setExpanded] = useState(false);
  const statusCfg = STATUS_CONFIG[c.status] ?? { label: c.status_label ?? c.status, className: "border-gray-500/40 bg-gray-500/15 text-gray-300" };

  return (
    <div className="bg-white/[0.03] border border-white/10 rounded-lg p-3 hover:border-white/20 transition-colors">
      <div className="flex justify-between items-start gap-3">
        <div className="flex items-start gap-2.5 min-w-0 flex-1">
          <div
            className={cn(
              "mt-0.5 w-7 h-7 rounded-lg flex items-center justify-center shrink-0",
              c.direction === "inbound" ? "bg-cyan-500/15" : "bg-brand-pink/15",
            )}
          >
            {c.direction === "inbound" ? (
              <PhoneIncoming className="w-3.5 h-3.5 text-cyan-400" />
            ) : (
              <PhoneOutgoing className="w-3.5 h-3.5 text-brand-pink" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-0.5 flex-wrap">
              <span className="text-xs font-medium text-gray-100">
                {c.direction === "inbound" ? "Entrante" : "Saliente"}
              </span>
              <span
                className={cn(
                  "text-[10px] px-1.5 py-0.5 rounded border",
                  statusCfg.className,
                )}
              >
                {statusCfg.label}
              </span>
            </div>
            <p className="text-xs text-gray-400 font-mono truncate">
              {c.direction === "inbound" ? c.from_number ?? "—" : c.to_number ?? "—"}
            </p>
            <p className="text-[10px] text-gray-600 mt-0.5">
              {fmt(c.started_at)} · {dur(c.duration_seconds)}
            </p>
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="text-xs font-semibold text-emerald-300 font-mono">
            ${Number(c.cost_usd).toFixed(4)}
          </p>
        </div>
      </div>

      {/* Recording + transcript row */}
      <div className="flex items-center gap-3 mt-2.5 pt-2.5 border-t border-white/5 flex-wrap">
        <RecordingCell
          sessionId={c.id}
          hasRecording={!!c.recording_url}
          canFetch={!!c.twilio_call_sid}
        />
        {c.transcript ? (
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1.5 text-[10px] text-fuchsia-300 hover:text-fuchsia-200 transition-colors"
          >
            <FileText className="w-3 h-3" />
            {expanded ? "Ocultar transcript" : "Ver transcript"}
          </button>
        ) : (
          <span className="text-[10px] text-gray-600 flex items-center gap-1">
            <Mic className="w-3 h-3" /> Sin transcript
          </span>
        )}
      </div>

      {expanded && c.transcript && (
        <pre className="text-[10px] text-gray-300 whitespace-pre-wrap font-mono leading-relaxed mt-2 p-2 rounded bg-black/30 border border-white/5 max-h-48 overflow-y-auto">
          {c.transcript
            .replace(/\[Camila\]/g, "🤖 Camila")
            .replace(/\[Cliente\]/g, "👤 Cliente")}
        </pre>
      )}
    </div>
  );
}

function RecordingCell({
  sessionId,
  hasRecording,
  canFetch,
}: {
  sessionId: string;
  hasRecording: boolean;
  canFetch?: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  // S4.5 — revoke blob URL on unmount + when audio changes.
  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  const load = async () => {
    if (audioUrl) return;
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

  if (!hasRecording && !canFetch && !audioUrl)
    return <span className="text-[10px] text-gray-600">—</span>;
  if (error) return <span className="text-[10px] text-rose-400">No disponible</span>;
  if (audioUrl) return <AudioPlayer src={audioUrl} />;
  return (
    <button
      onClick={load}
      disabled={loading}
      className="flex items-center gap-1 text-[10px] text-emerald-300 hover:text-emerald-200 disabled:opacity-50 transition-colors"
    >
      {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
      {loading ? "Cargando…" : "Escuchar"}
    </button>
  );
}

function AudioPlayer({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [dragging, setDragging] = useState(false);

  const fmtTime = (s: number) =>
    `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
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
    setProgress(next / duration);
  };
  const seekToClientX = useCallback(
    (clientX: number) => {
      const a = audioRef.current;
      const bar = barRef.current;
      if (!a || !bar || !duration) return;
      const rect = bar.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      a.currentTime = ratio * duration;
      setCurrent(ratio * duration);
      setProgress(ratio);
    },
    [duration],
  );
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

  return (
    <div className="flex items-center gap-1.5 w-64 bg-white/5 border border-white/10 rounded-md px-2 py-1">
      <audio
        ref={audioRef}
        src={src}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setProgress(0);
          setCurrent(0);
        }}
        onLoadedMetadata={() => setDuration(audioRef.current?.duration ?? 0)}
        onTimeUpdate={() => {
          if (dragging) return;
          const a = audioRef.current;
          if (!a || !a.duration) return;
          setCurrent(a.currentTime);
          setProgress(a.currentTime / a.duration);
        }}
      />
      <button
        onClick={() => skip(-10)}
        title="Retroceder 10s"
        className="shrink-0 w-4 h-4 flex items-center justify-center rounded-full text-gray-400 hover:text-white"
      >
        <Rewind className="w-3 h-3" />
      </button>
      <button
        onClick={toggle}
        className="shrink-0 w-5 h-5 flex items-center justify-center rounded-full bg-brand-pink hover:bg-brand-purple text-white"
      >
        {playing ? <Pause className="w-2.5 h-2.5" /> : <Play className="w-2.5 h-2.5 ml-0.5" />}
      </button>
      <button
        onClick={() => skip(10)}
        title="Adelantar 10s"
        className="shrink-0 w-4 h-4 flex items-center justify-center rounded-full text-gray-400 hover:text-white"
      >
        <FastForward className="w-3 h-3" />
      </button>
      <div className="flex-1 flex flex-col gap-0.5 min-w-0">
        <div
          ref={barRef}
          className="relative h-2.5 flex items-center cursor-pointer group touch-none"
          onPointerDown={onPointerDown}
        >
          <div className="absolute inset-x-0 h-1 rounded-full bg-white/15" />
          <div
            className="absolute left-0 h-1 rounded-full bg-gradient-to-r from-brand-pink to-brand-purple"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
        <div className="flex justify-between text-[9px] text-gray-500 leading-none">
          <span>{fmtTime(current)}</span>
          <span>{duration ? fmtTime(duration) : "--:--"}</span>
        </div>
      </div>
    </div>
  );
}
