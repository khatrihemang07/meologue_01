import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { DictationSetupButton } from "./dictation-setup-button";

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname + location.hash}</div>;
}

describe("DictationSetupButton", () => {
  it("is a Set up dictation button that opens Settings at the gateway URL field", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="*" element={<Where />} />
        </Routes>
        <DictationSetupButton />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Set up dictation" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/settings#dictation-url");
  });
});
