"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Loader2, Lock, CheckCircle2, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

interface SupabaseAuthError {
  msg?: string;
  message?: string;
  error_description?: string;
}

/**
 * Landing page for Supabase invite / recovery links.
 *
 * Supabase Auth sends users here (via `redirect_to` on
 * `invite_user_by_email` / `reset_password_for_email`) with the session
 * tokens in the URL hash, e.g.
 * `#access_token=...&refresh_token=...&type=invite`.
 *
 * This page reads the `access_token` from the hash and uses it to call the
 * Supabase Auth REST API directly (`PUT /auth/v1/user`) to set the user's
 * password — no `supabase-js` client needed, consistent with the rest of
 * the dashboard which talks to Supabase only through the FastAPI backend.
 */
export default function SetPasswordPage() {
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);
  const router = useRouter();

  useEffect(() => {
    const rawHash = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash;
    const params = new URLSearchParams(rawHash);
    const token = params.get("access_token");
    const errorDescription = params.get("error_description");

    if (errorDescription) {
      setError(decodeURIComponent(errorDescription.replace(/\+/g, " ")));
    } else if (token) {
      setAccessToken(token);
    } else {
      setError("Este enlace no es válido o ya expiró. Solicita una nueva invitación.");
    }
    setChecking(false);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("La contraseña debe tener al menos 8 caracteres");
      return;
    }
    if (password !== confirmPassword) {
      setError("Las contraseñas no coinciden");
      return;
    }
    if (!accessToken) {
      setError("Este enlace no es válido o ya expiró. Solicita una nueva invitación.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ password }),
      });

      if (!res.ok) {
        const err: SupabaseAuthError = await res
          .json()
          .catch(() => ({ msg: "No se pudo establecer la contraseña" }));
        throw new Error(err.msg ?? err.error_description ?? err.message ?? "No se pudo establecer la contraseña");
      }

      setSuccess(true);
      setTimeout(() => router.push("/login"), 2500);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "No se pudo establecer la contraseña");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-8">
        {/* Logo + branding */}
        <div className="flex flex-col items-center gap-4">
          <Image
            src="/logo.png"
            alt="voicemedia.ai"
            width={200}
            height={52}
            className="object-contain"
            priority
          />
          <p className="text-sm text-gray-400 text-center">
            Crea tu contraseña para activar tu cuenta
          </p>
        </div>

        {/* Form card */}
        <div className="glass-card rounded-2xl p-8 space-y-5">
          {checking ? (
            <div className="flex justify-center py-4">
              <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
            </div>
          ) : success ? (
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <CheckCircle2 className="w-10 h-10 text-emerald-400" />
              <p className="text-sm text-gray-300">
                ¡Contraseña creada! Te llevaremos al inicio de sesión...
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="space-y-1.5">
                <Label htmlFor="password" className="text-gray-300 text-sm">
                  Nueva contraseña
                </Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                    autoComplete="new-password"
                    placeholder="••••••••"
                    disabled={!accessToken}
                    className="pl-10 bg-white/5 border-white/10 text-white placeholder:text-gray-600 focus-visible:border-brand-pink/60 focus-visible:ring-0"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="confirmPassword" className="text-gray-300 text-sm">
                  Confirmar contraseña
                </Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
                  <Input
                    id="confirmPassword"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    minLength={8}
                    autoComplete="new-password"
                    placeholder="••••••••"
                    disabled={!accessToken}
                    className="pl-10 bg-white/5 border-white/10 text-white placeholder:text-gray-600 focus-visible:border-brand-pink/60 focus-visible:ring-0"
                  />
                </div>
              </div>

              {error && (
                <Alert variant="destructive" className="border-rose-400/30 bg-rose-500/10 text-rose-300">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <Button
                type="submit"
                disabled={loading || !accessToken}
                className="w-full bg-brand-pink hover:bg-brand-purple text-white font-medium transition-colors gap-2"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    Crear contraseña <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </Button>
            </form>
          )}
        </div>

        <p className="text-center text-xs text-gray-600">
          voicemedia.ai · Plataforma de agentes de voz IA
        </p>
      </div>
    </div>
  );
}
