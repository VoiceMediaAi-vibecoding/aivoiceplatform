/**
 * Portal auth helpers — client-side only.
 *
 * S2.4 — the Supabase JWT now lives in an HttpOnly cookie (`portal_session`)
 * set by the backend on login. JS cannot read it. A separate non-HttpOnly
 * cookie (`csrf_portal`) carries the CSRF token we mirror as
 * `X-CSRF-Token` on mutating requests.
 *
 * Backward-compat: this module still falls back to the legacy
 * `portal_token` localStorage key during the transition window.
 */

import { getApiBaseUrl } from "./api-config";

const TOKEN_KEY = "portal_token";
const CSRF_KEY  = "portal_csrf_token";

const API = getApiBaseUrl();

export interface PortalClient {
  id: string;
  name: string;
  email: string;
}

export interface PortalAgent {
  id: string;
  name: string;
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(CSRF_KEY);
}

export function isLoggedIn(): boolean {
  return !!getToken();
}

export function getCsrfToken(): string | null {
  if (typeof window === "undefined") return null;
  const stored = localStorage.getItem(CSRF_KEY);
  if (stored) return stored;
  const match = document.cookie.match(/(?:^|;\s*)csrf_portal=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function setCsrfToken(token: string): void {
  if (typeof window !== "undefined") localStorage.setItem(CSRF_KEY, token);
}

/**
 * Centralized portal fetch. Sends `credentials: include` so the HttpOnly
 * session cookie travels, and adds `X-CSRF-Token` on mutating methods.
 * On 401 we clear the token and force a hard reload to /login.
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const isMutation = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";

  const token = getToken();
  const csrf = isMutation ? getCsrfToken() : null;
  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;

  const headers: Record<string, string> = {
    ...(isFormData ? {} : { "Content-Type": "application/json" }),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };

  const res = await fetch(`${API}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });

  if (res.status === 401) {
    clearToken();
    if (typeof window !== "undefined") window.location.href = "/login";
    throw new Error("Sesión expirada");
  }
  if (res.status === 403) {
    const body = await res.json().catch(() => ({}));
    if (String((body as { detail?: string }).detail ?? "").toLowerCase().includes("csrf")) {
      localStorage.removeItem(CSRF_KEY);
    }
    throw new Error((body as { detail?: string }).detail ?? "Forbidden");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error((err as { detail?: string }).detail ?? "Request failed");
  }
  return res.json() as Promise<T>;
}

export { apiFetch as portalFetch };

interface LoginResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  csrf_token?: string;
}

export async function login(email: string, password: string): Promise<void> {
  const data = await apiFetch<LoginResponse>("/portal/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  setToken(data.access_token);
  if (data.csrf_token) setCsrfToken(data.csrf_token);
}

export async function logout(): Promise<void> {
  try {
    await apiFetch("/portal/logout", { method: "POST" });
  } catch {
    // ignore
  }
  clearToken();
  if (typeof window !== "undefined") window.location.href = "/login";
}

export async function fetchMe(): Promise<{ client: PortalClient; agents: PortalAgent[] }> {
  return apiFetch("/portal/me");
}

export async function fetchCampaigns() {
  return apiFetch<Campaign[]>("/portal/campaigns");
}

export async function fetchCampaignCalls(campaignId: string) {
  return apiFetch<CallRow[]>(`/portal/campaigns/${campaignId}/calls`);
}

export async function fetchCalls(limit = 100) {
  return apiFetch<InboundCall[]>(`/portal/calls?limit=${limit}`);
}

export interface Campaign {
  id: string;
  name: string;
  status: string;
  total_numbers: number;
  called: number;
  answered: number;
  voicemail: number;
  no_answer: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface CallRow {
  id: number;
  phone_number: string;
  customer_name: string | null;
  status: string;
  end_reason: string | null;
  duration_seconds: number | null;
  transcript: string | null;
  recording_url: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface InboundCall {
  id: string;
  direction: "inbound" | "outbound";
  from_number: string | null;
  to_number: string | null;
  status: string;
  status_label?: string | null;
  duration_seconds: number | null;
  started_at: string | null;
  ended_at: string | null;
  room_name: string | null;
  cost_usd: number | null;
  transcript: string | null;
  recording_url: string | null;
  twilio_call_sid: string | null;
  /** "campaign" when sourced from call_queue, undefined for session-based rows */
  source?: "campaign" | undefined;
}
