type StatusTone = "neutral" | "active" | "warning" | "danger" | "info";

interface StatusPillProps {
  label: string;
  tone?: StatusTone;
  /** Show a small pulsing dot before the label (mission-control "live" indicator). */
  pulse?: boolean;
}

const TONE_STYLES: Record<StatusTone, { pill: string; dot: string }> = {
  neutral: { pill: "bg-white/5 text-gray-300 border-white/10", dot: "bg-gray-400" },
  active: { pill: "bg-emerald-400/10 text-emerald-300 border-emerald-400/20", dot: "bg-emerald-400" },
  warning: { pill: "bg-amber-400/10 text-amber-300 border-amber-400/20", dot: "bg-amber-400" },
  danger: { pill: "bg-rose-400/10 text-rose-300 border-rose-400/20", dot: "bg-rose-400" },
  info: { pill: "bg-brand-blue/10 text-violet-300 border-brand-blue/20", dot: "bg-brand-blue" },
};

/**
 * Small status badge with an optional pulsing "live" dot — the mission-control
 * equivalent of a telemetry indicator light.
 */
export default function StatusPill({ label, tone = "neutral", pulse = false }: StatusPillProps) {
  const styles = TONE_STYLES[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border ${styles.pill}`}
    >
      {pulse ? (
        <span className={`status-dot ${styles.dot}`} />
      ) : (
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${styles.dot}`} />
      )}
      {label}
    </span>
  );
}
