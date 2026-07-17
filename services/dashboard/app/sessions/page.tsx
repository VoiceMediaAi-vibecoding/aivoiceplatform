"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type Session } from "@/lib/api";
import AdminAuthGuard from "@/app/admin/AdminAuthGuard";
import AppShell from "@/components/AppShell";
import GlassCard from "@/components/ui/GlassCard";

export default function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .sessions()
      .then(setSessions)
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Failed to load sessions");
      });
  }, []);

  return (
    <AdminAuthGuard>
    <AppShell title="Sesiones" description="Historial de conversaciones del agente con desglose de costo">
      {error && (
        <div className="mb-6 p-4 rounded-xl text-sm bg-rose-500/10 border border-rose-400/20 text-rose-300">
          {error}
        </div>
      )}

      {sessions.length === 0 && !error && (
        <GlassCard className="p-8 text-center text-sm text-gray-500">
          No hay sesiones todavía. ¡Inicia una conversación con el agente!
        </GlassCard>
      )}

      <div className="flex flex-col gap-3">
        {sessions.map((s) => (
          <Link key={s.id} href={`/sessions/${s.id}`}>
            <GlassCard interactive className="p-5">
              <div className="flex justify-between items-start gap-4">
                <div className="min-w-0">
                  <p className="font-mono text-xs text-gray-500 truncate">{s.id}</p>
                  <p className="text-sm mt-1 text-gray-100">
                    {s.room_name ?? "—"} · <span className="text-gray-400">{s.identity ?? "unknown"}</span>
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    {s.ended_at ? new Date(s.ended_at).toLocaleString("es-MX") : "En curso"}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-lg font-semibold text-emerald-300 font-mono">
                    ${Number(s.total_cost_usd).toFixed(4)}
                  </p>
                  <div className="flex gap-1 mt-1.5 justify-end flex-wrap">
                    {Object.entries(s.cost_by_provider ?? {}).map(([p, c]) => (
                      <span key={p} className="text-[11px] bg-white/5 border border-white/10 rounded-full px-2 py-0.5 text-gray-400">
                        {p}: ${Number(c).toFixed(4)}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </GlassCard>
          </Link>
        ))}
      </div>
    </AppShell>
    </AdminAuthGuard>
  );
}
