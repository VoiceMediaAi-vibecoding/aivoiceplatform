"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { isLoggedIn as isAdmin } from "@/lib/admin-auth";
import { isLoggedIn as isClient } from "@/lib/portal-auth";

/**
 * Smart landing route — sends every visitor straight to the section their
 * role grants them, from a single entry point ("1 login para todos"):
 *   - Admin session present  → /dashboard (AdminAuthGuard re-verifies the token)
 *   - Client session present → /portal (verifies its own session)
 *   - No session             → /login (resolves role and routes accordingly)
 *
 * This replaces the old static "Centro de control" landing page, which only
 * duplicated what /dashboard already shows.
 */
export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    if (isAdmin()) {
      router.replace("/dashboard");
    } else if (isClient()) {
      router.replace("/portal");
    } else {
      router.replace("/login");
    }
  }, [router]);

  return null;
}
