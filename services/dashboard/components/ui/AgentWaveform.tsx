interface AgentWaveformProps {
  /** Number of animated bars to render. */
  barCount?: number;
  /** Visual size — `sm` for compact inline use, `lg` for hero sections. */
  size?: "sm" | "lg";
  className?: string;
}

const BAR_HEIGHTS = [0.4, 0.7, 1, 0.55, 0.85, 0.35, 0.95, 0.6, 0.75, 0.45, 0.9, 0.5];

/**
 * Glowing brand-gradient "voice waveform" visual — a CSS-only stand-in for a
 * live audio visualizer. Used on the client portal hero ("Agent is Live") and
 * anywhere we want to signal an active voice agent without wiring up a real
 * `BarVisualizer` (see `app/agent/page.tsx` for the LiveKit-backed version).
 */
export default function AgentWaveform({ barCount = 12, size = "lg", className = "" }: AgentWaveformProps) {
  const bars = Array.from({ length: barCount }, (_, i) => BAR_HEIGHTS[i % BAR_HEIGHTS.length]);
  const dims = size === "lg" ? { wrapper: "h-24 gap-1.5", bar: "w-2" } : { wrapper: "h-10 gap-1", bar: "w-1" };

  return (
    <div
      className={`relative flex items-center justify-center ${dims.wrapper} ${className}`}
      role="img"
      aria-label="Visualizador de voz del agente activo"
    >
      <div className="absolute inset-0 -z-10 rounded-full bg-gradient-to-r from-brand-pink/25 via-brand-purple/20 to-brand-blue/25 blur-2xl animate-blob" />
      {bars.map((h, i) => (
        <span
          key={i}
          className={`${dims.bar} rounded-full bg-gradient-to-b from-brand-pink via-brand-purple to-brand-blue animated`}
          style={{
            height: `${Math.round(h * 100)}%`,
            animation: `agent-waveform 1.4s ease-in-out ${(i * 0.09).toFixed(2)}s infinite`,
          }}
        />
      ))}
    </div>
  );
}
