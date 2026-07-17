"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { isLoggedIn } from "@/lib/portal-auth";

export default function PortalRoot() {
  const router = useRouter();
  useEffect(() => {
    if (isLoggedIn()) {
      router.replace("/portal/campaigns");
    } else {
      router.replace("/login");
    }
  }, [router]);
  return null;
}
