"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import {
  Phone, PhoneIncoming, PhoneOutgoing, Loader2, Mic, FileText, AlertCircle,
  Rewind, FastForward, Search, Filter, X, RefreshCw, Play, Pause,
} from "lucide-react";
import { adminFetch, getAPI, getToken } from "@/lib/admin-auth";
import AdminAuthGuard from "@/app/admin/AdminAuthGuard";
import AppShell from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

interface AgentOption {
  id: string;
  name: string;
  is_active: boolean;
}

interface ClientOption {
  id: string;
  name: string;
}

interface CampaignOption {
  id: string;
  name: string;
}

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

interface CallsResponse {
  calls: Call[];
  total: number;
  limit: number;
  offset: number;
  filters_applied: number;
  truncated: boolean;
}

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  in_progress:  { label: "En curso",     className: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300" },
  completed:    { label: "Completada",   className: "border-blue-500/40 bg-blue-500/15 text-blue-300" },
  client_hangup:{ label: "Colgó cliente",className: "border-slate-500/40 bg-slate-500/15 text-slate-300" },
  voicemail:    { label: "Buzón",        className: "border-purple-500/40 bg-purple-500/15 text-purple-300" },
  no_answer:    { label: "Sin respuesta",className: "border-yellow-500/40 bg-yellow-500/15 text-yellow-300" },
  failed:       { label: "Fallida",      className: "border-red-500/40 bg-red-500/15 text-red-300" },
  initiated:    { label: "Iniciando",    className: "border-gray-500/40 bg-gray-500/15 text-gray-300" },
  ringing:      { label: "Llamando",     className: "border-cyan-500/40 bg-cyan-500/15 text-cyan-300" },
};

const STATUS_OPTIONS = [
  { value: "in_progress",   label: "En curso" },
  { value: "completed",     label: "Completada" },
  { value: "client_hangup", label: "Colgó cliente" },
  { value: "voicemail",     label: "Buzón" },
  { value: "no_answer",     label: "Sin respuesta" },
  { value: "failed",        label: "Fallida" },
];

const fmt = (s: string) => new Date(s).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" });
const dur = (sec: number) => sec > 0 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : "—";

const PAGE_SIZE = 50;

