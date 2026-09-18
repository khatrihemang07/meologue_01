/**
 * Issue #352's redirect, tested the way it actually failed.
 *
 * `/todo` resolves to whichever view Todo was last on. The first cut wrote
 * that as `<Route path="/todo" element={<Navigate to={lastTodoPath()} />} />`
 * — and a browser found what 3,992 passing unit tests did not: the `element`
 * prop's JSX is built once, when `App` renders, and `App` sits above
 * `Routes` and never re-renders on navigation. The redirect target was
 * therefore frozen at whatever was remembered when the tab first loaded. It
 * worked perfectly across a full page reload, and never once within a live
 * session — which is the only case the feature exists for.
 *
 * So the test that matters is not "does `/todo` redirect to the remembered
 * view" (the frozen version passes that on a fresh mount). It is "does it
 * still do so on a SECOND visit, within one mount, after the remembered
 * view changed." That is what the first two cases below assert, and an
 * inline `lastTodoPath()` call fails them.
 *
 * This file renders a miniature route table of the same SHAPE as
 * `App.tsx`'s — a redirect route plus its targets, under one router that is
 * never remounted — rather than importing `App`, which would drag in the
 * entry store, sync and every lazy page chunk to answer a question about
 * one route's evaluation timing. The stubs record their own view on mount,
 * which is what `todo-page.tsx` does once `backgroundView` resolves.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { Link, MemoryRouter, Navigate, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { type LastTodoView, lastTodoPath, writeLastTodoView } from "@/lib/last-todo-view";

/** The shipped shape: read at match time, inside a component. */
function TodoEntryRedirect() {
  return <Navigate to={lastTodoPath()} replace />;
}

function TodoViewStub({ view }: { view: LastTodoView }) {
  const name = view.view;
  useEffect(() => {
    writeLastTodoView(view);
  }, [view]);
  return (
    <div>
      <p>view: {name}</p>
      <Link to="/todo/today">go to today</Link>
      <Link to="/todo/upcoming">go to upcoming</Link>
      <Link to="/elsewhere">leave Todo</Link>
    </div>
  );
}

const INBOX: LastTodoView = { view: "inbox" };
const TODAY: LastTodoView = { view: "today" };
const UPCOMING: LastTodoView = { view: "upcoming" };

function Harness({ redirect }: { redirect: React.ReactNode }) {
  return (
    <MemoryRouter initialEntries={["/todo"]}>
      <Routes>
        <Route path="/todo" element={redirect} />
        <Route path="/todo/inbox" element={<TodoViewStub view={INBOX} />} />
        <Route path="/todo/today" element={<TodoViewStub view={TODAY} />} />
        <Route path="/todo/upcoming" element={<TodoViewStub view={UPCOMING} />} />
        <Route path="/elsewhere" element={<Link to="/todo">back to Todo</Link>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe("/todo's redirect target is read when the route matches", () => {
  it("follows the remembered view on a second visit within one mount", async () => {
    render(<Harness redirect={<TodoEntryRedirect />} />);

    // First arrival: nothing remembered yet, so Inbox — the documented fallback.
    expect(await screen.findByText("view: inbox")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "go to today" }));
    await screen.findByText("view: today");
    fireEvent.click(screen.getByRole("link", { name: "leave Todo" }));
    fireEvent.click(await screen.findByRole("link", { name: "back to Todo" }));

    // No reload happened. The frozen version fails here, still showing Inbox.
    expect(await screen.findByText("view: today")).toBeInTheDocument();
  });

  it("keeps following it as the remembered view changes again", async () => {
    render(<Harness redirect={<TodoEntryRedirect />} />);

    await screen.findByText("view: inbox");
    fireEvent.click(screen.getByRole("link", { name: "go to today" }));
    await screen.findByText("view: today");
    fireEvent.click(screen.getByRole("link", { name: "leave Todo" }));
    fireEvent.click(await screen.findByRole("link", { name: "back to Todo" }));
    await screen.findByText("view: today");

    fireEvent.click(screen.getByRole("link", { name: "go to upcoming" }));
    await screen.findByText("view: upcoming");
    fireEvent.click(screen.getByRole("link", { name: "leave Todo" }));
    fireEvent.click(await screen.findByRole("link", { name: "back to Todo" }));

    expect(await screen.findByText("view: upcoming")).toBeInTheDocument();
  });

  it("an inline lastTodoPath() call freezes the target — the defect this guards", async () => {
    // Exactly the shipped-then-reverted shape: the call happens here, once,
    // as this JSX is constructed, not when `/todo` matches.
    render(<Harness redirect={<Navigate to={lastTodoPath()} replace />} />);

    await screen.findByText("view: inbox");
    fireEvent.click(screen.getByRole("link", { name: "go to today" }));
    await screen.findByText("view: today");
    fireEvent.click(screen.getByRole("link", { name: "leave Todo" }));
    fireEvent.click(await screen.findByRole("link", { name: "back to Todo" }));

    // Documents the bug rather than the fix: still Inbox, because `to` was
    // frozen at mount. If this ever starts failing, the inline form has
    // stopped being broken and the wrapper above may no longer be needed.
    expect(await screen.findByText("view: inbox")).toBeInTheDocument();
  });
});
