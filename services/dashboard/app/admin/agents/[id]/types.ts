/**
 * Shared types for the agent builder (VAPI-style full agent control).
 * One source of truth so the page shell and each tab agree on shapes.
 */

export interface Client {
  id: string;
  name: string;
  email: string;
}

export interface AgentDetail {
  id: string;
  client_id: string;
  name: string;
  description: string | null;
  voice_id: string | null;
  lk_agent_name: string;
  is_active: boolean;
  created_at: string;
  system_prompt: string | null;
  greeting: string | null;
  llm_model: string;
  stt_model: string;
  tts_model: string;
  stt_provider: string;
  tts_provider: string;
  temperature: number;
  language: string;
  tts_speed: number | null;
  tts_temperature: number | null;
  tts_text_normalization: boolean | null;
  tts_delivery_mode: string | null;
  tts_buffer_char_threshold: number | null;
  tts_max_buffer_delay_ms: number | null;
  webhook_url: string | null;
  webhook_secret: string | null;
  idle_timeout_seconds: number | null;
  idle_message: string | null;
  turn_handling: TurnHandlingConfig;
  clients: Client | null;
  tools: AgentTool[];
  knowledge: KnowledgeEntry[];
  version_count: number;
}

export interface AgentTool {
  id: string;
  agent_id: string;
  key: string;
  label: string;
  description: string | null;
  tool_type: "builtin" | "webhook";
  enabled: boolean;
  config: Record<string, unknown>;
  custom_config: Record<string, unknown> | null;
  tool_id: string | null;
  created_at: string;
  /** Populated by GET /admin/agents/{id}/tools when this row is an assignment
   *  of a global catalog tool. */
  global_tool?: {
    id: string;
    name: string;
    key: string;
    description: string | null;
    config: Record<string, unknown>;
  };
}

export interface KnowledgeEntry {
  id: string;
  agent_id: string;
  title: string;
  content: string;
  created_at: string;
}

export interface AgentVersion {
  id: string;
  agent_id: string;
  version_number: number;
  name: string | null;
  description: string | null;
  system_prompt: string | null;
  greeting: string | null;
  voice_id: string | null;
  llm_model: string | null;
  stt_model: string | null;
  tts_model: string | null;
  temperature: number | null;
  language: string | null;
  note: string | null;
  created_at: string;
  admin_users: { name: string; email: string } | null;
}

export type Notify = (type: "ok" | "err", text: string) => void;

/** Shared tab props — every tab gets the agent, a refresh trigger, and a toast notifier. */
export interface TabProps {
  agent: AgentDetail;
  agentId: string;
  onRefresh: () => void;
  notify: Notify;
}

export const LLM_MODEL_OPTIONS = ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-5", "gpt-5-mini", "gpt-5-nano"];
export const STT_PROVIDER_OPTIONS = ["deepgram", "inworld"];
export const TTS_PROVIDER_OPTIONS = ["elevenlabs", "inworld"];
export const STT_MODEL_OPTIONS: Record<string, string[]> = {
  deepgram: ["nova-3", "nova-2", "whisper-large"],
  inworld: ["inworld/inworld-stt-1"],
};
export const TTS_MODEL_OPTIONS: Record<string, string[]> = {
  elevenlabs: ["eleven_turbo_v2_5", "eleven_multilingual_v2", "eleven_flash_v2_5"],
  inworld: ["inworld-tts-1", "inworld-tts-1.5-max", "inworld-tts-2"],
};
export const INWORLD_DELIVERY_MODES = ["STABLE", "BALANCED", "CREATIVE"];
export const LANGUAGE_OPTIONS = [
  { value: "es", label: "Español" },
  { value: "en", label: "English" },
  { value: "pt", label: "Português" },
];

export interface Voice {
  id: string;
  name: string;
  description?: string | null;
  preview_url?: string | null;
  language?: string | null;
  gender?: string | null;
  tags?: string[];
}

/**
 * Subset of Inworld TTS languages surfaced in the voice catalog filter.
 * Inworld supports 15 languages across the GA models; the top LatAm + US
 * languages are the realistic defaults for a LatAm platform.
 */
export const INWORLD_LANG_OPTIONS = ["es", "en", "pt", "fr", "it", "de"];

// ── Turn handling (VAPI-style Start/Stop Speaking Plan + LiveKit extras) ────

export type TurnDetectionMode = "vad" | "stt" | "multilingual" | "manual";
export type EndpointingMode = "fixed" | "dynamic";
export type InterruptionMode = "adaptive" | "vad";

export interface EndpointingConfig {
  mode?: EndpointingMode;
  min_delay?: number;       // 0.0 - 5.0 s
  max_delay?: number;       // 0.5 - 10.0 s
  alpha?: number;           // 0.1 - 1.0 (only for "dynamic" mode)
}

export interface InterruptionConfig {
  enabled?: boolean;
  min_duration?: number;    // 0.0 - 2.0 s
  min_words?: number;       // 0 - 10
  resume_false_interruption?: boolean;
  false_interruption_timeout?: number;  // 0.5 - 10.0 s
  backchannel_boundary?: number;         // 0.0 - 5.0 s
}

export interface UserTurnLimitConfig {
  max_words?: number | null;     // null = off; 10 - 500
  max_duration?: number | null;  // null = off; 5.0 - 300.0 s
}

export interface PreemptiveGenConfig {
  enabled?: boolean;
  preemptive_tts?: boolean;
  max_speech_duration?: number;  // 5.0 - 30.0 s
  max_retries?: number;          // 1 - 5
}

export interface TurnHandlingConfig {
  turn_detection?: TurnDetectionMode;
  endpointing?: EndpointingConfig;
  interruption?: InterruptionConfig;
  user_turn_limit?: UserTurnLimitConfig;
  preemptive_generation?: PreemptiveGenConfig;
}

export const inputClass =
  "w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-400/60 transition-colors";
export const labelClass = "block text-xs text-gray-400 mb-1.5";
