import type { ReactNode } from "react";
import AppSidebar from "./AppSidebar";
import AppTopbar from "./AppTopbar";

interface AppShellProps {
  title: string;
  description?: string;
  children: ReactNode;
}

/**
 * Shared "mission control" page shell: persistent sidebar nav + sticky topbar
 * wrapping the page content area. Wrap any authenticated/internal page with
 * this to inherit the redesigned look consistently.
 *
 * Usage:
 *   <AppShell title="Campañas" description="Marcador masivo">
 *     ...page content...
 *   </AppShell>
 */
export default function AppShell({ title, description, children }: AppShellProps) {
  return (
    <div className="min-h-screen flex text-white">
      <AppSidebar />
      <div className="flex-1 min-w-0 flex flex-col">
        <AppTopbar title={title} description={description} />
        <main className="flex-1 p-6">
          <div className="max-w-7xl mx-auto animate-fade-in-up">{children}</div>
        </main>
      </div>
    </div>
  );
}
