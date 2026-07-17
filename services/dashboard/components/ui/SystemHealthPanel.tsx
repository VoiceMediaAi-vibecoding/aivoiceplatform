import GlassCard from "./GlassCard";
import StatusPill from "./StatusPill";

export interface HealthRow {
  label: string;
  detail: string;
  tone: "active" | "warning" | "danger" | "neutral";
  status: string;
}

interface SystemHealthPanelProps {
  rows: HealthRow[];
}

/**
 * Admin "system health" side panel — a glanceable readout of the providers
 * and infrastructure the voice agents depend on (LiveKit, STT/LLM/TTS, API).
 * Mirrors the side-panel pattern from the Stitch admin dashboard concept:
 * a stack of status rows with a live pill per dependency.
 */
export default function SystemHealthPanel({ rows }: SystemHealthPanelProps) {
  return (
    <GlassCard className="p-5">
      <h2 className="text-sm font-semibold text-gray-200 mb-1">Salud del sistema</h2>
      <p className="text-xs text-gray-500 mb-4">Estado de la infraestructura y proveedores</p>
      <ul className="flex flex-col gap-3">
        {rows.map((row) => (
          <li
            key={row.label}
            className="flex items-center justify-between gap-3 rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2.5"
          >
            <div className="min-w-0">
              <p className="text-sm text-gray-200 truncate">{row.label}</p>
              <p className="text-xs text-gray-500 truncate">{row.detail}</p>
            </div>
            <StatusPill label={row.status} tone={row.tone} pulse={row.tone === "active"} />
          </li>
        ))}
      </ul>
    </GlassCard>
  );
}
