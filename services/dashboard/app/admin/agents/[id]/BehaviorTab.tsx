"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, AlertTriangle, Info } from "lucide-react";
import { adminFetch } from "@/lib/admin-auth";
import {
  type TabProps,
  type TurnHandlingConfig,
  type TurnDetectionMode,
  type EndpointingMode,
  type EndpointingConfig,
  type InterruptionConfig,
  type UserTurnLimitConfig,
  type PreemptiveGenConfig,
  inputClass,
  labelClass,
} from "./types";

const TURN_DETECTION_OPTIONS: { value: TurnDetectionMode; label: string; description: string; warn?: string }[] = [
  { value: "stt", label: "STT endpointing", description: "Decide end-of-turn from the STT provider's phrase endpointing. Bajo costo, funciona bien." },
  { value: "vad", label: "Solo VAD (Silero)", description: "Decide end-of-turn solo con la energía de la voz. Funciona con cualquier idioma." },
  { value: "multilingual", label: "Contextual (multilingual)", description: "Modelo open-weights de LiveKit. Mejor calidad en detección, entiende pausas y muletas.", warn: "Descarga ~80MB de modelo y agrega ~50ms de latencia." },
  { value: "manual", label: "Manual (push-to-talk)", description: "Desactiva la detección automática. El frontend debe llamar start_turn/end_turn por RPC." },
];

const DEFAULTS: TurnHandlingConfig = {
  turn_detection: "stt",
  endpointing: { mode: "fixed", min_delay: 0.5, max_delay: 3.0, alpha: 0.9 },
  interruption: {
    enabled: true,
    min_duration: 0.5,
    min_words: 0,
    resume_false_interruption: true,
    false_interruption_timeout: 2.0,
    backchannel_boundary: 1.0,
  },
  user_turn_limit: { max_words: null, max_duration: null },
  preemptive_generation: { enabled: true, preemptive_tts: false, max_speech_duration: 10.0, max_retries: 3 },
};

/** Deep-merge: defaults provide the floor, stored config overrides. */
function merge<T extends object>(defaults: T, override: object | null | undefined): T {
  if (!override || typeof override !== "object") return { ...defaults };
  const out: any = { ...defaults };
  for (const key of Object.keys(override as object)) {
    const v = (override as any)[key];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[key] = merge((defaults as any)[key] || {}, v);
    } else {
      out[key] = v;
    }
  }
  return out as T;
}

/** "Comportamiento de turno" tab — VAPI-style Start/Stop Speaking Plan
 *  plus LiveKit's richer interruption + preemptive generation controls.
 *  All four sub-sections are collapsible; saving snapshots a new version. */
