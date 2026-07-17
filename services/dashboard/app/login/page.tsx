"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Loader2, Mail, Lock, ArrowRight } from "lucide-react";
import { unifiedLogin } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function UnifiedLoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const { redirectTo } = await unifiedLogin(email, password);
      router.push(redirectTo);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Error al iniciar sesión");
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
            Accede con tu cuenta — te llevaremos al panel correcto según tu rol
          </p>
        </div>

        {/* Form card */}
        <div className="glass-card rounded-2xl p-8 space-y-5">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-gray-300 text-sm">
                Correo electrónico
              </Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  placeholder="tu@empresa.com"
                  className="pl-10 bg-white/5 border-white/10 text-white placeholder:text-gray-600 focus-visible:border-brand-pink/60 focus-visible:ring-0"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="password" className="text-gray-300 text-sm">
                Contraseña
              </Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  placeholder="••••••••"
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
              disabled={loading}
              className="w-full bg-brand-pink hover:bg-brand-purple text-white font-medium transition-colors gap-2"
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  Entrar <ArrowRight className="w-4 h-4" />
                </>
              )}
            </Button>
          </form>
        </div>

        <p className="text-center text-xs text-gray-600">
          voicemedia.ai · Plataforma de agentes de voz IA
        </p>
      </div>
    </div>
  );
}
