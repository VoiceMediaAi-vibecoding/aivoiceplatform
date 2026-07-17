import type { ReactNode, HTMLAttributes } from "react";

interface GlassCardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  /** Render as an interactive surface (hover glow, pointer cursor). */
  interactive?: boolean;
  className?: string;
}

/**
 * Base "mission control" surface: translucent glass panel with soft border
 * and backdrop blur. Use for cards, panels, modals, and list rows.
 */
export default function GlassCard({
  children,
  interactive = false,
  className = "",
  ...rest
}: GlassCardProps) {
  return (
    <div
      className={`glass-card rounded-2xl ${interactive ? "cursor-pointer" : ""} ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}