export default function CallsPage() {
  const [calls, setCalls] = useState<Call[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [expandedCall, setExpandedCall] = useState<string | null>(null);
  const [toNumber, setToNumber] = useState("");
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);
  const [agentId, setAgentId] = useState<string>("");
  const [calling, setCalling] = useState(false);
  const [callResult, setCallResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [truncated, setTruncated] = useState(false);

  // ── Filter state (Phase 3.1) ─────────────────────────────────────────────
  // Each filter maps 1:1 to a query param on the backend. Empty string means
  // "no filter" so the dropdowns can default to "all" cleanly.
  const [fAgent, setFAgent] = useState("");
  const [fClient, setFClient] = useState("");
  const [fCampaign, setFCampaign] = useState("");
  const [fDirection, setFDirection] = useState("");
  const [fStatus, setFStatus] = useState("");
  const [fDateFrom, setFDateFrom] = useState("");
  const [fDateTo, setFDateTo] = useState("");
  const [fSearch, setFSearch] = useState("");

  const activeFilterCount = useMemo(
    () => [fAgent, fClient, fCampaign, fDirection, fStatus, fDateFrom, fDateTo, fSearch].filter(Boolean).length,
    [fAgent, fClient, fCampaign, fDirection, fStatus, fDateFrom, fDateTo, fSearch],
  );

  // Build the query string from filter state. Stable memo so the auto-refresh
  // effect doesn't re-fire on every render.
  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    p.set("limit", String(PAGE_SIZE));
    p.set("offset", String(offset));
    if (fAgent) p.set("agent_id", fAgent);
    if (fClient) p.set("client_id", fClient);
    if (fCampaign) p.set("campaign_id", fCampaign);
    if (fDirection) p.set("direction", fDirection);
    if (fStatus) p.set("status", fStatus);
    if (fDateFrom) p.set("date_from", new Date(fDateFrom).toISOString());
    if (fDateTo) p.set("date_to", new Date(fDateTo).toISOString());
    if (fSearch.trim()) p.set("phone_search", fSearch.trim());
    return p.toString();
  }, [offset, fAgent, fClient, fCampaign, fDirection, fStatus, fDateFrom, fDateTo, fSearch]);

  const loadCalls = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminFetch<CallsResponse>(`/calls?${queryString}`);
      setCalls(Array.isArray(data?.calls) ? data.calls : []);
      setTotal(data?.total ?? 0);
      setTruncated(!!data?.truncated);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load calls");
    } finally {
      setLoading(false);
    }
  }, [queryString]);

  // Reset to page 0 whenever a filter changes — otherwise the user can land on
  // an empty page (e.g. offset=200 with a filter that only has 3 results).
  useEffect(() => {
    setOffset(0);
  }, [fAgent, fClient, fCampaign, fDirection, fStatus, fDateFrom, fDateTo, fSearch]);

  useEffect(() => {
    loadCalls();
    if (!autoRefresh) return;
    const t = setInterval(loadCalls, 5000);
    return () => clearInterval(t);
  }, [loadCalls, autoRefresh]);

  // Load filter-source lists once on mount.
  useEffect(() => {
    adminFetch<AgentOption[]>("/admin/agents")
      .then((data) => {
        const list = Array.isArray(data) ? data : [];
        setAgents(list);
        const stored = typeof window !== "undefined" ? window.localStorage.getItem("calls:lastAgentId") : null;
        if (stored && list.some((a) => a.id === stored)) setAgentId(stored);
        else if (list.length > 0) setAgentId(list[0].id);
      })
      .catch(() => setAgents([]));
    adminFetch<ClientOption[]>("/admin/clients")
      .then((data) => setClients(Array.isArray(data) ? data : []))
      .catch(() => setClients([]));
    adminFetch<CampaignOption[]>("/campaigns")
      .then((data) => setCampaigns(Array.isArray(data) ? data : []))
      .catch(() => setCampaigns([]));
  }, []);

  const handleAgentChange = (id: string) => {
    setAgentId(id);
    if (typeof window !== "undefined") window.localStorage.setItem("calls:lastAgentId", id);
  };

  const clearFilters = () => {
    setFAgent(""); setFClient(""); setFCampaign("");
    setFDirection(""); setFStatus(""); setFDateFrom(""); setFDateTo("");
    setFSearch("");
  };

  const makeCall = async () => {
    if (!toNumber.trim()) return;
    setCalling(true);
    setCallResult(null);
    setError(null);
    try {
      const data = await adminFetch<{ call_id?: string }>("/calls/outbound", {
        method: "POST",
        body: JSON.stringify({ to_number: toNumber, agent_id: agentId || null }),
      });
      setCallResult(`Llamada iniciada — ID: ${data.call_id}`);
      setToNumber("");
      setTimeout(loadCalls, 1500);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error making call");
    } finally {
      setCalling(false);
    }
  };

  const hasNextPage = offset + PAGE_SIZE < total;
  const hasPrevPage = offset > 0;

  return (
    <AdminAuthGuard>
      <AppShell title="Llamadas" description="Origina llamadas salientes y supervisa el historial en vivo">

        {/* Outbound call panel */}
        <Card className="mb-6 bg-white/[0.03] border-white/10 text-white">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-brand-pink/20 flex items-center justify-center">
                <Phone className="w-4 h-4 text-brand-pink" />
              </div>
              <div>
                <CardTitle className="text-sm text-gray-200">Llamada saliente</CardTitle>
                <CardDescription className="text-xs text-gray-500">Marca un número directamente desde el panel</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1 space-y-1">
                <Label className="text-xs text-gray-400">Número destino</Label>
                <Input
                  type="tel"
                  value={toNumber}
                  onChange={(e) => setToNumber(e.target.value)}
                  placeholder="+15105551234"
                  className="bg-white/5 border-white/10 text-white placeholder:text-gray-600 focus-visible:border-brand-pink/60 focus-visible:ring-0"
                  onKeyDown={(e) => e.key === "Enter" && makeCall()}
                />
              </div>
              <div className="sm:w-56 space-y-1">
                <Label className="text-xs text-gray-400">Agente</Label>
                <Select value={agentId} onValueChange={handleAgentChange}>
                  <SelectTrigger className="bg-white/5 border-white/10 text-white focus:ring-0 focus:border-brand-pink/60">
                    <SelectValue placeholder="Selecciona agente" />
                  </SelectTrigger>
                  <SelectContent className="bg-[#1a1a1a] border-white/10 text-gray-200">
                    {agents.length === 0 && <SelectItem value="_">Sin agentes</SelectItem>}
                    {agents.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}{a.is_active ? "" : " (inactivo)"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="sm:self-end">
                <Button
                  onClick={makeCall}
                  disabled={calling || !toNumber.trim()}
                  className="w-full sm:w-auto bg-brand-pink hover:bg-brand-purple text-white gap-2"
                >
                  {calling ? <Loader2 className="w-4 h-4 animate-spin" /> : <Phone className="w-4 h-4" />}
                  {calling ? "Llamando…" : "Llamar"}
                </Button>
              </div>
            </div>

            {callResult && (
              <Alert className="border-emerald-400/30 bg-emerald-500/10">
                <AlertDescription className="text-emerald-300 text-sm">✓ {callResult}</AlertDescription>
              </Alert>
            )}
            {error && (
              <Alert variant="destructive" className="border-rose-400/30 bg-rose-500/10">
                <AlertCircle className="w-4 h-4" />
                <AlertDescription className="text-rose-300">{error}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        {/* Call history */}
        <div className="space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-gray-200">Historial de llamadas</h2>
              <Badge variant="outline" className="border-white/10 text-gray-400 text-xs">
                {total} {truncated && "(truncado)"}
              </Badge>
              {activeFilterCount > 0 && (
                <Badge variant="outline" className="border-brand-pink/40 text-brand-pink text-xs">
                  {activeFilterCount} filtros activos
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={loadCalls}
                disabled={loading}
                title="Refrescar"
                className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 disabled:opacity-40"
              >
                <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
              </button>
              <label className="flex items-center gap-1.5 text-[11px] text-gray-400 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={(e) => setAutoRefresh(e.target.checked)}
                  className="w-3.5 h-3.5 rounded accent-brand-pink"
                />
                Auto-refresh 5s
              </label>
            </div>
          </div>

          {/* ── FilterBar (Phase 3.1) ─────────────────────────────────── */}
          <Card className="bg-white/[0.02] border-white/10 text-white">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-2 text-gray-300">
                <Filter className="w-4 h-4 text-brand-pink" />
                <span className="text-xs font-semibold uppercase tracking-wider">Filtros</span>
              </div>

              {/* Row 1: agent / client / campaign / direction / status */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <div className="space-y-1">
                  <Label className="text-[11px] text-gray-400">Agente</Label>
                  <Select value={fAgent} onValueChange={(v) => setFAgent(v === "_all" ? "" : v)}>
                    <SelectTrigger className="bg-white/5 border-white/10 text-white focus:ring-0 focus:border-brand-pink/60 h-9 text-xs">
                      <SelectValue placeholder="Todos" />
                    </SelectTrigger>
                    <SelectContent className="bg-[#1a1a1a] border-white/10 text-gray-200">
                      <SelectItem value="_all">Todos los agentes</SelectItem>
                      {agents.map((a) => (
                        <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Label className="text-[11px] text-gray-400">Cliente</Label>
                  <Select value={fClient} onValueChange={(v) => setFClient(v === "_all" ? "" : v)}>
                    <SelectTrigger className="bg-white/5 border-white/10 text-white focus:ring-0 focus:border-brand-pink/60 h-9 text-xs">
                      <SelectValue placeholder="Todos" />
                    </SelectTrigger>
                    <SelectContent className="bg-[#1a1a1a] border-white/10 text-gray-200">
                      <SelectItem value="_all">Todos los clientes</SelectItem>
                      {clients.map((c) => (
                        <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Label className="text-[11px] text-gray-400">Campaña</Label>
                  <Select value={fCampaign} onValueChange={(v) => setFCampaign(v === "_all" ? "" : v)}>
                    <SelectTrigger className="bg-white/5 border-white/10 text-white focus:ring-0 focus:border-brand-pink/60 h-9 text-xs">
                      <SelectValue placeholder="Todas" />
                    </SelectTrigger>
                    <SelectContent className="bg-[#1a1a1a] border-white/10 text-gray-200">
                      <SelectItem value="_all">Todas las campañas</SelectItem>
                      {campaigns.map((c) => (
                        <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Label className="text-[11px] text-gray-400">Tipo</Label>
                  <Select value={fDirection} onValueChange={(v) => setFDirection(v === "_all" ? "" : v)}>
                    <SelectTrigger className="bg-white/5 border-white/10 text-white focus:ring-0 focus:border-brand-pink/60 h-9 text-xs">
                      <SelectValue placeholder="Todos" />
                    </SelectTrigger>
                    <SelectContent className="bg-[#1a1a1a] border-white/10 text-gray-200">
                      <SelectItem value="_all">Todos</SelectItem>
                      <SelectItem value="inbound">Entrantes</SelectItem>
                      <SelectItem value="outbound">Salientes</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Label className="text-[11px] text-gray-400">Estado</Label>
                  <Select value={fStatus} onValueChange={(v) => setFStatus(v === "_all" ? "" : v)}>
                    <SelectTrigger className="bg-white/5 border-white/10 text-white focus:ring-0 focus:border-brand-pink/60 h-9 text-xs">
                      <SelectValue placeholder="Todos" />
                    </SelectTrigger>
                    <SelectContent className="bg-[#1a1a1a] border-white/10 text-gray-200">
                      <SelectItem value="_all">Todos</SelectItem>
                      {STATUS_OPTIONS.map((s) => (
                        <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Row 2: dates + free-text search */}
              <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_2fr_auto] gap-3">
                <div className="space-y-1">
                  <Label className="text-[11px] text-gray-400">Desde</Label>
                  <Input
                    type="date"
                    value={fDateFrom}
                    onChange={(e) => setFDateFrom(e.target.value)}
                    className="bg-white/5 border-white/10 text-white focus-visible:ring-0 focus-visible:border-brand-pink/60 h-9 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px] text-gray-400">Hasta</Label>
                  <Input
                    type="date"
                    value={fDateTo}
                    onChange={(e) => setFDateTo(e.target.value)}
                    className="bg-white/5 border-white/10 text-white focus-visible:ring-0 focus-visible:border-brand-pink/60 h-9 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px] text-gray-400">
                    Buscar número de cliente o Call ID
                  </Label>
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
                    <Input
                      value={fSearch}
                      onChange={(e) => setFSearch(e.target.value)}
                      placeholder="+5072023503  o  5835b77b-..."
                      className="bg-white/5 border-white/10 text-white placeholder:text-gray-600 focus-visible:ring-0 focus-visible:border-brand-pink/60 h-9 text-xs pl-8 font-mono"
                    />
                  </div>
                </div>
                <div className="flex items-end">
                  <Button
                    onClick={clearFilters}
                    disabled={activeFilterCount === 0}
                    variant="ghost"
                    className="h-9 px-3 text-xs text-gray-400 hover:text-white gap-1.5"
                  >
                    <X className="w-3.5 h-3.5" />
                    Limpiar
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Results */}
          {loading && calls.length === 0 ? (
            <Card className="bg-white/[0.02] border-white/10">
              <CardContent className="p-10 text-center text-sm text-gray-500">
                <Loader2 className="w-5 h-5 animate-spin inline mr-2" />
                Cargando…
              </CardContent>
            </Card>
          ) : calls.length === 0 ? (
            <Card className="bg-white/[0.02] border-white/10">
              <CardContent className="p-10 text-center text-sm text-gray-500">
                {activeFilterCount > 0
                  ? "No hay llamadas que coincidan con los filtros."
                  : "No hay llamadas aún."}
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {calls.map((c) => {
                const statusCfg = STATUS_CONFIG[c.status] ?? { label: c.status_label ?? c.status, className: "border-gray-500/40 bg-gray-500/15 text-gray-300" };
                return (
                  <Card key={c.id} className="bg-white/[0.03] border-white/10 text-white hover:border-white/20 transition-colors">
                    <CardContent className="p-4">
                      <div className="flex justify-between items-start gap-4">
                        <div className="flex items-start gap-3 min-w-0">
                          <div className={cn(
                            "mt-0.5 w-8 h-8 rounded-lg flex items-center justify-center shrink-0",
                            c.direction === "inbound" ? "bg-cyan-500/15" : "bg-brand-pink/15"
                          )}>
                            {c.direction === "inbound"
                              ? <PhoneIncoming className="w-4 h-4 text-cyan-400" />
                              : <PhoneOutgoing className="w-4 h-4 text-brand-pink" />}
                          </div>

                          <div className="min-w-0">
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                              <span className="text-sm font-medium text-gray-100 capitalize">{c.direction === "inbound" ? "Entrante" : "Saliente"}</span>
                              <Badge variant="outline" className={cn("text-xs px-2 py-0", statusCfg.className)}>
                                {statusCfg.label}
                              </Badge>
                            </div>
                            <p className="text-sm text-gray-400 font-mono">
                              {c.direction === "inbound" ? c.from_number ?? "—" : c.to_number ?? "—"}
                            </p>
                            <p className="text-xs text-gray-600 mt-0.5">
                              {fmt(c.started_at)} · {dur(c.duration_seconds)}
                            </p>
                          </div>
                        </div>

                        <div className="text-right shrink-0">
                          <p className="text-base font-semibold text-emerald-300 font-mono">${Number(c.cost_usd).toFixed(4)}</p>
                          <p className="text-[10px] text-gray-600 font-mono">{c.id.slice(0, 8)}…</p>
                        </div>
                      </div>

                      <div className="flex items-center gap-4 mt-3 pt-3 border-t border-white/5">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-500">Grabación:</span>
                          <RecordingCell sessionId={c.id} hasRecording={!!c.recording_url} canFetch={!!c.twilio_call_sid} />
                        </div>
                        {c.transcript ? (
                          <button
                            onClick={() => setExpandedCall(expandedCall === c.id ? null : c.id)}
                            className="flex items-center gap-1.5 text-xs text-fuchsia-300 hover:text-fuchsia-200 transition-colors"
                          >
                            <FileText className="w-3 h-3" />
                            {expandedCall === c.id ? "Ocultar transcript" : "Ver transcript"}
                          </button>
                        ) : (
                          <span className="text-xs text-gray-600 flex items-center gap-1">
                            <Mic className="w-3 h-3" />
                            Sin transcript
                          </span>
                        )}
                      </div>

                      {expandedCall === c.id && c.transcript && (
                        <pre className="text-xs text-gray-300 whitespace-pre-wrap font-mono leading-relaxed mt-3 p-3 rounded-lg bg-black/30 border border-white/5">
                          {c.transcript
                            .replace(/\[Camila\]/g, "🤖 Camila")
                            .replace(/\[Cliente\]/g, "👤 Cliente")}
                        </pre>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}

          {/* Pagination */}
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between pt-2">
              <p className="text-xs text-gray-500">
                Mostrando {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} de {total}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  disabled={!hasPrevPage || loading}
                  className="text-xs text-gray-400 hover:text-white"
                >
                  ← Anterior
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                  disabled={!hasNextPage || loading}
                  className="text-xs text-gray-400 hover:text-white"
                >
                  Siguiente →
                </Button>
              </div>
            </div>
          )}
        </div>
      </AppShell>
    </AdminAuthGuard>
  );
}

/* ── Audio player ─────────────────────────────────────────────────────────── */

function AudioPlayer({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [dragging, setDragging] = useState(false);

  const fmtTime = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
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
      <audio
        ref={audioRef}
        src={src}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setProgress(0); setCurrent(0); }}
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
        className="shrink-0 w-5 h-5 flex items-center justify-center rounded-full text-gray-400 hover:text-white transition-colors"
      >
        <Rewind className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={toggle}
        className="shrink-0 w-6 h-6 flex items-center justify-center rounded-full bg-brand-pink hover:bg-brand-purple transition-colors text-white"
      >
        {playing ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3 ml-0.5" />}
      </button>
      <button
        onClick={() => skip(10)}
        title="Adelantar 10s"
        className="shrink-0 w-5 h-5 flex items-center justify-center rounded-full text-gray-400 hover:text-white transition-colors"
      >
        <FastForward className="w-3.5 h-3.5" />
      </button>
      <div className="flex-1 flex flex-col gap-1 min-w-0">
        <div
          ref={barRef}
          className="relative h-3 flex items-center cursor-pointer group touch-none"
          onPointerDown={onPointerDown}
        >
          <div className="absolute inset-x-0 h-1.5 rounded-full bg-white/15" />
          <div className="absolute left-0 h-1.5 rounded-full bg-gradient-to-r from-brand-pink to-brand-purple" style={{ width: `${progress * 100}%` }} />
          <div className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white shadow opacity-0 group-hover:opacity-100 transition-opacity" style={{ left: `calc(${progress * 100}% - 6px)` }} />
        </div>
        <div className="flex justify-between text-[10px] text-gray-500 leading-none">
          <span>{fmtTime(current)}</span>
          <span>{duration ? fmtTime(duration) : "--:--"}</span>
        </div>
      </div>
    </div>
  );
}

function RecordingCell({ sessionId, hasRecording, canFetch }: { sessionId: string; hasRecording: boolean; canFetch?: boolean }) {
  const [loading, setLoading] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  // S4.5 — revoke blob URLs on unmount + when audio changes. Without this,
  // navigating through the call log accumulates ~MB per call in the
  // browser's blob store, eventually exhausting tab memory.
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

  if (!hasRecording && !canFetch && !audioUrl) return <span className="text-xs text-gray-600">—</span>;
  if (error) return <span className="text-xs text-rose-400">No disponible</span>;
  if (audioUrl) return <AudioPlayer src={audioUrl} />;
  return (
    <button onClick={load} disabled={loading} className="flex items-center gap-1 text-xs text-emerald-300 hover:text-emerald-200 disabled:opacity-50 transition-colors">
      {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
      {loading ? "Cargando…" : "Escuchar"}
    </button>
  );
}