"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { adminFetch } from "@/lib/admin-auth";
import { type Session, type UsageRecord } from "@/lib/api";
import AdminAuthGuard from "@/app/admin/AdminAuthGuard";
import AppShell from "@/components/AppShell";
import GlassCard from "@/components/ui/GlassCard";

const fmt = (s: string | null) => (s ? new Date(s).toLocaleString("es-MX") : "—");

function SessionDetailContent() {
  const params = useParams<{ id: string }>();
  const sessionId = params.id;

  const [session, setSession] = useState<Session | null>(null);
  const [usage, setUsage] = useState<UsageRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await adminFetch<{ session: Session; usage: UsageRecord[] }>(`/sessions/${sessionId}`);
      setSession(data.session);
      setUsage(data.usage ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "No se pudo cargar la sesión");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <AppShell title="Sesión" description="Cargando…">
        <div className="text-sm text-gray-500">Cargando sesión…</div>
      </AppShell>
    );
  }

  if (error || !session) {
    return (
      <AppShell title="Sesión" description="No se encontró la sesión">
        {error && (
          <div className="mb-6 p-4 rounded-xl text-sm bg-rose-500/10 border border-rose-400/20 text-rose-300">
            {error}
          </div>
        )}
        <Link href="/sessions" className="text-sm text-fuchsia-300 hover:text-fuchsia-200">
          ← Volver a sesiones
        </Link>
      </AppShell>
    );
  }

  return (
    <AppShell
      title={session.room_name ?? "Sesión"}
      description={session.identity ?? "Detalle de sesión y desglose de costo por proveedor"}
    >
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <Link href="/sessions" className="text-sm text-gray-400 hover:text-gray-200 transition-colors">
          ← Sesiones
        </Link>
        <span className="text-gray-700">/</span>
        <code className="text-[11px] text-gray-500 bg-black/30 px-2 py-1 rounded font-mono">{session.id}</code>
      </div>

      <GlassCard className="p-6 mb-6">
        <div className="flex justify-between items-start gap-4 flex-wrap">
          <div className="min-w-0">
            <p className="text-sm text-gray-100">
              {session.room_name ?? "—"} · <span className="text-gray-400">{session.identity ?? "unknown"}</span>
            </p>
            <p className="text-xs text-gray-500 mt-1">
              Inicio: {fmt(session.started_at)}
            </p>
            <p className="text-xs text-gray-500">
              Fin: {session.ended_at ? fmt(session.ended_at) : "En curso"}
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-lg font-semibold text-emerald-300 font-mono">
              ${Number(session.total_cost_usd).toFixed(4)}
            </p>
            <div className="flex gap-1 mt-1.5 justify-end flex-wrap">
              {Object.entries(session.cost_by_provider ?? {}).map(([p, c]) => (
                <span key={p} className="text-[11px] bg-white/5 border border-white/10 rounded-full px-2 py-0.5 text-gray-400">
                  {p}: ${Number(c).toFixed(4)}
                </span>
              ))}
            </div>
          </div>
        </div>
      </GlassCard>

      <h2 className="text-sm font-semibold text-gray-200 mb-3">Registros de uso</h2>
      {usage.length === 0 ? (
        <GlassCard className="p-8 text-center text-sm text-gray-500">
          No hay registros de uso para esta sesión.
        </GlassCard>
      ) : (
        <div className="flex flex-col gap-2">
          {usage.map((u) => (
            <GlassCard key={u.id} className="p-4">
              <div className="flex justify-between items-center gap-4">
                <div className="min-w-0">
                  <p className="text-sm text-gray-100">
                    {u.provider} · <span className="text-gray-400">{u.model}</span>
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {u.metric_type}: {u.metric_value} · {fmt(u.timestamp)}
                  </p>
                </div>
                <p className="text-sm font-semibold text-emerald-300 font-mono shrink-0">
                  ${Number(u.cost_usd).toFixed(4)}
                </p>
              </div>
            </GlassCard>
          ))}
        </div>
      )}
    </AppShell>
  );
}

export default function SessionDetailPage() {
  return (
    <AdminAuthGuard>
      <SessionDetailContent />
    </AdminAuthGuard>
  );
}
