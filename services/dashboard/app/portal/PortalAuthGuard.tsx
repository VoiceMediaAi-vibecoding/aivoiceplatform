"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { isLoggedIn, fetchMe as fetchPortalMe } from "@/lib/portal-auth";

interface PortalAuthGuardProps {
  children: React.ReactNode;
}

/**
 * Wrap client-portal pages with this guard. Redirects to /login when
 * there's no valid portal session, and renders nothing while checking to
 * avoid flashing gated content.
 *
 * S2.3 — this used to be an inline `useEffect(() => redirect if not logged in)`
 * check on each portal page. That had two issues:
 *   1. The page rendered FIRST, then redirected in useEffect — leaking the
 *      page chrome briefly even for unauthenticated users.
 *   2. The 401 handler inside individual fetches was a brittle string match
 *      on error.message — a localized message that didn't include "401" would
 *      silently leave the user in a broken half-authenticated state.
 * Centralizing the check here fixes both.
 */
export default function PortalAuthGuard({ children }: PortalAuthGuardProps) {
  const router = useRouter();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const verify = async () => {
      if (!isLoggedIn()) {
        router.replace("/login");
        return;
      }
      try {
        await fetchPortalMe();
        if (!cancelled) setChecked(true);
      } catch {
        if (!cancelled) router.replace("/login");
      }
    };

    verify();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (!checked) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-500 text-sm">Verificando sesión…</p>
      </div>
    );
  }

  return <>{children}</>;
}
