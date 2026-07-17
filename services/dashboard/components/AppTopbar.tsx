"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Clock, Wifi, LogOut, ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface AppTopbarProps {
  title: string;
  description?: string;
}

export default function AppTopbar({ title, description }: AppTopbarProps) {
  const [now, setNow] = useState<Date | null>(null);
  const router = useRouter();

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const handleLogout = () => {
    if (typeof window !== "undefined") {
      localStorage.removeItem("admin_token");
      localStorage.removeItem("portal_token");
    }
    router.push("/login");
  };

  return (
    <header className="sticky top-0 z-30 glass-panel border-b border-white/5 px-6 py-3.5 flex items-center justify-between gap-4 backdrop-blur-xl">
      <div>
        <h1 className="text-lg font-semibold text-white tracking-tight leading-tight">{title}</h1>
        {description && <p className="text-xs text-gray-500 mt-0.5">{description}</p>}
      </div>

      <div className="flex items-center gap-2.5">
        {/* System status */}
        <Badge
          variant="outline"
          className="gap-1.5 border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/10 text-xs"
        >
          <Wifi className="w-3 h-3" />
          En línea
        </Badge>

        {/* Clock */}
        <div className="hidden sm:flex items-center gap-1.5 text-xs font-mono text-gray-500 px-2.5 py-1.5 rounded-lg border border-white/10 bg-white/[0.02]">
          <Clock className="w-3 h-3" />
          {now ? now.toLocaleTimeString("es-MX", { hour12: false }) : "--:--:--"}
        </div>

        {/* User menu */}
        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.06] transition-colors text-xs text-gray-400 hover:text-white">
            Admin
            <ChevronDown className="w-3 h-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="bg-[#1a1a1a] border-white/10 text-gray-200 min-w-[140px]">
            <DropdownMenuSeparator className="bg-white/10" />
            <DropdownMenuItem
              onClick={handleLogout}
              className="gap-2 text-rose-400 focus:text-rose-300 focus:bg-rose-500/10 cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              Cerrar sesión
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