export default function BehaviorTab({ agent, agentId, onRefresh, notify }: TabProps) {
  const [cfg, setCfg] = useState<TurnHandlingConfig>(merge(DEFAULTS, agent.turn_handling));
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState({ start: true, stop: false, interrupt: false, preempt: false });

  // We compare against the *stored* (server) value, not the merged defaults,
  // so a "reset to defaults" shows up as dirty.
  const server: TurnHandlingConfig = (agent.turn_handling as TurnHandlingConfig) || {};
  const dirty = JSON.stringify(stripEmpty(server)) !== JSON.stringify(stripEmpty(cfg));

  const save = async () => {
    setSaving(true);
    try {
      await adminFetch(`/admin/agents/${agentId}`, {
        method: "PATCH",
        body: JSON.stringify({
          turn_handling: stripEmpty(cfg),
          note: "Comportamiento de turno actualizado",
        }),
      });
      notify("ok", "✅ Comportamiento guardado");
      onRefresh();
    } catch (err: unknown) {
      notify("err", `❌ ${err instanceof Error ? err.message : "Error al guardar"}`);
    } finally {
      setSaving(false);
    }
  };

  const resetDefaults = () => setCfg(DEFAULTS);

  // ── Sub-section updaters (immer-free, just path updates) ──────────────
  const update = (mutator: (draft: TurnHandlingConfig) => void) => {
    setCfg((prev) => {
      const draft: TurnHandlingConfig = JSON.parse(JSON.stringify(prev));
      mutator(draft);
      return draft;
    });
  };

  return (
    <div className="space-y-3 max-w-2xl">
      <p className="text-sm text-gray-300">
        Ajusta cuándo el agente empieza a hablar, cuándo deja de escuchar, si el usuario puede
        interrumpirlo y si el agente puede empezar a generar mientras el usuario aún habla.
        Configuración vacía = defaults de LiveKit (mismo comportamiento que antes).
      </p>

      <Section
        title="Cuándo empezar a hablar"
        emoji="🗣"
        hint="Start Speaking Plan — cuánto espera el agente para declarar el turno del usuario como terminado."
        open={open.start}
        onToggle={() => setOpen((o) => ({ ...o, start: !o.start }))}
      >
        <div className="space-y-3">
          <div>
            <label className={labelClass}>Modo de detección de turno</label>
            <select
              value={cfg.turn_detection ?? "stt"}
              onChange={(e) => update((d) => { d.turn_detection = e.target.value as TurnDetectionMode; })}
              className={inputClass}
            >
              {TURN_DETECTION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <p className="text-[11px] text-gray-400 mt-1">
              {TURN_DETECTION_OPTIONS.find((o) => o.value === (cfg.turn_detection ?? "stt"))?.description}
            </p>
            {TURN_DETECTION_OPTIONS.find((o) => o.value === cfg.turn_detection)?.warn && (
              <p className="text-[11px] text-amber-300 mt-1 flex items-start gap-1">
                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                {TURN_DETECTION_OPTIONS.find((o) => o.value === cfg.turn_detection)?.warn}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <RangeField
              label="Latencia mínima"
              hint="Segundos que el agente espera después de la última voz antes de declarar el turno como terminado. Más bajo = responde más rápido pero puede cortar muletas (eh, este…)."
              min={0} max={5} step={0.1} unit="s"
              value={cfg.endpointing?.min_delay ?? 0.5}
              onChange={(v) => update((d) => { d.endpointing = { ...(d.endpointing ?? {}), min_delay: v } as EndpointingConfig; })}
            />
            <RangeField
              label="Latencia máxima"
              hint="Cap absoluto. Si el usuario hace una pausa larga, el agente responde a los N segundos como máximo."
              min={0.5} max={10} step={0.1} unit="s"
              value={cfg.endpointing?.max_delay ?? 3.0}
              onChange={(v) => update((d) => { d.endpointing = { ...(d.endpointing ?? {}), max_delay: v } as EndpointingConfig; })}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>Modo de endpointing</label>
              <select
                value={cfg.endpointing?.mode ?? "fixed"}
                onChange={(e) => update((d) => { d.endpointing = { ...(d.endpointing ?? {}), mode: e.target.value as EndpointingMode } as EndpointingConfig; })}
                className={inputClass}
              >
                <option value="fixed">Fija (usa min_delay / max_delay exactos)</option>
                <option value="dynamic">Dinámica (ajusta entre min y max según historial)</option>
              </select>
            </div>
            {(cfg.endpointing?.mode ?? "fixed") === "dynamic" && (
              <RangeField
                label="Alpha (suavizado)"
                hint="Cuánto peso se le da al historial. Más alto = más estable, más bajo = más reactivo."
                min={0.1} max={1.0} step={0.05}
                value={cfg.endpointing?.alpha ?? 0.9}
                onChange={(v) => update((d) => { d.endpointing = { ...(d.endpointing ?? {}), alpha: v } as EndpointingConfig; })}
              />
            )}
          </div>
        </div>
      </Section>

      <Section
        title="Cuándo dejar de escuchar al usuario"
        emoji="⏱"
        hint="Stop Speaking Plan — corta al usuario si monopoliza la conversación (ej. está leyendo una lista o dejó un voicemail de 2 min)."
        open={open.stop}
        onToggle={() => setOpen((o) => ({ ...o, stop: !o.stop }))}
      >
        <div className="space-y-3">
          <NumberToggleField
            label="Máx palabras acumuladas del usuario"
            hint="Si el usuario acumula N palabras sin que el agente logre responder, el agente lo interrumpe educadamente."
            min={10} max={500} step={10} unit="palabras"
            value={cfg.user_turn_limit?.max_words ?? null}
            onChange={(v) => update((d) => { d.user_turn_limit = { ...(d.user_turn_limit ?? { max_words: null, max_duration: null }), max_words: v } as UserTurnLimitConfig; })}
          />
          <NumberToggleField
            label="Máx duración acumulada"
            hint="Tiempo total (s) que el usuario puede hablar sin que el agente responda antes de ser interrumpido."
            min={5} max={300} step={5} unit="s"
            value={cfg.user_turn_limit?.max_duration ?? null}
            onChange={(v) => update((d) => { d.user_turn_limit = { ...(d.user_turn_limit ?? { max_words: null, max_duration: null }), max_duration: v } as UserTurnLimitConfig; })}
          />
          <p className="text-[11px] text-gray-400 flex items-start gap-1">
            <Info className="w-3 h-3 mt-0.5 shrink-0" />
            Ambos contadores se resetean cuando el agente transiciona a "speaking". Si ambos están
            desactivados, el agente espera indefinidamente.
          </p>
        </div>
      </Section>

      <Section
        title="Interrupciones del agente"
        emoji="✋"
        hint="Controla si el usuario puede interrumpir al agente mientras habla, y qué cuenta como interrupción real."
        open={open.interrupt}
        onToggle={() => setOpen((o) => ({ ...o, interrupt: !o.interrupt }))}
      >
        <div className="space-y-3">
          <ToggleField
            label="Permitir que el usuario interrumpa"
            hint="Si está desactivado, el agente termina su turno completo sin poder ser cortado (útil para mensajes legales, confirmaciones críticas)."
            value={cfg.interruption?.enabled ?? true}
            onChange={(v) => update((d) => { d.interruption = { ...(d.interruption ?? {}), enabled: v } as InterruptionConfig; })}
          />
          <div className="grid grid-cols-2 gap-3">
            <RangeField
              label="Mín duración para interrumpir"
              hint="Filtra tos, clics y sonidos cortos. 0.3s es un buen balance."
              min={0} max={2} step={0.05} unit="s"
              value={cfg.interruption?.min_duration ?? 0.5}
              onChange={(v) => update((d) => { d.interruption = { ...(d.interruption ?? {}), min_duration: v } as InterruptionConfig; })}
            />
            <NumberField
              label="Mín palabras para interrumpir"
              hint="Requiere N palabras para considerar la voz como interrupción (solo si STT está activo). 1+ filtra muletas (ah, este…)."
              min={0} max={10} step={1}
              value={cfg.interruption?.min_words ?? 0}
              onChange={(v) => update((d) => { d.interruption = { ...(d.interruption ?? {}), min_words: v } as InterruptionConfig; })}
            />
          </div>
          <ToggleField
            label="Reanudar tras falsa interrupción"
            hint="Si el agente detecta voz pero el STT no transcribe nada (tos, ruido), continúa donde quedó."
            value={cfg.interruption?.resume_false_interruption ?? true}
            onChange={(v) => update((d) => { d.interruption = { ...(d.interruption ?? {}), resume_false_interruption: v } as InterruptionConfig; })}
          />
          <RangeField
            label="Timeout falsa interrupción"
            hint="Segundos de silencio después de una interrupción sin transcripción para considerarla falsa y reanudar."
            min={0.5} max={10} step={0.1} unit="s"
            value={cfg.interruption?.false_interruption_timeout ?? 2.0}
            onChange={(v) => update((d) => { d.interruption = { ...(d.interruption ?? {}), false_interruption_timeout: v } as InterruptionConfig; })}
            disabled={!cfg.interruption?.resume_false_interruption}
          />
          <RangeField
            label="Backchannel cooldown"
            hint="Ventana al inicio/fin de cada turno del agente donde muletas del usuario se suprimen. Reduce falsos positivos."
            min={0} max={5} step={0.1} unit="s"
            value={cfg.interruption?.backchannel_boundary ?? 1.0}
            onChange={(v) => update((d) => { d.interruption = { ...(d.interruption ?? {}), backchannel_boundary: v } as InterruptionConfig; })}
          />
        </div>
      </Section>

      <Section
        title="Generación preemptiva"
        emoji="⚡"
        hint="Experimental — el LLM empieza a generar la respuesta MIENTRAS el usuario aún está hablando, para reducir latencia percibida."
        open={open.preempt}
        onToggle={() => setOpen((o) => ({ ...o, preempt: !o.preempt }))}
      >
        <div className="space-y-3">
          <p className="text-[11px] text-amber-300 flex items-start gap-1 p-2 rounded bg-amber-500/10 border border-amber-400/20">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>La generación preemptiva puede alucinar respuestas "fantasma" si el usuario cambia de tema al final. Empieza con la opción conservadora.</span>
          </p>
          <ToggleField
            label="Activar preemptive generation"
            hint="El LLM empieza a generar apenas el VAD detecta que el usuario podría estar terminando. Reduce latencia ~200-400ms."
            value={cfg.preemptive_generation?.enabled ?? true}
            onChange={(v) => update((d) => { d.preemptive_generation = { ...(d.preemptive_generation ?? {}), enabled: v } as PreemptiveGenConfig; })}
          />
          <ToggleField
            label="También TTS preemptivo"
            hint={'Aún más rápido (empieza a "hablar" antes de que el usuario termine) pero menos flexible. Solo activar si la latencia es crítica.'}
            value={cfg.preemptive_generation?.preemptive_tts ?? false}
            onChange={(v) => update((d) => { d.preemptive_generation = { ...(d.preemptive_generation ?? {}), preemptive_tts: v } as PreemptiveGenConfig; })}
            disabled={!cfg.preemptive_generation?.enabled}
          />
          <div className="grid grid-cols-2 gap-3">
            <RangeField
              label="Máx duración preemptiva"
              hint="Más allá de este tiempo hablando, se desactiva (probablemente está contando una historia larga)."
              min={5} max={30} step={0.5} unit="s"
              value={cfg.preemptive_generation?.max_speech_duration ?? 10.0}
              onChange={(v) => update((d) => { d.preemptive_generation = { ...(d.preemptive_generation ?? {}), max_speech_duration: v } as PreemptiveGenConfig; })}
              disabled={!cfg.preemptive_generation?.enabled}
            />
            <NumberField
              label="Máx reintentos"
              hint="Cuántas veces el LLM puede empezar de nuevo si la transcripción cambia. Más alto = más adaptativo pero más costo."
              min={1} max={5} step={1}
              value={cfg.preemptive_generation?.max_retries ?? 3}
              onChange={(v) => update((d) => { d.preemptive_generation = { ...(d.preemptive_generation ?? {}), max_retries: v } as PreemptiveGenConfig; })}
              disabled={!cfg.preemptive_generation?.enabled}
            />
          </div>
        </div>
      </Section>

      <div className="flex items-center gap-3 pt-4">
        <button
          onClick={save}
          disabled={!dirty || saving}
          className="px-4 py-2 bg-brand-pink hover:bg-brand-purple disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors"
        >
          {saving ? "Guardando…" : "Guardar cambios"}
        </button>
        <button
          onClick={resetDefaults}
          className="text-xs text-gray-400 hover:text-gray-200 underline"
        >
          Restaurar defaults
        </button>
        {dirty && <span className="text-xs text-amber-300/80">Tienes cambios sin guardar</span>}
      </div>
    </div>
  );
}

// ── Reusable sub-components ────────────────────────────────────────────────

function Section({
  title,
  emoji,
  hint,
  open,
  onToggle,
  children,
}: {
  title: string;
  emoji: string;
  hint: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="glass-card rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-3 p-4 text-left hover:bg-white/[0.02] transition-colors"
      >
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-gray-100 flex items-center gap-2">
            <span>{emoji}</span> {title}
          </h3>
          <p className="text-xs text-gray-400 mt-0.5">{hint}</p>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-gray-400 shrink-0" /> : <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" />}
      </button>
      {open && <div className="p-4 pt-0 border-t border-white/5 space-y-3">{children}</div>}
    </section>
  );
}

function RangeField({
  label,
  hint,
  min,
  max,
  step,
  unit,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className={disabled ? "opacity-50 pointer-events-none" : ""}>
      <label className={labelClass}>
        {label}{" "}
        <span className="text-gray-400">({value.toFixed(step < 1 ? 2 : 0)}{unit ? ` ${unit}` : ""})</span>
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-brand-pink mt-2"
      />
      <p className="text-[11px] text-gray-400 mt-1">{hint}</p>
    </div>
  );
}

function NumberField({
  label,
  hint,
  min,
  max,
  step,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className={disabled ? "opacity-50 pointer-events-none" : ""}>
      <label className={labelClass}>{label}</label>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10) || 0)}
        className={inputClass}
      />
      <p className="text-[11px] text-gray-400 mt-1">{hint}</p>
    </div>
  );
}

