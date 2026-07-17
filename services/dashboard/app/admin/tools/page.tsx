"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Trash2, Wrench, Pencil, FlaskConical, AlertTriangle } from "lucide-react";
import { adminFetch } from "@/lib/admin-auth";
import AdminAuthGuard from "@/app/admin/AdminAuthGuard";
import AppShell from "@/components/AppShell";
import GlassCard from "@/components/ui/GlassCard";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import ToolForm, { type GlobalTool } from "./ToolForm";
import ToolTester from "./ToolTester";
import { schemaToParams } from "./ParameterEditor";

export default function ToolsCatalogPage() {
  return (
    <AdminAuthGuard>
      <ToolsCatalogContent />
    </AdminAuthGuard>
  );
}

function ToolsCatalogContent() {
  const [tools, setTools] = useState<GlobalTool[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testingTool, setTestingTool] = useState<GlobalTool | null>(null);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminFetch<GlobalTool[]>("/admin/tools");
      setTools(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "No se pudo cargar el catálogo");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const notify = (type: "ok" | "err", text: string) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 4500);
  };

  const handleDelete = async (tool: GlobalTool) => {
    const used = tool.usage_count ?? 0;
    const msg1 =
      used > 0
        ? `¿Eliminar la herramienta "${tool.name}"? Se desasignará de ${used} agente(s). Esta acción no se puede deshacer.`
        : `¿Eliminar la herramienta "${tool.name}"?`;
    if (!confirm(msg1)) return;
    try {
      const r = await adminFetch<{ status: string; assignments_removed: number }>(
        `/admin/tools/${tool.id}`,
        { method: "DELETE" }
      );
      notify("ok", `✅ Herramienta eliminada (${r.assignments_removed} asignaciones removidas)`);
      load();
    } catch (e: unknown) {
      notify("err", `❌ ${e instanceof Error ? e.message : "Error al eliminar"}`);
    }
  };

  return (
    <AppShell
      title="Catálogo de Herramientas"
      description="Crea herramientas reutilizables y asígnalas a múltiples agentes desde un solo lugar."
    >
      {/* Toast */}
      {msg && (
        <div
          className={`mb-4 p-3 rounded-lg text-sm border flex justify-between items-center ${
            msg.type === "ok"
              ? "bg-emerald-900/20 border-emerald-700/40 text-emerald-300"
              : "bg-rose-900/20 border-rose-700/40 text-rose-300"
          }`}
        >
          {msg.text}
          <button onClick={() => setMsg(null)} className="ml-3 opacity-60 hover:opacity-100">
            ✕
          </button>
        </div>
      )}

      {error && (
        <Alert variant="destructive" className="mb-4 border-rose-400/30 bg-rose-500/10">
          <AlertTriangle className="w-4 h-4" />
          <AlertDescription className="text-rose-300">{error}</AlertDescription>
        </Alert>
      )}

      {/* Built-in presets callout */}
      <div className="mb-6 p-4 rounded-lg bg-indigo-500/10 border border-indigo-400/20">
        <div className="flex items-start gap-3">
          <Wrench className="w-5 h-5 text-indigo-300 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-indigo-200 font-medium">
              Herramientas predeterminadas disponibles
            </p>
            <p className="text-xs text-indigo-300/80 mt-0.5">
              Transfer Call · Hang Up · Send SMS · Leave Voicemail están incluidas en la plataforma.
              Se asignan desde la pestaña <span className="font-mono">Herramientas</span> de cada agente
              (no necesitan crearse aquí).
            </p>
          </div>
        </div>
      </div>

      {/* Header + new button */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-gray-200">Catálogo global de webhooks</h2>
        {!creating && (
          <Button
            onClick={() => setCreating(true)}
            className="bg-brand-pink hover:bg-brand-purple text-white gap-2"
          >
            <Plus className="w-4 h-4" /> Nueva herramienta
          </Button>
        )}
      </div>

      {creating && (
        <ToolForm
          onCancel={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            load();
            notify("ok", "✅ Herramienta creada");
          }}
          onError={(m) => notify("err", m)}
        />
      )}

      {/* List */}
      {loading && tools.length === 0 ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-gray-500" />
        </div>
      ) : tools.length === 0 ? (
        <GlassCard className="p-12 text-center text-gray-500 text-sm">
          Aún no hay herramientas globales. Crea la primera con{" "}
          <span className="font-mono text-gray-400">+ Nueva herramienta</span>.
        </GlassCard>
      ) : (
        <div className="space-y-2">
          {tools.map((t) => (
            <ToolCard
              key={t.id}
              tool={t}
              isEditing={editingId === t.id}
              onStartEdit={() => setEditingId(t.id)}
              onCancelEdit={() => setEditingId(null)}
              onSaved={() => {
                setEditingId(null);
                load();
                notify("ok", "✅ Cambios guardados");
              }}
              onDelete={() => handleDelete(t)}
              onError={(m) => notify("err", m)}
              onTest={() => setTestingTool(t)}
            />
          ))}
        </div>
      )}

      {testingTool && (
        <ToolTester
          toolId={testingTool.id}
          toolName={testingTool.name}
          defaultUrl={testingTool.config?.url || ""}
          defaultMethod={testingTool.config?.method || "POST"}
          params={
            testingTool.config?.parameters
              ? schemaToParams(testingTool.config.parameters)
              : []
          }
          onClose={() => setTestingTool(null)}
        />
      )}
    </AppShell>
  );
}

