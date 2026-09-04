import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * The one place an uncaught render/effect error is caught at all (issue
 * #177). Before this, nothing in `apps/` or `packages/` ever called
 * React's own error-boundary API, so the moment anything threw outside a
 * `try`/`catch` this app already owns — entry-store-layout.tsx's own
 * `describeOpenError` is the one existing example, and it only covers a
 * failed STORE open (issue #159) — React 19 unmounted the ENTIRE tree with
 * it. The bug this ticket fixes (a `task_reference` node with no renderer,
 * thrown from inside a `useEffect` in composer.tsx) is one way to reach
 * that; this boundary is the fix for every OTHER way something can throw
 * that nobody anticipated specifically, not just this one.
 *
 * Wraps `<App>` alone (main.tsx), not everything under
 * `<QueryClientProvider>`: `<SyncLoop>` is a sibling that keeps a Device's
 * Sync running in the background regardless of which route is open
 * (use-sync-loop.ts's own doc comment) — an error inside the routed tree
 * below is no reason to also stop that, and `<Toaster>`/the query client
 * itself have nothing to do with whatever App's own tree just threw.
 *
 * A class component because `componentDidCatch`/`getDerivedStateFromError`
 * are the only React API an error boundary can be built from — no hook
 * does this, by React's own design (a component cannot uninstall the
 * broken subtree it is itself part of once it has already thrown).
 */
interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  override state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Logged in full, matching entry-store-layout.tsx's own
    // `describeOpenError` convention of logging the real error alongside a
    // generic on-screen sentence — the sentence below can't carry a stack
    // trace, but a developer reading the console still needs one.
    console.error("meologue: uncaught render error", error, info.componentStack);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) {
      return this.props.children;
    }
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background px-4 text-center">
        <p className="text-sm text-destructive">meologue hit an unexpected error.</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          {error.message || "Something went wrong and this screen can't recover on its own."}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={this.handleReload}>
          Reload
        </Button>
      </div>
    );
  }
}
