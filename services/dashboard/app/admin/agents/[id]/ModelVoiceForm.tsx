"use client";

import { useEffect, useRef, useState } from "react";
import { fetchVoices, previewVoice, type Voice } from "@/lib/voices";
import {
  LLM_MODEL_OPTIONS,
  STT_PROVIDER_OPTIONS,
  TTS_PROVIDER_OPTIONS,
  STT_MODEL_OPTIONS,
  TTS_MODEL_OPTIONS,
  LANGUAGE_OPTIONS,
  INWORLD_LANG_OPTIONS,
  INWORLD_DELIVERY_MODES,
  inputClass,
  labelClass,
} from "./types";

export interface ModelVoiceValue {
  llm_model: string;
  stt_provider: string;
  tts_provider: string;
  stt_model: string;
  tts_model: string;
  voice_id: string | null;
  language: string;
  temperature: number;
  tts_speed: number;
  tts_temperature: number | null;
  tts_text_normalization: boolean | null;
  tts_delivery_mode: string | null;
  tts_buffer_char_threshold: number | null;
  tts_max_buffer_delay_ms: number | null;
}

interface ModelVoiceFormProps {
  /** Current values (controlled). */
  value: ModelVoiceValue;
  /** Called whenever any field changes. */
  onChange: (next: ModelVoiceValue) => void;
  /** Notify helper for transient errors (e.g. preview failures). */
  notify?: (type: "ok" | "err", text: string) => void;
  /** Whether the user can hear voice previews (requires TTS provider key). */
  enablePreview?: boolean;
}

/**
 * Shared "model & voice" form — used by both the agent edit tab and the
 * create-agent modal so an admin can pick provider/model/voice/language/
 * temperature/speed in one place. The host component owns the save button
 * and persistence; this component is pure controlled state.
 */
