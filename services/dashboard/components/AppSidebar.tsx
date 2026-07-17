"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard, Phone, Megaphone, Activity, Mic,
  Users, Bot, Settings, MonitorSmartphone, Network, UserCog, Wrench, PhoneCall, LucideIcon,
} from "lucide-react";
import { NAV_GROUPS, NAV_ITEMS } from "./nav-config";
import { cn } from "@/lib/utils";

const ICON_MAP: Record<string, LucideIcon> = {
  LayoutDashboard,
  Phone,
  Megaphone,
  Activity,
  Mic,
  Users,
  Bot,
  Settings,
  MonitorSmartphone,
  Network,
  UserCog,
  Wrench,
  PhoneCall,
};

export default function AppSidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden lg:flex lg:flex-col w-64 shrink-0 h-screen sticky top-0 glass-panel border-r border-white/5 px-4 py-6 overflow-y-auto">
      {/* Logo */}
      <Link href="/" className="flex flex-col gap-1 px-2 mb-8">
        <Image
          src="/logo.png"
          alt="voicemedia.ai"
          width={160}
          height={42}
          className="object-contain object-left"
          priority
        />
      </Link>

      <nav className="flex-1 flex flex-col gap-6">
        {NAV_GROUPS.map((group) => {
          const items = NAV_ITEMS.filter((item) => item.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group}>
              <p className="px-2 mb-2 text-[10px] uppercase tracking-widest text-gray-500">{group}</p>
              <div className="flex flex-col gap-0.5">
                {items.map((item) => {
                  const active = pathname === item.href || pathname?.startsWith(`${item.href}/`);
                  const Icon = ICON_MAP[item.icon];
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        "group flex items-center gap-3 px-2.5 py-2 rounded-lg text-sm transition-colors border",
                        active
                          ? "bg-brand-pink/10 text-white border-brand-pink/20"
                          : "text-gray-400 hover:text-white hover:bg-white/[0.04] border-transparent"
                      )}
                    >
                      {Icon && (
                        <Icon
                          className={cn(
                            "w-4 h-4 shrink-0 transition-colors",
                            active ? "text-brand-pink" : "text-gray-600 group-hover:text-gray-400"
                          )}
                        />
                      )}
                      <span className="truncate">{item.label}</span>
                      {active && <span className="ml-auto status-dot bg-brand-pink shrink-0" />}
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>

      <div className="px-2 pt-4 mt-2 border-t border-white/5 space-y-0.5">
        <p className="text-[10px] text-gray-600 uppercase tracking-widest">Self-hosted · LiveKit</p>
        <p className="text-xs text-gray-500">44.247.225.191</p>
      </div>
    </aside>
  );
}
