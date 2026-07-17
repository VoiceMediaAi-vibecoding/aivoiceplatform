"use client";

import { useEffect, useState, useCallback } from "react";
import { adminFetch } from "@/lib/admin-auth";
import { type TabProps, type AgentVersion } from "./types";

const fmt = (s: string) =>
  new Date(s).toLocaleString("es-MX", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * "Versions" tab — VAPI-style publish history. Every saved change snapshots the
 * prior config here; admins can inspect what changed and roll back in one click
 * (rolling back itself snapshots first, so it's always reversible).
 */
export default function VersionsTab({ agentId, onRefresh, notify }: TabProps) {
  const [versions, setVersions] = useState<AgentVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  const fetchVersions = useCallback(async () => {
    try {
      setVersions(await adminFetch<AgentVersion[]>(`/admin/agents/${agentId}/versions`));
    } catch {
      // adminFetch redirects on 401
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    fetchVersions();
  }, [fetchVersions]);

  const restore = async (version: AgentVersion) => {
    if (!confirm(`¿Restaurar la configuración a la versión ${version.version_number}? Se guardará la configuración actual antes de aplicar el cambio.`)) return;
    setRestoring(version.id);
    try {
      await adminFetch(`/admin/agents/${agentId}/versions/${version.id}/restore`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      notify("ok", `✅ Restaurado a la versión ${version.version_number}`);
      await fetchVersions();
      onRefresh();
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error al restaurar"}`);
    } finally {
      setRestoring(null);
    }
  };

  if (loading) {
    return <p className="text-sm text-gray-500">Cargando historial…</p>;
  }

  if (versions.length === 0) {
    return <p className="text-xs text-gray-600 italic">Sin historial todavía — se creará una versión cada vez que guardes cambios.</p>;
  }

  return (
    <div className="space-y-2 max-w-3xl">
      <p className="text-xs text-gray-500 mb-1">
        Cada cambio guardado queda registrado aquí. Puedes inspeccionar el contenido o restaurar una versión anterior.
      </p>
      {versions.map((v, idx) => {
        const isExpanded = expanded === v.id;
        const isLatest = idx === 0;
        return (
          <div key={v.id} className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
            <button
              onClick={() => setExpanded(isExpanded ? null : v.id)}
              className="w-full flex items-center justify-between gap-3 p-3.5 text-left hover:bg-white/[0.03] transition-colors"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-100">Versión {v.version_number}</span>
                  {isLatest && (
                    <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-400/10 text-emerald-300 border border-emerald-400/20">
                      más reciente
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-0.5 truncate">
                  {fmt(v.created_at)} · {v.admin_users?.name ?? v.admin_users?.email ?? "—"}
                  {v.note ? ` · ${v.note}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {!isLatest && (
                  <button
                    onClick={(e) => { e.stopPropagation(); restore(v); }}
                    disabled={restoring === v.id}
                    className="text-xs px-3 py-1.5 bg-brand-pink hover:bg-brand-purple disabled:opacity-40 rounded-lg font-medium transition-colors"
                  >
                    {restoring === v.id ? "Restaurando…" : "Restaurar"}
                  </button>
                )}
                <span className="text-gray-500 text-xs">{isExpanded ? "▲" : "▼"}</span>
              </div>
            </button>
            {isExpanded && (
              <div className="px-3.5 pb-3.5 pt-1 border-t border-white/5 space-y-3">
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <Detail label="Modelo LLM" value={v.llm_model} />
                  <Detail label="Voz" value={v.voice_id} mono />
                  <Detail label="STT" value={v.stt_model} />
                  <Detail label="TTS" value={v.tts_model} />
                  <Detail label="Idioma" value={v.language} />
                  <Detail label="Temperatura" value={v.temperature?.toString() ?? null} />
                </div>
                {v.greeting && (
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Saludo</p>
                    <p className="text-xs text-gray-300 whitespace-pre-wrap bg-black/20 rounded-lg p-2.5">{v.greeting}</p>
                  </div>
                )}
                {v.system_prompt && (
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Prompt del sistema</p>
                    <p className="text-xs text-gray-400 whitespace-pre-wrap font-mono leading-relaxed bg-black/20 rounded-lg p-2.5 max-h-64 overflow-y-auto">
                      {v.system_prompt}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Detail({ label, value, mono = false }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-gray-500">{label}</p>
      <p className={`text-gray-300 ${mono ? "font-mono text-[11px]" : ""}`}>{value || "—"}</p>
    </div>
  );
}
