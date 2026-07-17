/**
 * Voice catalog helpers for the agent builder's "Modelo y voz" tab.
 * Fetches + caches the live voice list per TTS provider so the dropdown
 * doesn't refetch on every tab open. Preview returns either a URL (ElevenLabs
 * public sample) or a blob URL (Inworld, synthesized on the fly).
 */
import { adminFetch, getAPI, getToken } from "./admin-auth";

export interface Voice {
  id: string;
  name: string;
  description?: string | null;
  preview_url?: string | null;
  language?: string | null;
  gender?: string | null;
  tags?: string[];
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_PREFIX = "voices:v1:";

function cachedGet<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ts: number; data: T };
    if (Date.now() - parsed.ts > CACHE_TTL_MS) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function cachedSet(key: string, data: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }));
  } catch {
    /* quota / private mode — ignore */
  }
}

function cachedClear(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function clearVoiceCache(provider?: "elevenlabs" | "inworld", language?: string) {
  if (typeof window === "undefined") return;
  if (provider) {
    cachedClear(`${CACHE_PREFIX}${provider}:${language || "default"}`);
  } else {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
    }
  }
}

export async function fetchVoices(
  provider: "elevenlabs" | "inworld",
  language = "es",
  options: { search?: string; noCache?: boolean } = {},
): Promise<Voice[]> {
  const key = `${CACHE_PREFIX}${provider}:${language || "default"}`;
  if (!options.noCache) {
    const hit = cachedGet<Voice[]>(key);
    if (hit) return hit;
  }
  const path =
    provider === "elevenlabs"
      ? `/admin/voices/elevenlabs${options.search ? `?search=${encodeURIComponent(options.search)}` : ""}`
      : `/admin/voices/inworld?language=${encodeURIComponent(language)}`;
  const voices = await adminFetch<Voice[]>(path);
  cachedSet(key, voices);
  return voices;
}

/**
 * Returns a playable URL for a voice sample.
 * - ElevenLabs: reuses the public `preview_url` from the cached catalog
 *   (no extra round-trip; the URL is already in the list).
 * - Inworld: POSTs to the backend which synthesizes a short sample and
 *   streams back the MP3 bytes — wrapped in a blob URL the caller must
 *   revoke when done (the component revokes on audio `ended`).
 */
export async function previewVoice(
  provider: "elevenlabs" | "inworld",
  voiceId: string,
  modelId: string,
): Promise<string> {
  if (!voiceId) throw new Error("voiceId is required");

  if (provider === "elevenlabs") {
    const voices = await fetchVoices("elevenlabs");
    const v = voices.find((x) => x.id === voiceId);
    if (!v?.preview_url) {
      throw new Error("Esta voz no tiene muestra de audio disponible");
    }
    return v.preview_url;
  }

  const resp = await fetch(`${getAPI()}/admin/voices/inworld/preview`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken() ?? ""}`,
    },
    body: JSON.stringify({ voice_id: voiceId, model_id: modelId }),
  });
  if (!resp.ok) {
    const err = (await resp.json().catch(() => ({}))) as { detail?: string };
    throw new Error(err.detail || `Preview failed (${resp.status})`);
  }
  const blob = await resp.blob();
  return URL.createObjectURL(blob);
}
