"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { api, type DailyPoint, type CostSummary } from "@/lib/api";
import { adminFetch } from "@/lib/admin-auth";
import AdminAuthGuard from "@/app/admin/AdminAuthGuard";
import AppShell from "@/components/AppShell";
import GlassCard from "@/components/ui/GlassCard";
import StatTile from "@/components/ui/StatTile";
import RecentCallsTable, { type RecentCallRow } from "@/components/ui/RecentCallsTable";
import SystemHealthPanel, { type HealthRow } from "@/components/ui/SystemHealthPanel";

const PROVIDER_META: Record<string, { dot: string; accent: string }> = {
  openai: { dot: "bg-emerald-400", accent: "from-emerald-300 to-emerald-500" },
  deepgram: { dot: "bg-brand-blue", accent: "from-brand-blue to-brand-purple" },
  elevenlabs: { dot: "bg-amber-400", accent: "from-amber-300 to-amber-500" },
};

const SUCCESS_STATUSES = new Set(["completed", "answered", "in_progress"]);

interface Call {
  id: string;
  direction: "inbound" | "outbound";
  from_number: string | null;
  to_number: string | null;
  room_name: string | null;
  status: string;
  duration_seconds: number;
  cost_usd: number;
  started_at: string;
  ended_at: string | null;
}

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

