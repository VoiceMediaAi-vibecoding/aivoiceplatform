import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Allow the dev server to serve over the production hostname and the
  // EC2 metadata IP. The dev server should never run in production (see
  // S1.4 — production uses the standalone build) but this lets local devs
  // test against `dashboard.voicemedia.ai` without TLS warnings.
  allowedDevOrigins: ["44.247.225.191", "dashboard.voicemedia.ai"],
  // Keep productionBrowserSourceMaps OFF — Next.js only ships maps to the
  // browser when explicitly enabled, and the audit flagged leaked source
  // maps as a CRITICAL issue when dev mode was running in prod.
  productionBrowserSourceMaps: false,

  // S1.5 — Security headers applied to every response. CSP is in
  // "moderate" mode (allows `unsafe-inline` and `unsafe-eval`) so we
  // don't break Next.js runtime, the ElevenLabs preview widget, or
  // LiveKit's WebRTC client. Tighten further if XSS sinks are
  // confirmed eliminated.
  async headers() {
    const csp = [
      "default-src 'self'",
      // Next.js dev overlay + Tailwind inline styles need unsafe-inline.
      // unsafe-eval is required by some LiveKit deps.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.livekit.cloud",
      "style-src 'self' 'unsafe-inline'",
      // Images: self, data URLs (favicons, blob from recordings), and HTTPS
      // for voice preview CDNs.
      "img-src 'self' data: blob: https:",
      // Media: blob for the in-memory recording playback.
      "media-src 'self' blob:",
      // XHR/fetch destinations: same origin + the API + LiveKit + Twilio.
      "connect-src 'self' https://api.voicemedia.ai wss://*.livekit.cloud wss://livekit.voicemedia.ai https://*.twilio.com",
      // Frame ancestors: deny all (anti-clickjacking).
      "frame-ancestors 'none'",
      // Forms submit only to ourselves.
      "form-action 'self'",
      // Block mixed content and dubious object embeds.
      "object-src 'none'",
      "base-uri 'self'",
    ].join("; ");

    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
          // HSTS only meaningful over HTTPS — Caddy already terminates TLS,
          // and we want HSTS to stick for 2 years. Browsers ignore over http.
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        ],
      },
    ];
  },
};

export default nextConfig;
