"use client";

import { useState } from "react";
import { adminFetch } from "@/lib/admin-auth";
import { type TabProps, inputClass, labelClass } from "./types";

/**
 * "Knowledge Base" tab — lightweight text-snippet KB. Each entry gets appended
 * to the agent's system prompt at runtime as reference material (no embeddings/
 * RAG — simple and predictable, matching the scale of a single-persona agent).
 */
export default function KnowledgeTab({ agent, agentId, onRefresh, notify }: TabProps) {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);

  const create = async () => {
    if (!title.trim() || !content.trim()) return;
    setSaving(true);
    try {
      await adminFetch(`/admin/agents/${agentId}/knowledge`, {
        method: "POST",
        body: JSON.stringify({ title: title.trim(), content: content.trim() }),
      });
      notify("ok", "✅ Entrada agregada a la base de conocimiento");
      setTitle("");
      setContent("");
      setCreating(false);
      onRefresh();
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error al crear"}`);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string, entryTitle: string) => {
    if (!confirm(`¿Eliminar "${entryTitle}" de la base de conocimiento?`)) return;
    try {
      await adminFetch(`/admin/agents/${agentId}/knowledge/${id}`, { method: "DELETE" });
      notify("ok", "✅ Entrada eliminada");
      onRefresh();
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error al eliminar"}`);
    }
  };

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-200">Fragmentos de conocimiento</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Se agregan automáticamente al prompt del agente como referencia adicional (precios, políticas, FAQs…).
          </p>
        </div>
        {!creating && (
          <button
            onClick={() => setCreating(true)}
            className="text-xs px-3 py-1.5 bg-brand-pink hover:bg-brand-purple rounded-lg font-medium transition-colors shrink-0"
          >
            + Agregar
          </button>
        )}
      </div>

      {creating && (
        <div className="bg-white/5 border border-white/10 rounded-xl p-4 space-y-3">
          <div>
            <label className={labelClass}>Título</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ej: Horarios de sucursales" className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Contenido</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={6}
              placeholder="Texto que el agente puede usar como referencia durante la conversación…"
              className={`${inputClass} resize-y`}
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={create}
              disabled={!title.trim() || !content.trim() || saving}
              className="px-4 py-2 bg-brand-pink hover:bg-brand-purple disabled:opacity-40 rounded-lg text-sm font-medium transition-colors"
            >
              {saving ? "Guardando…" : "Agregar"}
            </button>
            <button
              onClick={() => { setCreating(false); setTitle(""); setContent(""); }}
              className="px-4 py-2 bg-white/5 hover:bg-white/10 rounded-lg text-sm transition-colors"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {agent.knowledge.length === 0 ? (
        <p className="text-xs text-gray-600 italic">Sin entradas todavía — agrega referencias que el agente deba conocer.</p>
      ) : (
        <div className="space-y-2">
          {agent.knowledge.map((k) => (
            <div key={k.id} className="bg-white/5 border border-white/10 rounded-xl p-3.5">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-medium text-gray-100">{k.title}</p>
                <button
                  onClick={() => remove(k.id, k.title)}
                  className="text-xs px-2 py-1 text-rose-300/80 hover:text-rose-300 hover:bg-rose-500/10 rounded transition-colors shrink-0"
                >
                  🗑
                </button>
              </div>
              <p className="text-xs text-gray-400 mt-1.5 whitespace-pre-wrap line-clamp-4">{k.content}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
