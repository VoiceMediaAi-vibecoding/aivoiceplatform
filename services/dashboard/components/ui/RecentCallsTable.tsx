import GlassCard from "./GlassCard";
import StatusPill from "./StatusPill";

export interface RecentCallRow {
  id: string;
  direction: "inbound" | "outbound";
  number: string | null;
  status: string;
  durationSeconds: number | null;
  startedAt: string | null;
}

interface RecentCallsTableProps {
  title: string;
  description?: string;
  rows: RecentCallRow[];
  emptyLabel?: string;
}

const STATUS_TONE: Record<string, "neutral" | "active" | "warning" | "danger" | "info"> = {
  initiated: "info",
  ringing: "info",
  in_progress: "active",
  completed: "neutral",
  answered: "active",
  voicemail: "warning",
  no_answer: "warning",
  failed: "danger",
};

function formatDuration(seconds: number | null): string {
  if (!seconds) return "—";
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatTimestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" }) : "—";
}

/**
 * Compact "recent activity" table — glassmorphism rows with status badges,
 * mirroring the Stitch admin-dashboard concept's recent-calls list. Shared by
 * the admin overview and (eventually) any client-facing activity summaries.
 */
export default function RecentCallsTable({ title, description, rows, emptyLabel = "Sin registros aún" }: RecentCallsTableProps) {
  return (
    <GlassCard className="overflow-hidden">
      <div className="p-5 pb-3">
        <h2 className="text-sm font-semibold text-gray-200">{title}</h2>
        {description && <p className="text-xs text-gray-500 mt-0.5">{description}</p>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-white/[0.03] text-xs text-gray-400 uppercase">
            <tr>
              <th className="px-5 py-2 text-left">Tipo</th>
              <th className="px-5 py-2 text-left">Número</th>
              <th className="px-5 py-2 text-left">Estado</th>
              <th className="px-5 py-2 text-left">Duración</th>
              <th className="px-5 py-2 text-left">Fecha</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {rows.map((row) => (
              <tr key={row.id} className="hover:bg-white/[0.03] transition-colors">
                <td className="px-5 py-2.5">
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${
                      row.direction === "inbound"
                        ? "bg-brand-blue/10 text-blue-300"
                        : "bg-brand-purple/10 text-fuchsia-300"
                    }`}
                  >
                    {row.direction === "inbound" ? "📲 Entrante" : "📤 Saliente"}
                  </span>
                </td>
                <td className="px-5 py-2.5 font-mono text-xs text-gray-300">{row.number ?? "—"}</td>
                <td className="px-5 py-2.5">
                  <StatusPill label={row.status} tone={STATUS_TONE[row.status] ?? "neutral"} />
                </td>
                <td className="px-5 py-2.5 text-xs text-gray-400 font-mono">{formatDuration(row.durationSeconds)}</td>
                <td className="px-5 py-2.5 text-xs text-gray-400">{formatTimestamp(row.startedAt)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-gray-500 text-sm">
                  {emptyLabel}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </GlassCard>
  );
}
