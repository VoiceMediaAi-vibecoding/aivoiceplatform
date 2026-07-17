"use client";

import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import {
  PhoneCall, PhoneIncoming, PhoneOutgoing, Megaphone, Activity,
  Clock, TrendingUp, Play, Pause, FileText, ChevronRight,
  LogOut, Loader2, BarChart3, CheckCircle2, VoicemailIcon,
  PhoneMissed, XCircle, Rewind, FastForward,
} from "lucide-react";
import {
  fetchCampaigns, fetchCampaignCalls, fetchCalls, fetchMe,
  clearToken, getToken,
  type Campaign, type CallRow, type InboundCall, type PortalClient,
} from "@/lib/portal-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { getApiBaseUrl } from "@/lib/api-config";
import PortalAuthGuard from "@/app/portal/PortalAuthGuard";

/* ── Status config ─────────────────────────────────────────────────────────── */

const CALL_STATUS: Record<string, { label: string; className: string; Icon: React.ElementType }> = {
  in_progress:   { label: "En curso",      className: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",  Icon: PhoneCall },
  completed:     { label: "Completada",    className: "border-blue-500/40 bg-blue-500/15 text-blue-300",           Icon: CheckCircle2 },
  answered:      { label: "Contestó",      className: "border-blue-500/40 bg-blue-500/15 text-blue-300",           Icon: CheckCircle2 },
  client_hangup: { label: "Colgó cliente", className: "border-slate-500/40 bg-slate-500/15 text-slate-300",        Icon: PhoneCall },
  voicemail:     { label: "Buzón de voz",  className: "border-purple-500/40 bg-purple-500/15 text-purple-300",     Icon: VoicemailIcon },
  no_answer:     { label: "Sin respuesta", className: "border-yellow-500/40 bg-yellow-500/15 text-yellow-300",     Icon: PhoneMissed },
  failed:        { label: "Fallida",       className: "border-red-500/40 bg-red-500/15 text-red-300",              Icon: XCircle },
  pending:       { label: "Pendiente",     className: "border-gray-500/40 bg-gray-500/15 text-gray-400",           Icon: Clock },
  calling:       { label: "Marcando",      className: "border-cyan-500/40 bg-cyan-500/15 text-cyan-300",           Icon: PhoneCall },
};

const CAMPAIGN_STATUS: Record<string, { label: string; dot: string }> = {
  running:   { label: "En curso",    dot: "bg-emerald-400" },
  completed: { label: "Finalizada",  dot: "bg-blue-400" },
  paused:    { label: "Pausada",     dot: "bg-yellow-400" },
  draft:     { label: "Borrador",    dot: "bg-gray-400" },
  cancelled: { label: "Cancelada",   dot: "bg-red-400" },
};

const dur = (sec: number | null) => sec ? `${Math.floor(sec / 60)}m ${sec % 60}s` : "—";
const fmt = (s: string | null) => s ? new Date(s).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" }) : "—";

type Tab = "campaigns" | "calllog";

/* ══════════════════════════════════════════════════════════════════════════════
   Main page
══════════════════════════════════════════════════════════════════════════════ */

export default function PortalPage() {
  return (
    <PortalAuthGuard>
      <PortalPageInner />
    </PortalAuthGuard>
  );
}

function PortalPageInner() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("campaigns");
  const [client, setClient] = useState<PortalClient | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selected, setSelected] = useState<Campaign | null>(null);
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);

  const [callLog, setCallLog] = useState<InboundCall[]>([]);
  const [callLogLoading, setCallLogLoading] = useState(false);
  const [expandedCall, setExpandedCall] = useState<string | null>(null);

  // S2.3 — auth check moved to PortalAuthGuard. The guard renders nothing
  // until the token is verified, so we don't need an inline redirect here.

  const loadBase = useCallback(async () => {
    try {
      const [me, cmp] = await Promise.all([fetchMe(), fetchCampaigns()]);
      setClient(me.client);
      setCampaigns(cmp);
    } catch {
      // S2.3 — the apiFetch helper now handles 401 centrally (clears the
      // token + redirects to /login). We just stop loading on any other error.
      // If apiFetch itself raised, it was already past the redirect — no-op.
      setError("Error al cargar datos");
    }
  }, []);

  useEffect(() => {
    loadBase();
    const t = setInterval(loadBase, 10000);
    return () => clearInterval(t);
  }, [loadBase]);

  const loadCallLog = useCallback(async () => {
    setCallLogLoading(true);
    try { setCallLog(await fetchCalls()); }
    catch { setError("Error al cargar el call log"); }
    finally { setCallLogLoading(false); }
  }, []);

  useEffect(() => { loadCallLog(); }, [loadCallLog]);
  useEffect(() => {
    if (tab !== "calllog") return;
    const t = setInterval(loadCallLog, 10000);
    return () => clearInterval(t);
  }, [tab, loadCallLog]);

  const selectCampaign = useCallback(async (c: Campaign) => {
    setSelected(c);
    setCalls([]);
    setExpanded(null);
    try { setCalls(await fetchCampaignCalls(c.id)); }
    catch { setError("Error al cargar llamadas"); }
  }, []);

  useEffect(() => {
    if (!selected) return;
    const t = setInterval(async () => {
      try { setCalls(await fetchCampaignCalls(selected.id)); } catch { /* noop */ }
    }, 5000);
    return () => clearInterval(t);
  }, [selected]);

  const logout = () => { clearToken(); router.replace("/login"); };

  /* ── Hero KPI stats ── */
  const stats = useMemo(() => {
    const now = new Date();
    const thisMonth = callLog.filter((c) => {
      if (!c.started_at) return false;
      const d = new Date(c.started_at);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    });
    const totalSecs = callLog.reduce((s, c) => s + (c.duration_seconds ?? 0), 0);
    const answered = callLog.filter((c) => ["answered", "completed", "in_progress"].includes(c.status)).length;
    return {
      thisMonth: thisMonth.length,
      minutes: Math.round(totalSecs / 60),
      rate: callLog.length ? Math.round((answered / callLog.length) * 100) : 0,
      live: campaigns.find((c) => c.status === "running"),
    };
  }, [callLog, campaigns]);

  return (
    <div className="min-h-screen text-white">

      {/* ── Top nav ── */}
      <header className="sticky top-0 z-30 glass-panel border-b border-white/5 px-6 py-3 flex items-center justify-between gap-4">
        <Image src="/logo.png" alt="voicemedia.ai" width={130} height={34} className="object-contain" priority />
        <div className="flex items-center gap-3">
          {client && (
            <div className="hidden sm:flex flex-col items-end leading-tight">
              <span className="text-xs font-medium text-gray-200">{client.name}</span>
              <span className="text-[10px] text-gray-500">{client.email}</span>
            </div>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={logout}
            className="gap-1.5 text-gray-400 hover:text-white hover:bg-white/10 text-xs"
          >
            <LogOut className="w-3.5 h-3.5" />
            Salir
          </Button>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">

        {/* ── KPI hero row ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KpiCard
            label="Llamadas este mes"
            value={String(stats.thisMonth)}
            sub={`${callLog.length} en total`}
            icon={<PhoneCall className="w-5 h-5" />}
            gradient="from-brand-pink to-brand-purple"
          />
          <KpiCard
            label="Minutos usados"
            value={`${stats.minutes.toLocaleString("es-MX")}`}
            sub="minutos acumulados"
            icon={<Clock className="w-5 h-5" />}
            gradient="from-brand-purple to-brand-blue"
          />
          <KpiCard
            label="Tasa de respuesta"
            value={callLog.length ? `${stats.rate}%` : "—"}
            sub="contestadas vs. total"
            icon={<TrendingUp className="w-5 h-5" />}
            gradient="from-emerald-400 to-cyan-500"
          />
          <KpiCard
            label="Campañas activas"
            value={String(campaigns.filter(c => c.status === "running").length)}
            sub={`${campaigns.length} campañas en total`}
            icon={<Megaphone className="w-5 h-5" />}
            gradient="from-amber-400 to-orange-500"
          />
        </div>

        {/* Live campaign banner */}
        {stats.live && (
          <div className="flex items-center gap-3 px-5 py-3.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10">
            <span className="status-dot bg-emerald-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-emerald-300">Campaña en curso: <span className="text-white">{stats.live.name}</span></p>
              <p className="text-xs text-emerald-400/70">
                {stats.live.called} / {stats.live.total_numbers} llamadas · {stats.live.answered} contestadas
              </p>
            </div>
            <div className="shrink-0 w-24 bg-white/10 rounded-full h-1.5">
              <div
                className="bg-emerald-400 h-1.5 rounded-full transition-all"
                style={{ width: `${stats.live.total_numbers > 0 ? (stats.live.called / stats.live.total_numbers) * 100 : 0}%` }}
              />
            </div>
          </div>
        )}

        {/* ── Tab nav ── */}
        <div className="flex gap-1 border-b border-white/10">
          <TabBtn active={tab === "campaigns"} onClick={() => setTab("campaigns")}>
            <Megaphone className="w-3.5 h-3.5" /> Campañas
          </TabBtn>
          <TabBtn active={tab === "calllog"} onClick={() => setTab("calllog")}>
            <BarChart3 className="w-3.5 h-3.5" /> Call Log
          </TabBtn>
        </div>

        {error && (
          <div className="p-3 rounded-xl border border-rose-400/30 bg-rose-500/10 text-rose-300 text-sm flex justify-between">
            {error}
            <button onClick={() => setError(null)} className="opacity-60 hover:opacity-100 ml-3">✕</button>
          </div>
        )}

        {/* ── Campaigns tab ── */}
        {tab === "campaigns" && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            {/* List */}
            <div className="space-y-3">
              <p className="text-[11px] uppercase tracking-widest text-gray-500">Campañas ({campaigns.length})</p>
              {campaigns.length === 0 && (
                <Card className="bg-white/[0.03] border-white/10">
                  <CardContent className="p-8 text-center text-gray-500 text-sm">Sin campañas disponibles</CardContent>
                </Card>
              )}
              {campaigns.map((c) => {
                const st = CAMPAIGN_STATUS[c.status] ?? { label: c.status, dot: "bg-gray-400" };
                const pct = c.total_numbers > 0 ? Math.round((c.called / c.total_numbers) * 100) : 0;
                return (
                  <button
                    key={c.id}
                    onClick={() => selectCampaign(c)}
                    className={cn(
                      "w-full text-left glass-card rounded-2xl p-4 transition-all group",
                      selected?.id === c.id
                        ? "border-brand-pink/50 bg-brand-pink/5"
                        : "hover:border-white/20"
                    )}
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <p className="font-medium text-sm text-gray-100 group-hover:text-white transition-colors">{c.name}</p>
                        <div className="flex items-center gap-1.5 mt-1">
                          <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", st.dot)} />
                          <span className="text-xs text-gray-500">{st.label}</span>
                        </div>
                      </div>
                      <ChevronRight className={cn(
                        "w-4 h-4 shrink-0 mt-0.5 transition-colors",
                        selected?.id === c.id ? "text-brand-pink" : "text-gray-600 group-hover:text-gray-400"
                      )} />
                    </div>

                    {/* Mini stats */}
                    <div className="grid grid-cols-3 gap-1.5 mb-3">
                      {[
                        { label: "Total", val: c.total_numbers },
                        { label: "Contestó", val: c.answered },
                        { label: "Sin resp.", val: c.no_answer },
                      ].map(({ label, val }) => (
                        <div key={label} className="bg-white/5 rounded-lg p-2 text-center">
                          <p className="text-xs font-semibold text-gray-200">{val}</p>
                          <p className="text-[10px] text-gray-500">{label}</p>
                        </div>
                      ))}
                    </div>

                    {/* Progress bar */}
                    <div className="space-y-1">
                      <div className="flex justify-between text-[10px] text-gray-500">
                        <span>{c.called} llamadas realizadas</span>
                        <span>{pct}%</span>
                      </div>
                      <div className="w-full bg-white/5 rounded-full h-1.5">
                        <div
                          className={cn(
                            "h-1.5 rounded-full transition-all",
                            c.status === "running" ? "bg-gradient-to-r from-brand-pink to-brand-purple" : "bg-white/20"
                          )}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Detail */}
            <div className="lg:col-span-2">
              {!selected ? (
                <Card className="bg-white/[0.02] border-white/10 h-full min-h-[300px]">
                  <CardContent className="h-full flex flex-col items-center justify-center gap-3 text-gray-500 py-16">
                    <Megaphone className="w-10 h-10 opacity-20" />
                    <p className="text-sm">Selecciona una campaña para ver el detalle</p>
                  </CardContent>
                </Card>
              ) : (
                <div className="glass-card rounded-2xl overflow-hidden">
                  <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
                    <div>
                      <h2 className="font-semibold text-gray-100">{selected.name}</h2>
                      <p className="text-xs text-gray-500 mt-0.5">{calls.length} registros</p>
                    </div>
                    <Badge variant="outline" className={cn(
                      "text-xs",
                      CAMPAIGN_STATUS[selected.status]?.dot === "bg-emerald-400"
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                        : "border-white/10 text-gray-400"
                    )}>
                      {CAMPAIGN_STATUS[selected.status]?.label ?? selected.status}
                    </Badge>
                  </div>
                  <div className="overflow-y-auto max-h-[65vh]">
                    <table className="w-full text-sm">
                      <thead className="bg-white/[0.03] text-[11px] text-gray-500 uppercase tracking-wide sticky top-0">
                        <tr>
                          <th className="px-4 py-2.5 text-left">Número</th>
                          <th className="px-4 py-2.5 text-left">Nombre</th>
                          <th className="px-4 py-2.5 text-left">Estado</th>
                          <th className="px-4 py-2.5 text-left">Duración</th>
                          <th className="px-4 py-2.5 text-left">Fecha</th>
                          <th className="px-4 py-2.5 text-left">Detalle</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {calls.map((row) => {
                          // Prefer end_reason (real agent disposition) over raw queue status
                          const key = row.end_reason ?? row.status;
                          const s = CALL_STATUS[key] ?? { label: key, className: "border-gray-500/40 bg-gray-500/15 text-gray-400", Icon: PhoneCall };
                          return (
                            <React.Fragment key={row.id}>
                              <tr className="hover:bg-white/[0.025] transition-colors">
                                <td className="px-4 py-2.5 font-mono text-xs text-gray-300">{row.phone_number}</td>
                                <td className="px-4 py-2.5 text-xs text-gray-400">{row.customer_name ?? "—"}</td>
                                <td className="px-4 py-2.5">
                                  <Badge variant="outline" className={cn("text-[10px] px-2 py-0 gap-1", s.className)}>
                                    <s.Icon className="w-2.5 h-2.5" />
                                    {s.label}
                                  </Badge>
                                </td>
                                <td className="px-4 py-2.5 text-xs text-gray-500">{dur(row.duration_seconds)}</td>
                                <td className="px-4 py-2.5 text-xs text-gray-500">{fmt(row.started_at)}</td>
                                <td className="px-4 py-2.5">
                                  {row.transcript && (
                                    <button
                                      onClick={() => setExpanded(expanded === row.id ? null : row.id)}
                                      className="flex items-center gap-1 text-[11px] text-fuchsia-400 hover:text-fuchsia-300 transition-colors"
                                    >
                                      <FileText className="w-3 h-3" />
                                      {expanded === row.id ? "Ocultar" : "Transcript"}
                                    </button>
                                  )}
                                </td>
                              </tr>
                              {expanded === row.id && row.transcript && (
                                <tr>
                                  <td colSpan={6} className="px-4 py-3 bg-black/30">
                                    <pre className="text-xs text-gray-300 whitespace-pre-wrap font-mono leading-relaxed">
                                      {row.transcript
                                        .replace(/\[Camila\]/g, "🤖 Camila")
                                        .replace(/\[Cliente\]/g, "👤 Cliente")}
                                    </pre>
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                        {calls.length === 0 && (
                          <tr>
                            <td colSpan={6} className="px-4 py-10 text-center text-gray-600 text-sm">
                              Sin registros aún
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Call Log tab ── */}
        {tab === "calllog" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-semibold text-gray-100">Call Log</h2>
                <p className="text-xs text-gray-500 mt-0.5">Historial de todas tus llamadas</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={loadCallLog}
                disabled={callLogLoading}
                className="border-white/10 bg-white/5 text-gray-300 hover:text-white hover:bg-white/10 gap-1.5 text-xs"
              >
                {callLogLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Activity className="w-3 h-3" />}
                Actualizar
              </Button>
            </div>

            <div className="glass-card rounded-2xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-white/[0.03] text-[11px] text-gray-500 uppercase tracking-wide">
                    <tr>
                      <th className="px-4 py-2.5 text-left">Tipo</th>
                      <th className="px-4 py-2.5 text-left">Número</th>
                      <th className="px-4 py-2.5 text-left">Estado</th>
                      <th className="px-4 py-2.5 text-left">Duración</th>
                      <th className="px-4 py-2.5 text-left">Fecha</th>
                      <th className="px-4 py-2.5 text-left">Grabación</th>
                      <th className="px-4 py-2.5 text-left">Transcript</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {callLog.map((call) => {
                      const s = CALL_STATUS[call.status] ?? { label: call.status_label ?? call.status, className: "border-gray-500/40 bg-gray-500/15 text-gray-400", Icon: PhoneCall };
                      return (
                        <React.Fragment key={call.id}>
                          <tr className="hover:bg-white/[0.025] transition-colors">
                            <td className="px-4 py-3">
                              {call.direction === "inbound" ? (
                                <div className="flex items-center gap-1.5">
                                  <PhoneIncoming className="w-3.5 h-3.5 text-cyan-400" />
                                  <span className="text-xs text-cyan-400">Entrante</span>
                                </div>
                              ) : (
                                <div className="flex flex-col gap-0.5">
                                  <div className="flex items-center gap-1.5">
                                    <PhoneOutgoing className="w-3.5 h-3.5 text-fuchsia-400" />
                                    <span className="text-xs text-fuchsia-400">Saliente</span>
                                  </div>
                                  {call.source === "campaign" && (
                                    <span className="text-[10px] text-brand-purple/80 flex items-center gap-1">
                                      <Megaphone className="w-2.5 h-2.5" />Campaña
                                    </span>
                                  )}
                                </div>
                              )}
                            </td>
                            <td className="px-4 py-3 font-mono text-xs text-gray-300">
                              {call.direction === "inbound" ? (call.from_number ?? "—") : (call.to_number ?? "—")}
                            </td>
                            <td className="px-4 py-3">
                              <Badge variant="outline" className={cn("text-[10px] px-2 py-0 gap-1", s.className)}>
                                <s.Icon className="w-2.5 h-2.5" />
                                {s.label}
                              </Badge>
                            </td>
                            <td className="px-4 py-3 text-xs text-gray-500">{dur(call.duration_seconds)}</td>
                            <td className="px-4 py-3 text-xs text-gray-500">{fmt(call.started_at)}</td>
                            <td className="px-4 py-3">
                              <RecordingCell sessionId={call.id} hasRecording={!!call.recording_url} />
                            </td>
                            <td className="px-4 py-3">
                              {call.transcript ? (
                                <button
                                  onClick={() => setExpandedCall(expandedCall === call.id ? null : call.id)}
                                  className="flex items-center gap-1 text-[11px] text-fuchsia-400 hover:text-fuchsia-300 transition-colors"
                                >
                                  <FileText className="w-3 h-3" />
                                  {expandedCall === call.id ? "Ocultar" : "Ver"}
                                </button>
                              ) : (
                                <span className="text-xs text-gray-700">—</span>
                              )}
                            </td>
                          </tr>
                          {expandedCall === call.id && call.transcript && (
                            <tr>
                              <td colSpan={7} className="px-4 py-3 bg-black/30">
                                <pre className="text-xs text-gray-300 whitespace-pre-wrap font-mono leading-relaxed">
                                  {call.transcript
                                    .replace(/\[Camila\]/g, "🤖 Camila")
                                    .replace(/\[Cliente\]/g, "👤 Cliente")}
                                </pre>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                    {callLog.length === 0 && !callLogLoading && (
                      <tr>
                        <td colSpan={7} className="px-4 py-12 text-center text-gray-600 text-sm">
                          No hay llamadas registradas
                        </td>
                      </tr>
                    )}
                    {callLogLoading && callLog.length === 0 && (
                      <tr>
                        <td colSpan={7} className="px-4 py-12 text-center">
                          <Loader2 className="w-5 h-5 animate-spin text-gray-500 mx-auto" />
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            {callLog.length > 0 && (
              <p className="text-[11px] text-gray-600 text-right">{callLog.length} registros</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Sub-components ──────────────────────────────────────────────────────── */

function KpiCard({ label, value, sub, icon, gradient }: {
  label: string; value: string; sub: string;
  icon: React.ReactNode; gradient: string;
}) {
  return (
    <div className="glass-card rounded-2xl p-5 space-y-3 relative overflow-hidden group">
      {/* Glow */}
      <div className={cn("absolute -top-6 -right-6 w-20 h-20 rounded-full blur-2xl opacity-25 group-hover:opacity-40 transition-opacity bg-gradient-to-br", gradient)} />
      <div className={cn("w-9 h-9 rounded-xl bg-gradient-to-br flex items-center justify-center text-white shrink-0 shadow-lg", gradient)}>
        {icon}
      </div>
      <div>
        <p className="text-[11px] uppercase tracking-wider text-gray-500">{label}</p>
        <p className="text-2xl font-bold text-white mt-0.5 font-mono tracking-tight">{value}</p>
        <p className="text-[11px] text-gray-600 mt-0.5">{sub}</p>
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition-colors",
        active
          ? "border-brand-pink text-white"
          : "border-transparent text-gray-500 hover:text-gray-200 hover:border-white/20"
      )}
    >
      {children}
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
  const fmtT = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
  const toggle = () => { const a = audioRef.current; if (!a) return; playing ? a.pause() : a.play(); };

  const skip = (delta: number) => {
    const a = audioRef.current;
    if (!a || !duration) return;
    const next = Math.max(0, Math.min(duration, a.currentTime + delta));
    a.currentTime = next;
    setCurrent(next);
    setProgress(next / duration);
  };

  const seekToClientX = useCallback((clientX: number) => {
    const a = audioRef.current;
    const bar = barRef.current;
    if (!a || !bar || !duration) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    a.currentTime = ratio * duration;
    setCurrent(ratio * duration);
    setProgress(ratio);
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

  return (
    <div className="flex items-center gap-1.5 w-72 bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5">
      <audio ref={audioRef} src={src}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setProgress(0); setCurrent(0); }}
        onLoadedMetadata={() => setDuration(audioRef.current?.duration ?? 0)}
        onTimeUpdate={() => {
          if (dragging) return;
          const a = audioRef.current; if (!a || !a.duration) return;
          setCurrent(a.currentTime); setProgress(a.currentTime / a.duration);
        }} />
      <button onClick={() => skip(-10)} title="Retroceder 10s" className="shrink-0 w-5 h-5 flex items-center justify-center rounded-full text-gray-400 hover:text-white transition-colors">
        <Rewind className="w-3.5 h-3.5" />
      </button>
      <button onClick={toggle} className="shrink-0 w-6 h-6 flex items-center justify-center rounded-full bg-brand-pink hover:bg-brand-purple transition-colors text-white">
        {playing ? <Pause className="w-2.5 h-2.5" /> : <Play className="w-2.5 h-2.5 ml-0.5" />}
      </button>
      <button onClick={() => skip(10)} title="Adelantar 10s" className="shrink-0 w-5 h-5 flex items-center justify-center rounded-full text-gray-400 hover:text-white transition-colors">
        <FastForward className="w-3.5 h-3.5" />
      </button>
      <div className="flex-1 flex flex-col gap-1 min-w-0">
        <div ref={barRef} className="relative h-3 flex items-center cursor-pointer group touch-none" onPointerDown={onPointerDown}>
          <div className="absolute inset-x-0 h-1.5 rounded-full bg-white/10" />
          <div className="absolute left-0 h-1.5 rounded-full bg-gradient-to-r from-brand-pink to-brand-purple" style={{ width: `${progress * 100}%` }} />
          <div className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white shadow opacity-0 group-hover:opacity-100 transition-opacity" style={{ left: `calc(${progress * 100}% - 6px)` }} />
        </div>
        <div className="flex justify-between text-[9px] text-gray-600 leading-none">
          <span>{fmtT(current)}</span><span>{duration ? fmtT(duration) : "--:--"}</span>
        </div>
      </div>
    </div>
  );
}

function RecordingCell({ sessionId, hasRecording }: { sessionId: string; hasRecording: boolean }) {
  const [loading, setLoading] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [errored, setErrored] = useState(false);

  const API = getApiBaseUrl();

  // S4.5 — revoke blob URL on unmount + when audio changes.
  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  const load = async () => {
    if (audioUrl) return;
    setLoading(true); setErrored(false);
    try {
      const token = getToken();
      const res = await fetch(`${API}/portal/recordings/${sessionId}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: "include",
      });
      if (!res.ok) throw new Error("not found");
      setAudioUrl(URL.createObjectURL(await res.blob()));
    } catch { setErrored(true); }
    finally { setLoading(false); }
  };

  if (!hasRecording && !audioUrl) return <span className="text-xs text-gray-700">—</span>;
  if (errored) return <span className="text-xs text-rose-400">No disponible</span>;
  if (audioUrl) return <AudioPlayer src={audioUrl} />;
  return (
    <button onClick={load} disabled={loading} className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 disabled:opacity-50 transition-colors">
      {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
      {loading ? "…" : "Escuchar"}
    </button>
  );
}
