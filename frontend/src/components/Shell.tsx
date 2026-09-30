import { Outlet } from "react-router-dom";
import { FeatureSubNav, MockDataNotice, PrimaryNavbar } from "@/components/layout";
import { ToastProvider } from "@/components/toast";
import { WorkspaceProvider } from "@/components/workspace";
import { ConversationProvider } from "@/components/ask/conversation";
import { ScopeProvider } from "@/components/filters";

/** AuthenticatedLayout: top bar, feature tabs, then the page. Rendered only when signed in. */
export function Shell() {
  return (
    <ToastProvider>
      <WorkspaceProvider>
        {/* Inside the workspace provider's key, so each workspace has its own
            conversation and its own choice of which indexed site to look at. */}
        <ScopeProvider>
          <ConversationProvider>
            <div className="flex min-h-screen flex-col">
              <header className="sticky top-0 z-30">
                <PrimaryNavbar />
                <FeatureSubNav />
              </header>
              <MockDataNotice />
              <main className="min-w-0 flex-1">
                <Outlet />
              </main>
            </div>
          </ConversationProvider>
        </ScopeProvider>
      </WorkspaceProvider>
    </ToastProvider>
  );
}
