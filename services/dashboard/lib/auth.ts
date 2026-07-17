/**
 * Unified login — single entry point for the platform.
 *
 * The backend (`POST /auth/login`) authenticates against the shared Supabase
 * Auth and resolves the account's role via table lookup (admin_users vs
 * clients), exactly like `_get_admin_from_token`/`_get_client_from_token` do
 * per-request. The backend also sets the S2.4 session cookies and returns
 * the CSRF token in the body.
 *
 * S2.4 follow-up — this helper now:
 *   1. Sends `credentials: include` so the browser stores the Set-Cookie
 *      response headers (admin_session + csrf_admin).
 *   2. Persists the CSRF token in localStorage so adminFetch can echo it as
 *      the `X-CSRF-Token` header on mutating requests.
 *
 * Backward compat: still stores the access_token in localStorage as a Bearer
 * fallback for any endpoint that hasn't been migrated to cookies yet.
 */

import {
  setToken as setAdminToken,
  setCsrfToken as setAdminCsrfToken,
} from "./admin-auth";
import {
  setToken as setPortalToken,
  setCsrfToken as setPortalCsrfToken,
} from "./portal-auth";
import { getApiBaseUrl as getAPI } from "./api-config";

export type Role = "admin" | "client";

export interface UnifiedLoginResult {
  role: Role;
  redirectTo: string;
}

interface UnifiedLoginResponse {
  access_token: string;
  role: Role;
  csrf_token?: string;
}

export async function unifiedLogin(email: string, password: string): Promise<UnifiedLoginResult> {
  const res = await fetch(`${getAPI()}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",  // S2.4 — accept Set-Cookie from the response
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Credenciales inválidas" }));
    throw new Error((err as { detail?: string }).detail ?? "Credenciales inválidas");
  }

  const data = (await res.json()) as UnifiedLoginResponse;

  if (data.role === "admin") {
    setAdminToken(data.access_token);
    if (data.csrf_token) setAdminCsrfToken(data.csrf_token);
    return { role: "admin", redirectTo: "/dashboard" };
  }

  setPortalToken(data.access_token);
  if (data.csrf_token) setPortalCsrfToken(data.csrf_token);
  return { role: "client", redirectTo: "/portal" };
}
