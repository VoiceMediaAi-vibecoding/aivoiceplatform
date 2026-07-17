"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Legacy admin login route — kept so old bookmarks/links keep working.
 * The platform now has a single unified login at /login that detects the
 * account's role (admin vs client) and redirects accordingly.
 */
export default function AdminLoginRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/login");
  }, [router]);
  return null;
}
