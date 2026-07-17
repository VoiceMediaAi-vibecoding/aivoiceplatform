import type { ReactNode } from "react";
import GlassCard from "./GlassCard";

interface StatTileProps {
  label: string;
  value: string;
  sub?: string;
  /** Optional accent gradient applied to the value text (e.g. "from-brand-pink to-brand-blue"). */
  accent?: string;
  icon?: ReactNode;
}

/**
 * Telemetry-style stat readout card. Used for top-line KPIs across dashboard
 * pages (cost totals, call counts, active campaigns, etc.).
 */
export default function StatTile({ label, value, sub, accent, icon }: StatTileProps) {
  return (
    <GlassCard className="p-5">
      <div className="flex items-start justify-between">
        <p className="text-xs uppercase tracking-wider text-gray-400">{label}</p>
        {icon && <span className="text-gray-500">{icon}</span>}
      </div>
      <p
        className={`text-2xl font-semibold mt-2 font-mono tracking-tight ${
          accent ? `bg-gradient-to-r ${accent} bg-clip-text text-transparent` : "text-white"
        }`}
      >
        {value}
      </p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </GlassCard>
  );
}
