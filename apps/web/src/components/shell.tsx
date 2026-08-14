import type { ReactNode } from "react";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface ShellProps {
  title: ReactNode;
  /** Trailing affordance in the card header — e.g. the gear link to Settings. */
  action?: ReactNode;
  message?: string;
  children: ReactNode;
  /** Rendered below the card, outside it — e.g. the Composer page's History. */
  footer?: ReactNode;
}

// The centred, max-w-xl card layout every page shares (ticket 25 pulled this
// out of App.tsx once a second page — Settings — needed it too).
export function Shell({ title, action, message, children, footer }: ShellProps) {
  return (
    <div className="flex min-h-svh justify-center bg-background px-4 py-12">
      <div className="flex w-full max-w-xl flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>{title}</CardTitle>
            {action && <CardAction>{action}</CardAction>}
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {message && <p className="text-sm text-destructive">{message}</p>}
            {children}
          </CardContent>
        </Card>

        {footer}
      </div>
    </div>
  );
}
