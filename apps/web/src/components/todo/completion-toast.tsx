/**
 * CMT-04 (parity ledger) — the body of the Task-completion Undo toast
 * (`raiseCompletionToast`, todo-page.tsx), rendered through `toast.custom()`
 * rather than the plain `toast(message, {...})` every other toast in this
 * app uses (task-detail-view.tsx's DET-16 toast, register-service-worker,
 * sync-section.tsx).
 *
 * Why a separate render path: sonner 2.0.8 exposes no `role`/`aria-live`
 * field on any option type — `ToastT`, `ExternalToast`, `ToastOptions` and
 * `ToasterProps` (node_modules/sonner/dist/index.d.ts) carry none — and its
 * `Toast` component (index.mjs) returns a hardcoded `<li data-sonner-toast>`
 * with no prop spread, so there is no way to put `role="alert"` on sonner's
 * own element. `toast.custom(jsx, data)` is sonner's documented escape
 * hatch (`this.custom = (jsx, data) => this.create({...data, jsx: jsx(id),
 * id, type: undefined})`, index.mjs ~line 410): it still renders inside
 * that same `<li>` — same mount/remove classes, swipe handlers
 * (`onPointerDown`/`onPointerMove`/`onPointerUp`, gated on `dismissible`,
 * not on `jsx`), and auto-close timer (`toast.duration`/`onAutoClose`) —
 * just with our JSX nested inside sonner's own `data-content`/`data-title`
 * wrapper divs instead of sonner's plain title text. That JSX's own root
 * can carry `role="alert"`/`aria-live="polite"`, which is exactly what
 * Todoist's own toast carries (`live-audit-dom/flow5-CMT-04-todoist.json`).
 *
 * Styling: sonner renders every `jsx` toast with `data-styled="false"`
 * (`!Boolean(toast.jsx || ...)` on its `<li>`), so none of its
 * `[data-sonner-toast][data-styled=true]` look applies. **Do not borrow the
 * attributes to get it back.** A first version put `data-sonner-toast` on this
 * root, which also pulls in sonner's positioning rules for that attribute:
 * `position:absolute; opacity:0; transform:translateY(100%)`, lifted only by
 * `data-mounted="true"`, which sonner sets on its own `<li>` and never on this
 * element. The toast would have painted invisible, and jsdom cannot show it.
 * The values below are sonner 2.0.8's own styled-toast, `[data-title]`,
 * `[data-content]` and `[data-button]` rules, copied from its injected
 * stylesheet. The colours read the Toaster's `--normal-*` vars
 * (components/ui/sonner.tsx), so the theme still applies. Re-copy them if
 * sonner is upgraded.
 */
export function CompletionToastBody({ message, onUndo }: { message: string; onUndo: () => void }) {
  return (
    <div
      role="alert"
      aria-live="polite"
      style={{
        padding: 16,
        background: "var(--normal-bg)",
        border: "1px solid var(--normal-border)",
        color: "var(--normal-text)",
        borderRadius: "var(--border-radius)",
        boxShadow: "0 4px 12px rgba(0,0,0,.1)",
        width: "var(--width)",
        maxWidth: "100%",
        fontSize: 13,
        display: "flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 500, lineHeight: 1.5, color: "inherit" }}>{message}</div>
      </div>
      <button
        type="button"
        onClick={onUndo}
        style={{
          borderRadius: 4,
          paddingLeft: 8,
          paddingRight: 8,
          height: 24,
          fontSize: 12,
          color: "var(--normal-bg)",
          background: "var(--normal-text)",
          marginLeft: "var(--toast-button-margin-start)",
          marginRight: "var(--toast-button-margin-end)",
          border: "none",
          fontWeight: 500,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
        }}
      >
        Undo
      </button>
    </div>
  );
}
