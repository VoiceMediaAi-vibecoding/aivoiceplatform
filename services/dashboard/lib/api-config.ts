/**
 * Shared API base-URL resolution.
 *
 * In production `NEXT_PUBLIC_API_URL` points at the API's own domain
 * (e.g. `https://api.voicemedia.ai`, proxied via Caddy) and always wins.
 *
 * Without it, in the browser we fall back to talking to the API on the same
 * host the dashboard was loaded from on port 8000 — so the platform still
 * works when accessed via `localhost`, a LAN IP, or a tunneled hostname. On
 * the server (SSR/build) we fall back to `localhost:8000`.
 *
 * This was previously duplicated across lib/portal-auth.ts, lib/admin-auth.ts,
 * lib/auth.ts, and lib/api.ts — consolidated here so there's a single place to
 * change the resolution strategy.
 */
export const getApiBaseUrl = (): string => {
  if (process.env.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL;
  }
  if (typeof window !== "undefined") {
    return `http://${window.location.hostname}:8000`;
  }
  return "http://localhost:8000";
};
