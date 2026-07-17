"use client";

import { useState } from "react";
import { adminFetch } from "@/lib/admin-auth";
import { type TabProps, inputClass, labelClass } from "./types";

/**
 * "Prompt & Greeting" tab — the heart of the persona: the system prompt that
 * drives the LLM's behavior/script/tone, and the opening line spoken the moment
 * a call connects. This is what made "Camila" Camila; now it's editable per agent.
 */
export default function PromptTab({ agent, agentId, onRefresh, notify }: TabProps) {
  const [systemPrompt, setSystemPrompt] = useState(agent.system_prompt ?? "");
  const [greeting, setGreeting] = useState(agent.greeting ?? "");
  const [idleEnabled, setIdleEnabled] = useState((agent.idle_timeout_seconds ?? 0) > 0);
  const [idleTimeout, setIdleTimeout] = useState(agent.idle_timeout_seconds ?? 6);
  const [idleMessage, setIdleMessage] = useState(agent.idle_message ?? "¿Sigues ahí?");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const dirty =
    systemPrompt !== (agent.system_prompt ?? "") ||
    greeting !== (agent.greeting ?? "") ||
    idleEnabled !== (agent.idle_timeout_seconds ?? 0) > 0 ||
    (idleEnabled && idleTimeout !== (agent.idle_timeout_seconds ?? 6)) ||
    idleMessage !== (agent.idle_message ?? "¿Sigues ahí?");

  const save = async () => {
    setSaving(true);
    try {
      await adminFetch(`/admin/agents/${agentId}`, {
        method: "PATCH",
        body: JSON.stringify({
          system_prompt: systemPrompt,
          greeting,
          idle_timeout_seconds: idleEnabled ? idleTimeout : null,
          idle_message: idleMessage,
          note: note.trim() || "Actualización de prompt y saludo",
        }),
      });
      notify("ok", "✅ Prompt y saludo guardados — se creó una nueva versión");
      setNote("");
      onRefresh();
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error al guardar"}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <section>
        <label className={labelClass}>
          Saludo inicial <span className="text-gray-600">— lo primero que dice al conectar la llamada</span>
        </label>
        <textarea
          value={greeting}
          onChange={(e) => setGreeting(e.target.value)}
          rows={3}
          placeholder="Hola! Mi nombre es… le llamo de…"
          className={`${inputClass} resize-y`}
        />
      </section>

      <section>
        <div className="flex items-center justify-between mb-1.5">
          <label className={`${labelClass} mb-0`}>
            Reactivar al cliente si guarda silencio <span className="text-gray-600">— evita que la llamada quede en silencio muerto</span>
          </label>
          <label className="inline-flex items-center gap-2 cursor-pointer shrink-0 ml-4">
            <input
              type="checkbox"
              checked={idleEnabled}
              onChange={(e) => setIdleEnabled(e.target.checked)}
              className="accent-brand-pink"
            />
            <span className="text-xs text-gray-400">{idleEnabled ? "Activado" : "Desactivado"}</span>
          </label>
        </div>
        {idleEnabled && (
          <div className="grid grid-cols-[120px_1fr] gap-3 items-start">
            <div>
              <label className={labelClass}>Esperar (segundos)</label>
              <input
                type="number"
                min={2}
                max={60}
                value={idleTimeout}
                onChange={(e) => setIdleTimeout(Math.max(2, Math.min(60, parseInt(e.target.value) || 6)))}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Frase para reactivar la conversación</label>
              <input
                value={idleMessage}
                onChange={(e) => setIdleMessage(e.target.value)}
                placeholder="¿Sigues ahí?"
                className={inputClass}
              />
            </div>
          </div>
        )}
        <p className="text-xs text-gray-500 mt-1.5">
          Si el cliente no dice nada durante este tiempo, el agente dirá esta frase para comprobar que sigue en la línea.
        </p>
      </section>

      <section>
        <label className={labelClass}>
          Prompt del sistema <span className="text-gray-600">— persona, guion de conversación, reglas y tono</span>
        </label>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={22}
          placeholder="### Información del Asistente ###&#10;Eres … Tu objetivo es …"
          className={`${inputClass} font-mono text-xs leading-relaxed resize-y`}
          spellCheck={false}
        />
        <p className="text-xs text-gray-500 mt-1.5">{systemPrompt.length.toLocaleString()} caracteres</p>
      </section>

      <section>
        <label className={labelClass}>Nota de la versión (opcional)</label>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Ej: Ajusté el manejo de objeciones de precio"
          className={inputClass}
        />
      </section>

      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="px-4 py-2 bg-brand-pink hover:bg-brand-purple disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors"
        >
          {saving ? "Guardando…" : "Guardar y publicar versión"}
        </button>
        {dirty && <span className="text-xs text-amber-300/80">Tienes cambios sin guardar</span>}
      </div>
    </div>
  );
}
