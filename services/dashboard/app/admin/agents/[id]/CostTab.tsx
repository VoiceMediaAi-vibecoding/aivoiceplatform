"use client";

import { useEffect, useState } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { api, type AgentCostStats, type DailyPoint } from "@/lib/api";
import GlassCard from "@/components/ui/GlassCard";
import StatTile from "@/components/ui/StatTile";

/**
 * "Costos" tab on the agent detail page. Renders:
 *   - Top-line KPIs: total spend, session count, avg $/min, total minutes
 *   - Provider breakdown (OpenAI / Deepgram / Inworld / etc.)
 *   - Daily spend area chart (last 30 days)
 *
 * Powered by /admin/agents/{id}/cost-stats (services/api/main.py) which
 * aggregates the `sessions` table for this agent. Read-only — pricing
 * adjustments live in the agent config, not here.
 */
export default function CostTab({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [stats, setStats] = useState<AgentCostStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .agentCostStats(agentId)
      .then((s) => { if (!cancelled) setStats(s); })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "No se pudo cargar el costo");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [agentId]);

  if (loading) {
    return <div className="text-sm text-gray-400">Cargando costos…</div>;
  }
  if (error) {
    return (
      <GlassCard className="p-5 border border-rose-400/20 bg-rose-500/5">
        <p className="text-sm text-rose-300">❌ {error}</p>
      </GlassCard>
    );
  }
  if (!stats) {
    return null;
  }

  const byProviderEntries = Object.entries(stats.by_provider).sort((a, b) => b[1] - a[1]);
  const totalForPct = stats.total_cost_usd || 1; // avoid /0

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-medium text-gray-300 mb-3">
          Costos de {agentName}
        </h3>
        <p className="text-xs text-gray-500">
          Datos de la tabla <code className="text-gray-400">sessions</code>. Acumulado histórico
          (no hay filtro de fecha todavía). Para filtrar por rango, agregar{" "}
          <code className="text-gray-400">?days=30</code> al endpoint cuando lo necesités.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile
          label="Total gastado"
          value={`$${stats.total_cost_usd.toFixed(4)}`}
          sub={`${stats.session_count} sessions`}
          accent="from-emerald-300 to-emerald-500"
        />
        <StatTile
          label="Costo por minuto"
          value={stats.avg_cost_per_min > 0 ? `$${stats.avg_cost_per_min.toFixed(4)}` : "—"}
          sub={stats.total_minutes > 0 ? `${stats.total_minutes.toFixed(1)} min totales` : "sin duración"}
        />
        <StatTile
          label="Sesiones"
          value={String(stats.session_count)}
        />
        <StatTile
          label="Minutos totales"
          value={stats.total_minutes > 0 ? stats.total_minutes.toFixed(1) : "0"}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <GlassCard className="p-5">
          <h4 className="text-sm font-medium text-gray-200 mb-3">Por proveedor</h4>
          {byProviderEntries.length === 0 ? (
            <p className="text-sm text-gray-500">Sin datos aún.</p>
          ) : (
            <div className="space-y-2">
              {byProviderEntries.map(([provider, cost]) => {
                const pct = (cost / totalForPct) * 100;
                return (
                  <div key={provider} className="text-sm">
                    <div className="flex justify-between mb-1">
                      <span className="text-gray-300 capitalize">{provider}</span>
                      <span className="text-gray-400 font-mono">
                        ${cost.toFixed(4)} <span className="text-gray-600">({pct.toFixed(0)}%)</span>
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-emerald-400 to-emerald-600"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </GlassCard>

        <GlassCard className="p-5">
          <h4 className="text-sm font-medium text-gray-200 mb-3">Tendencia diaria</h4>
          {stats.daily.length === 0 ? (
            <p className="text-sm text-gray-500">Sin datos aún.</p>
          ) : (
            <div style={{ width: "100%", height: 180 }}>
              <ResponsiveContainer>
                <AreaChart data={stats.daily}>
                  <defs>
                    <linearGradient id="costGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#6366f1" stopOpacity={0.6} />
                      <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="date"
                    tickFormatter={(d: string) => d.slice(5)}
                    tick={{ fill: "#9ca3af", fontSize: 10 }}
                    axisLine={{ stroke: "#374151" }}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: "#9ca3af", fontSize: 10 }}
                    axisLine={{ stroke: "#374151" }}
                    tickLine={false}
                    tickFormatter={(v: number) => `$${v.toFixed(3)}`}
                  />
                  <Tooltip
                    contentStyle={{ background: "#0f172a", border: "1px solid #374151", borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: "#cbd5e1" }}
                    formatter={(v: number) => `$${v.toFixed(4)}`}
                  />
                  <Area
                    type="monotone"
                    dataKey="cost_usd"
                    stroke="#6366f1"
                    strokeWidth={2}
                    fill="url(#costGrad)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </GlassCard>
      </div>

      <GlassCard className="p-4">
        <p className="text-xs text-gray-500">
          <strong className="text-gray-300">Tip de pricing:</strong> con{" "}
          <code className="text-gray-400">avg_cost_per_min = ${stats.avg_cost_per_min.toFixed(4)}</code>,
          un precio de venta de{" "}
          <code className="text-gray-400">${(stats.avg_cost_per_min * 3).toFixed(4)}/min</code> te deja ~67% de margen.
          Sumá Twilio según el país de origen de tus calls (~$0.0085/min US, ~$0.03/min MX, ~$0.05/min PA).
        </p>
      </GlassCard>
    </div>
  );
}