function ToggleField({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-start gap-3 cursor-pointer ${disabled ? "opacity-50 pointer-events-none" : ""}`}>
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 w-4 h-4 rounded accent-brand-pink shrink-0"
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-200">{label}</p>
        <p className="text-[11px] text-gray-400 mt-0.5">{hint}</p>
      </div>
    </label>
  );
}

function NumberToggleField({
  label,
  hint,
  min,
  max,
  step,
  unit,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  const enabled = value !== null;
  return (
    <div>
      <label className="flex items-center gap-2 cursor-pointer mb-1.5">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange(e.target.checked ? min : null)}
          className="w-4 h-4 rounded accent-brand-pink"
        />
        <span className="text-xs text-gray-300">{label}</span>
      </label>
      <div className={enabled ? "" : "opacity-40 pointer-events-none"}>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={min}
            max={max}
            step={step}
            value={value ?? min}
            onChange={(e) => onChange(parseFloat(e.target.value) || min)}
            className={`${inputClass} flex-1`}
            disabled={!enabled}
          />
          {unit && <span className="text-xs text-gray-400 shrink-0">{unit}</span>}
        </div>
        <p className="text-[11px] text-gray-400 mt-1">{hint}</p>
      </div>
    </div>
  );
}

/** Strip empty / undefined fields from the config before sending to the API. */
function stripEmpty(cfg: TurnHandlingConfig): TurnHandlingConfig {
  const clean: any = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sub = stripEmpty(v as any);
      if (Object.keys(sub).length > 0) clean[k] = sub;
    } else if (v !== undefined && v !== null) {
      clean[k] = v;
    }
  }
  return clean;
}