export default function ModelVoiceForm({
  value,
  onChange,
  notify,
  enablePreview = true,
}: ModelVoiceFormProps) {
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  const update = <K extends keyof ModelVoiceValue>(
    key: K,
    next: ModelVoiceValue[K],
  ) => {
    onChange({ ...value, [key]: next });
  };

  // Re-fetch the voice list whenever the TTS provider or language changes.
  useEffect(() => {
    let cancelled = false;
    setVoices([]);
    setVoicesError(null);
    setPreviewUrl(null);
    if (value.tts_provider !== "elevenlabs" && value.tts_provider !== "inworld") {
      return () => {
        cancelled = true;
      };
    }
    setVoicesLoading(true);
    const provider = value.tts_provider as "elevenlabs" | "inworld";
    const inworldLang = INWORLD_LANG_OPTIONS.includes(value.language)
      ? value.language
      : "en";
    const fetchLanguage = provider === "inworld" ? inworldLang : value.language;
    fetchVoices(provider, fetchLanguage)
      .then((list) => {
        if (!cancelled) setVoices(list);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setVoicesError(
            e instanceof Error ? e.message : "No se pudo cargar el catálogo de voces",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setVoicesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [value.tts_provider, value.language]);

  // Revoke any blob URL we created for Inworld previews so we don't leak memory.
  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  const handlePreview = async (voice: Voice | undefined) => {
    if (!voice) return;
    setPreviewing(true);
    try {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }
      if (previewUrlRef.current && previewUrlRef.current.startsWith("blob:")) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
      const url = await previewVoice(
        value.tts_provider as "elevenlabs" | "inworld",
        voice.id,
        value.tts_model,
      );
      previewUrlRef.current = url;
      setPreviewUrl(url);
      requestAnimationFrame(() => {
        audioRef.current?.play().catch(() => {
          /* autoplay blocked — user can hit play manually */
        });
      });
    } catch (e: unknown) {
      notify?.("err", `❌ ${e instanceof Error ? e.message : "No se pudo reproducir"}`);
    } finally {
      setPreviewing(false);
    }
  };

  // TTS speed range is provider-specific (clamped in the worker).
  // Inworld's livekit-plugins-inworld SDK caps speaking_rate at 1.5.
  const speedMin = value.tts_provider === "inworld" ? 0.5 : 0.8;
  const speedMax = value.tts_provider === "inworld" ? 1.5 : 1.2;

  return (
    <div className="space-y-5">
      {/* ── LLM ─────────────────────────────────────────────────────── */}
      <section>
        <h4 className="text-xs font-semibold text-gray-300 mb-2 uppercase tracking-wider">
          Modelo de lenguaje (LLM)
        </h4>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass}>Modelo</label>
            <select
              value={value.llm_model}
              onChange={(e) => update("llm_model", e.target.value)}
              className={inputClass}
            >
              {LLM_MODEL_OPTIONS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>
              Temperatura <span className="text-gray-500">({value.temperature.toFixed(1)})</span>
            </label>
            <input
              type="range"
              min={0}
              max={1.2}
              step={0.1}
              value={value.temperature}
              onChange={(e) => update("temperature", parseFloat(e.target.value))}
              className="w-full accent-brand-pink mt-2.5"
            />
            <div className="flex justify-between text-[10px] text-gray-500 mt-1">
              <span>Preciso</span>
              <span>Creativo</span>
            </div>
          </div>
        </div>
      </section>

      {/* ── TTS ──────────────────────────────────────────────────────── */}
      <section>
        <h4 className="text-xs font-semibold text-gray-300 mb-2 uppercase tracking-wider">
          Voz (TTS)
        </h4>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass}>Proveedor</label>
            <select
              value={value.tts_provider}
              onChange={(e) => {
                const provider = e.target.value;
                onChange({
                  ...value,
                  tts_provider: provider,
                  tts_model: TTS_MODEL_OPTIONS[provider][0],
                });
              }}
              className={inputClass}
            >
              {TTS_PROVIDER_OPTIONS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>Modelo</label>
            <select
              value={value.tts_model}
              onChange={(e) => update("tts_model", e.target.value)}
              className={inputClass}
            >
              {TTS_MODEL_OPTIONS[value.tts_provider].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
          <div className="col-span-2 space-y-2">
            <div className="flex items-center justify-between">
              <label className={labelClass}>Voz</label>
              {voicesLoading && (
                <span className="text-[10px] text-gray-500">Cargando catálogo…</span>
              )}
              {voicesError && (
                <span className="text-[10px] text-rose-300/80">⚠ {voicesError}</span>
              )}
            </div>
            <div className="flex gap-2">
              <select
                value={voices.some((v) => v.id === value.voice_id) ? value.voice_id ?? "" : ""}
                onChange={(e) => update("voice_id", e.target.value || null)}
                className={`${inputClass} flex-1`}
                disabled={voicesLoading}
              >
                <option value="">— Selecciona una voz —</option>
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                    {v.gender ? ` · ${v.gender}` : ""}
                    {v.language ? ` · ${v.language}` : ""}
                  </option>
                ))}
              </select>
              {enablePreview && (
                <button
                  type="button"
                  onClick={() =>
                    handlePreview(voices.find((v) => v.id === value.voice_id))
                  }
                  disabled={!value.voice_id || previewing || voicesLoading}
                  className="px-3 py-2 bg-white/5 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm transition-colors"
                  title="Escuchar muestra"
                >
                  {previewing ? "…" : "🔊 Escuchar"}
                </button>
              )}
            </div>
            <div className="flex gap-2 items-center">
              <input
                value={value.voice_id ?? ""}
                onChange={(e) => update("voice_id", e.target.value || null)}
                placeholder="o pega un voice_id custom"
                className={`${inputClass} font-mono text-xs flex-1`}
              />
            </div>
            {enablePreview && previewUrl && (
              <audio
                ref={audioRef}
                src={previewUrl}
                controls
                onEnded={() => {
                  if (previewUrlRef.current?.startsWith("blob:")) {
                    URL.revokeObjectURL(previewUrlRef.current);
                    previewUrlRef.current = null;
                  }
                  setPreviewUrl(null);
                }}
                className="w-full h-9 mt-1"
              />
            )}
            <p className="text-[10px] text-gray-500">
              {value.tts_provider === "inworld"
                ? "Las voces de Inworld se filtran por el idioma del agente. El preview se sintetiza al vuelo."
                : "Las voces incluyen las predeterminadas y las de tu workspace en ElevenLabs. El preview usa la muestra pública del proveedor."}
            </p>
          </div>
          {/* Speed slider */}
          <div className="col-span-2">
            <label className={labelClass}>
              Velocidad de voz <span className="text-gray-500">({value.tts_speed.toFixed(2)})</span>
            </label>
            <input
              type="range"
              min={speedMin}
              max={speedMax}
              step={0.05}
              value={Math.min(speedMax, Math.max(speedMin, value.tts_speed))}
              onChange={(e) => update("tts_speed", parseFloat(e.target.value))}
              className="w-full accent-brand-pink mt-2.5"
            />
            <div className="flex justify-between text-[10px] text-gray-500 mt-1">
              <span>Lenta</span>
              <span>Normal (1.0)</span>
              <span>Rápida</span>
            </div>
            <p className="text-[10px] text-gray-500 mt-1">
              {value.tts_provider === "inworld"
                ? `Rango Inworld: ${speedMin} – ${speedMax} (limitado por SDK). Sube si la voz suena muy lenta.`
                : `Rango ElevenLabs: ${speedMin} – ${speedMax}. Sube si la voz suena muy lenta.`}
            </p>
          </div>
          {/* Inworld-only tuning knobs */}
          {value.tts_provider === "inworld" && (
            <div className="col-span-2 space-y-3 pt-3 border-t border-white/5">
              <p className="text-[10px] uppercase tracking-wider text-gray-400">
                Ajustes avanzados Inworld
              </p>

              {/* Temperature (stability / expressiveness) */}
              <div>
                <label className={labelClass}>
                  Temperatura{" "}
                  <span className="text-gray-500">
                    ({(value.tts_temperature ?? 1.0).toFixed(2)})
                  </span>
                </label>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={value.tts_temperature ?? 1.0}
                  onChange={(e) =>
                    update("tts_temperature", parseFloat(e.target.value))
                  }
                  className="w-full accent-brand-pink mt-2.5"
                />
                <div className="flex justify-between text-[10px] text-gray-500 mt-1">
                  <span>Estable</span>
                  <span>Expresiva</span>
                </div>
                <p className="text-[10px] text-gray-500 mt-1">
                  0.0 = voz monótona/predictible, 2.0 = más dramática.
                  Default: 1.0. (Honrado por inworld-tts-2; ignorado por tts-1.)
                </p>
              </div>

              {/* Text normalization: Auto / ON / OFF */}
              <div>
                <label className={labelClass}>Normalización de texto</label>
                <div className="flex gap-2">
                  {([
                    { v: null, label: "Auto" },
                    { v: true, label: "ON" },
                    { v: false, label: "OFF" },
                  ] as const).map(({ v, label }) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => update("tts_text_normalization", v)}
                      className={`px-3 py-1.5 rounded text-xs transition-colors ${
                        (value.tts_text_normalization ?? null) === v
                          ? "bg-brand-pink text-white"
                          : "bg-white/5 text-gray-300 hover:bg-white/10"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-gray-500 mt-1">
                  ON: "Dr." → "Doctor", "123" → "ciento veintitrés".
                  Recomendado para llamadas.
                </p>
              </div>

              {/* Delivery mode (only tts-2) */}
              {value.tts_model === "inworld-tts-2" && (
                <div>
                  <label className={labelClass}>Delivery Mode</label>
                  <div className="flex gap-2">
                    {INWORLD_DELIVERY_MODES.map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => update("tts_delivery_mode", m)}
                        className={`px-3 py-1.5 rounded text-xs transition-colors ${
                          value.tts_delivery_mode === m
                            ? "bg-brand-pink text-white"
                            : "bg-white/5 text-gray-300 hover:bg-white/10"
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-gray-500 mt-1">
                    STABLE = más consistente, CREATIVE = más variado.
                    Solo funciona con inworld-tts-2.
                  </p>
                </div>
              )}

              {/* Buffer tuning */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>
                    Buffer chars{" "}
                    <span className="text-gray-500">
                      ({value.tts_buffer_char_threshold ?? 1000})
                    </span>
                  </label>
                  <input
                    type="number"
                    min={100}
                    value={value.tts_buffer_char_threshold ?? 1000}
                    onChange={(e) =>
                      update(
                        "tts_buffer_char_threshold",
                        e.target.value ? parseInt(e.target.value) : null,
                      )
                    }
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className={labelClass}>
                    Max delay (ms){" "}
                    <span className="text-gray-500">
                      ({value.tts_max_buffer_delay_ms ?? 3000})
                    </span>
                  </label>
                  <input
                    type="number"
                    min={100}
                    value={value.tts_max_buffer_delay_ms ?? 3000}
                    onChange={(e) =>
                      update(
                        "tts_max_buffer_delay_ms",
                        e.target.value ? parseInt(e.target.value) : null,
                      )
                    }
                    className={inputClass}
                  />
                </div>
              </div>
              <p className="text-[10px] text-gray-500">
                Reduce estos valores para menor latencia (a costa de más
                requests de TTS).
              </p>
            </div>
          )}
        </div>
      </section>

      {/* ── STT ──────────────────────────────────────────────────────── */}
      <section>
        <h4 className="text-xs font-semibold text-gray-300 mb-2 uppercase tracking-wider">
          Transcripción (STT)
        </h4>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={labelClass}>Proveedor</label>
            <select
              value={value.stt_provider}
              onChange={(e) => {
                const provider = e.target.value;
                onChange({
                  ...value,
                  stt_provider: provider,
                  stt_model: STT_MODEL_OPTIONS[provider][0],
                });
              }}
              className={inputClass}
            >
              {STT_PROVIDER_OPTIONS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>Modelo</label>
            <select
              value={value.stt_model}
              onChange={(e) => update("stt_model", e.target.value)}
              className={inputClass}
            >
              {STT_MODEL_OPTIONS[value.stt_provider].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>Idioma</label>
            <select
              value={value.language}
              onChange={(e) => update("language", e.target.value)}
              className={inputClass}
            >
              {LANGUAGE_OPTIONS.map((l) => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
          </div>
        </div>
      </section>
    </div>
  );
}