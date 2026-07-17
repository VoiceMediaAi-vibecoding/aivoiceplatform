"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { isLoggedIn, fetchMe } from "@/lib/admin-auth";

interface AdminAuthGuardProps {
  children: React.ReactNode;
}

/**
 * Wrap admin-only pages with this guard. Redirects to /login when
 * there's no valid admin session, and renders nothing while checking to
 * avoid flashing gated content.
 */
export default function AdminAuthGuard({ children }: AdminAuthGuardProps) {
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
        await fetchMe();
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