export default function DashboardPage() {
  const [daily, setDaily] = useState<DailyPoint[]>([]);
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [calls, setCalls] = useState<Call[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [callsError, setCallsError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.dailyCosts(), api.costSummary()])
      .then(([d, s]) => {
        setDaily(d);
        setSummary(s);
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : "Failed to load data";
        setError(msg);
      });
  }, []);

  const loadCalls = useCallback(() => {
    adminFetch<Call[]>("/calls")
      .then((data) => setCalls(Array.isArray(data) ? data : []))
      .catch((e: unknown) => setCallsError(e instanceof Error ? e.message : "Failed to load calls"));
  }, []);

  useEffect(() => {
    loadCalls();
    const t = setInterval(loadCalls, 15000);
    return () => clearInterval(t);
  }, [loadCalls]);

  const providerEntries = summary ? Object.entries(summary.by_provider) : [];

  // ── KPI derivations from the live calls feed ──
  const kpis = useMemo(() => {
    const todayCalls = calls.filter((c) => isToday(c.started_at));
    const finished = calls.filter((c) => c.duration_seconds > 0);
    const avgDuration = finished.length
      ? Math.round(finished.reduce((sum, c) => sum + c.duration_seconds, 0) / finished.length)
      : 0;
    const successRate = calls.length
      ? Math.round((calls.filter((c) => SUCCESS_STATUSES.has(c.status)).length / calls.length) * 100)
      : 0;
    const activeNow = calls.filter((c) => c.status === "in_progress" || c.status === "ringing").length;
    return { todayCount: todayCalls.length, avgDuration, successRate, activeNow };
  }, [calls]);

  const recentRows: RecentCallRow[] = useMemo(
    () =>
      calls.slice(0, 8).map((c) => ({
        id: c.id,
        direction: c.direction,
        number: c.direction === "inbound" ? c.from_number : c.to_number,
        status: c.status,
        durationSeconds: c.duration_seconds,
        startedAt: c.started_at,
      })),
    [calls],
  );

  const healthRows: HealthRow[] = useMemo(() => {
    const rows: HealthRow[] = [
      {
        label: "API de costos",
        detail: summary ? "Respondiendo con normalidad" : error ? "Sin respuesta" : "Verificando…",
        tone: summary ? "active" : error ? "danger" : "neutral",
        status: summary ? "Operativo" : error ? "Caído" : "—",
      },
      {
        label: "Llamadas / Telefonía",
        detail: callsError ? "Error al sincronizar" : `${calls.length} registros sincronizados`,
        tone: callsError ? "danger" : calls.length > 0 ? "active" : "neutral",
        status: callsError ? "Error" : "Operativo",
      },
      {
        label: "Agentes en vivo",
        detail: kpis.activeNow > 0 ? `${kpis.activeNow} llamada(s) activa(s)` : "Sin actividad en este momento",
        tone: kpis.activeNow > 0 ? "active" : "neutral",
        status: kpis.activeNow > 0 ? "En llamada" : "En espera",
      },
    ];
    return rows;
  }, [summary, error, callsError, calls.length, kpis.activeNow]);

  return (
    <AdminAuthGuard>
    <AppShell title="Centro de costos" description="Telemetría de gasto y actividad de los agentes en tiempo real">
      {error && (
        <div className="mb-6 p-4 rounded-xl text-sm bg-rose-500/10 border border-rose-400/20 text-rose-300">
          {error} — verifica que el servicio de la API esté corriendo.
        </div>
      )}

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatTile
          label="Llamadas hoy"
          value={String(kpis.todayCount)}
          sub={`${calls.length} totales sincronizadas`}
          accent="from-brand-pink to-brand-purple"
        />
        <StatTile
          label="Duración promedio"
          value={kpis.avgDuration ? `${Math.floor(kpis.avgDuration / 60)}m ${kpis.avgDuration % 60}s` : "—"}
          sub="Llamadas con duración registrada"
          accent="from-brand-purple to-brand-blue"
        />
        <StatTile
          label="Tasa de éxito"
          value={calls.length ? `${kpis.successRate}%` : "—"}
          sub="Contestadas / completadas vs. total"
          accent="from-emerald-300 to-emerald-500"
        />
        <StatTile
          label="Costo total"
          value={summary ? `$${summary.total_usd.toFixed(4)}` : "—"}
          sub="Acumulado de LLM, STT y TTS"
          accent="from-amber-300 to-amber-500"
        />
      </div>

      {/* Provider breakdown */}
      {providerEntries.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          {providerEntries.map(([provider, cost]) => {
            const meta = PROVIDER_META[provider] ?? { dot: "bg-gray-400", accent: "from-gray-300 to-gray-500" };
            return (
              <StatTile
                key={provider}
                label={provider}
                value={`$${cost.toFixed(4)}`}
                accent={meta.accent}
                icon={<span className={`inline-block w-2.5 h-2.5 rounded-full ${meta.dot}`} />}
              />
            );
          })}
        </div>
      )}

      {/* Main content: chart + recent activity (left) / system health (right) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 flex flex-col gap-6">
          <GlassCard className="p-6">
            <h2 className="text-sm font-semibold text-gray-200 mb-1">Costo diario (USD)</h2>
            <p className="text-xs text-gray-500 mb-4">Suma de costos de LLM, STT y TTS por día</p>
            {daily.length === 0 ? (
              <p className="text-gray-500 text-sm">Sin datos todavía — ejecuta una sesión primero.</p>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={daily}>
                  <defs>
                    <linearGradient id="costGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" tick={{ fill: "#9ca3af", fontSize: 12 }} />
                  <YAxis
                    tick={{ fill: "#9ca3af", fontSize: 12 }}
                    tickFormatter={(v: number) => `$${v.toFixed(3)}`}
                  />
                  <Tooltip
                    contentStyle={{ background: "rgba(10,12,20,0.9)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12 }}
                    labelStyle={{ color: "#e7e9ee" }}
                    formatter={(v) => [`$${Number(v).toFixed(6)}`, "Costo"]}
                  />
                  <Area type="monotone" dataKey="cost_usd" stroke="#6366f1" fill="url(#costGrad)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </GlassCard>

          <RecentCallsTable
            title="Llamadas recientes"
            description="Últimas llamadas entrantes y salientes sincronizadas"
            rows={recentRows}
            emptyLabel={callsError ?? "Sin llamadas registradas todavía"}
          />
        </div>

        <div className="lg:col-span-1">
          <SystemHealthPanel rows={healthRows} />
        </div>
      </div>
    </AppShell>
    </AdminAuthGuard>
  );
}