function ToolCard({
  tool,
  isEditing,
  onStartEdit,
  onCancelEdit,
  onSaved,
  onDelete,
  onError,
  onTest,
}: {
  tool: GlobalTool;
  isEditing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaved: () => void;
  onDelete: () => void;
  onError: (m: string) => void;
  onTest: () => void;
}) {
  const used = tool.usage_count ?? 0;
  const url = tool.config?.url || "";
  const method = (tool.config?.method || "POST").toUpperCase();

  if (isEditing) {
    return (
      <ToolForm
        initial={tool}
        onCancel={onCancelEdit}
        onSaved={onSaved}
        onError={onError}
      />
    );
  }

  return (
    <GlassCard className="p-4 flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-medium text-gray-100">{tool.name}</p>
          <code className="text-[10px] text-gray-500 bg-black/30 px-1.5 py-0.5 rounded font-mono">
            {tool.key}
          </code>
          {used > 0 && (
            <span className="text-[10px] text-emerald-300 bg-emerald-500/10 px-1.5 py-0.5 rounded">
              activo en {used} agente{used === 1 ? "" : "s"}
            </span>
          )}
        </div>
        {tool.description && <p className="text-xs text-gray-400 mt-1">{tool.description}</p>}
        {url && (
          <p className="text-[11px] font-mono text-gray-500 mt-1.5 truncate flex items-center gap-1">
            <span className="px-1 py-0.5 rounded bg-white/5 text-gray-400 text-[10px]">{method}</span>
            {url}
          </p>
        )}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={onTest}
          className="text-xs px-2 py-1.5 bg-cyan-500/10 hover:bg-cyan-500/20 rounded-lg text-cyan-300 transition-colors flex items-center gap-1"
          title="Probar webhook sin guardar"
        >
          <FlaskConical className="w-3.5 h-3.5" /> Test
        </button>
        <button
          onClick={onStartEdit}
          className="text-xs px-2 py-1.5 bg-white/5 hover:bg-white/10 rounded-lg text-gray-300 transition-colors"
          title="Editar"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onDelete}
          className="text-xs px-2 py-1.5 bg-rose-500/10 hover:bg-rose-500/20 rounded-lg text-rose-300 transition-colors"
          title={used > 0 ? `Eliminar (desasignará de ${used} agentes)` : "Eliminar"}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </GlassCard>
  );
}