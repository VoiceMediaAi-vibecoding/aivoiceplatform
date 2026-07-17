"use client";

import { useState } from "react";
import { adminFetch } from "@/lib/admin-auth";
import ModelVoiceForm, { type ModelVoiceValue } from "./ModelVoiceForm";
import { type TabProps } from "./types";

/**
 * "Model & Voice" tab — wraps the shared ModelVoiceForm and handles
 * persistence + dirty tracking. The form UI itself lives in
 * ModelVoiceForm.tsx so the agent create modal can reuse it.
 */
export default function ModelVoiceTab({ agent, agentId, onRefresh, notify }: TabProps) {
  const [value, setValue] = useState<ModelVoiceValue>({
    llm_model: agent.llm_model,
    stt_provider: agent.stt_provider,
    tts_provider: agent.tts_provider,
    stt_model: agent.stt_model,
    tts_model: agent.tts_model,
    voice_id: agent.voice_id ?? null,
    language: agent.language,
    temperature: agent.temperature,
    tts_speed: agent.tts_speed ?? 1.0,
    tts_temperature: agent.tts_temperature ?? null,
    tts_text_normalization: agent.tts_text_normalization ?? null,
    tts_delivery_mode: agent.tts_delivery_mode ?? null,
    tts_buffer_char_threshold: agent.tts_buffer_char_threshold ?? null,
    tts_max_buffer_delay_ms: agent.tts_max_buffer_delay_ms ?? null,
  });
  const [saving, setSaving] = useState(false);

  const dirty =
    value.llm_model !== agent.llm_model ||
    value.stt_provider !== agent.stt_provider ||
    value.tts_provider !== agent.tts_provider ||
    value.stt_model !== agent.stt_model ||
    value.tts_model !== agent.tts_model ||
    (value.voice_id ?? "") !== (agent.voice_id ?? "") ||
    value.language !== agent.language ||
    value.temperature !== agent.temperature ||
    (value.tts_speed ?? 1.0) !== (agent.tts_speed ?? 1.0) ||
    (value.tts_temperature ?? null) !== (agent.tts_temperature ?? null) ||
    (value.tts_text_normalization ?? null) !== (agent.tts_text_normalization ?? null) ||
    (value.tts_delivery_mode ?? null) !== (agent.tts_delivery_mode ?? null) ||
    (value.tts_buffer_char_threshold ?? null) !== (agent.tts_buffer_char_threshold ?? null) ||
    (value.tts_max_buffer_delay_ms ?? null) !== (agent.tts_max_buffer_delay_ms ?? null);

  const save = async () => {
    setSaving(true);
    try {
      await adminFetch(`/admin/agents/${agentId}`, {
        method: "PATCH",
        body: JSON.stringify({
          llm_model: value.llm_model,
          stt_provider: value.stt_provider,
          tts_provider: value.tts_provider,
          stt_model: value.stt_model,
          tts_model: value.tts_model,
          voice_id: value.voice_id || null,
          language: value.language,
          temperature: value.temperature,
          tts_speed: value.tts_speed,
          tts_temperature: value.tts_temperature,
          tts_text_normalization: value.tts_text_normalization,
          tts_delivery_mode: value.tts_delivery_mode,
          tts_buffer_char_threshold: value.tts_buffer_char_threshold,
          tts_max_buffer_delay_ms: value.tts_max_buffer_delay_ms,
          note: "Actualización de modelo y voz",
        }),
      });
      notify("ok", "✅ Configuración de modelo y voz guardada");
      onRefresh();
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error al guardar"}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <ModelVoiceForm value={value} onChange={setValue} notify={notify} enablePreview />

      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="px-4 py-2 bg-brand-pink hover:bg-brand-purple disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors"
        >
          {saving ? "Guardando…" : "Guardar cambios"}
        </button>
        {dirty && <span className="text-xs text-amber-300/80">Tienes cambios sin guardar</span>}
      </div>
    </div>
  );
}