/**
 * Admin auth helpers — client-side only.
 *
 * S2.4 — The Supabase JWT now lives in an HttpOnly, Secure, SameSite=Strict
 * cookie (`admin_session`) set by the backend on login. The browser sends
 * it automatically; JS cannot read it. A separate non-HttpOnly cookie
 * (`csrf_admin`) carries a random token we mirror as the `X-CSRF-Token`
 * header on mutating requests.
 *
 * Backward-compat: this module keeps reading/writing the legacy
 * `admin_token` localStorage key and falls back to `Authorization: Bearer`
 * when no cookie is present (e.g. for cross-tab hand-off during the
 * transition window). Once the dashboard is verified against cookies
 * end-to-end, the localStorage path can be removed.
 */

import { getApiBaseUrl } from "./api-config";

const TOKEN_KEY = "admin_token";        // legacy localStorage — kept for transition
const CSRF_KEY  = "admin_csrf_token";  // mirrored from csrf_admin cookie for non-cookie callers

export const getAPI = getApiBaseUrl;

export interface AdminProfile {
  id: string;
  name: string;
  email: string;
  role: "admin" | "superadmin";
  is_active: boolean;
}

// ── Token storage (transition only) ──────────────────────────────────────────

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
  // Logged-in if either a token is in localStorage OR the session cookie is
  // present (the cookie is HttpOnly so we can't read it, but AdminAuthGuard
  // will hit /admin/me to verify). The boolean returned here is used as a
  // first-pass check before the network round-trip.
  return !!getToken();
}

// ── CSRF token helpers ───────────────────────────────────────────────────────

export function getCsrfToken(): string | null {
  if (typeof window === "undefined") return null;
  // Prefer the localStorage mirror (faster, no document.cookie parse) —
  // set by `login()` after the server response.
  const stored = localStorage.getItem(CSRF_KEY);
  if (stored) return stored;
  // Fallback: read csrf_admin cookie via document.cookie (it's not HttpOnly).
  const match = document.cookie.match(/(?:^|;\s*)csrf_admin=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function setCsrfToken(token: string): void {
  if (typeof window !== "undefined") localStorage.setItem(CSRF_KEY, token);
}

// ── Fetch wrapper ────────────────────────────────────────────────────────────

/**
 * Admin fetch with S2.4 cookie + CSRF. Always sends `credentials: include`
 * so the browser attaches the session cookie. On mutating methods, also
 * sends `X-CSRF-Token` matching the csrf cookie. Falls back to Bearer
 * localStorage token if no cookie is present (transition window).
 */
export async function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const isMutation = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";

  const token = getToken();
  const csrf = isMutation ? getCsrfToken() : null;

  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const headers: Record<string, string> = {
    ...(isFormData ? {} : { "Content-Type": "application/json" }),
    // Always prefer cookie (credentials: include). The Bearer header is a
    // fallback for callers that don't have the cookie yet.
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };

  const res = await fetch(`${getAPI()}${path}`, {
    ...init,
    headers,
    credentials: "include",  // S2.4 — send HttpOnly session cookie
  });

  if (res.status === 401) {
    clearToken();
    if (typeof window !== "undefined") window.location.href = "/login";
    throw new Error("Sesión expirada");
  }
  if (res.status === 403) {
    // Likely a CSRF mismatch on a mutation. Wipe local CSRF mirror and
    // re-auth on the next request.
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

// ── Login / logout ───────────────────────────────────────────────────────────

interface LoginResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  csrf_token?: string;
}

export async function login(email: string, password: string): Promise<void> {
  const res = await fetch(`${getAPI()}/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",  // S2.4 — accept Set-Cookie from response
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Credenciales inválidas" }));
    throw new Error((err as { detail?: string }).detail ?? "Credenciales inválidas");
  }
  const data = (await res.json()) as LoginResponse;
  setToken(data.access_token);
  if (data.csrf_token) setCsrfToken(data.csrf_token);
}

export async function logout(): Promise<void> {
  // Best-effort server-side logout — clears the cookies via Set-Cookie
  // deletion headers. Failures here are non-fatal (the localStorage
  // wipe below + the page reload are what actually end the session).
  try {
    await adminFetch("/admin/logout", { method: "POST" });
  } catch {
    // ignore
  }
  clearToken();
  if (typeof window !== "undefined") window.location.href = "/login";
}

export async function fetchMe(): Promise<{ admin: AdminProfile }> {
  return adminFetch("/admin/me");
}
