import { describe, expect, it } from "vitest";
import { httpsOriginHint } from "./https-origin-hint";

/** A partial Location, cast to the real type — this is a pure function so no global touching. */
function fakeLocation(fields: Partial<Location>): Location {
  return fields as Location;
}

describe("httpsOriginHint", () => {
  it("drops the port when hinting a Tailscale hostname over plain HTTP — the whole bug this helper exists for", () => {
    const location = fakeLocation({
      protocol: "http:",
      hostname: "hemangs-macbook-air-1.tail28560e.ts.net",
      port: "41207",
    });

    const hint = httpsOriginHint(location);

    expect(hint).toBe("https://hemangs-macbook-air-1.tail28560e.ts.net/");
    expect(hint).not.toContain(":41207");
  });

  it("stays silent for a bare LAN host, where no HTTPS origin can be promised", () => {
    const location = fakeLocation({ protocol: "http:", hostname: "192.168.1.5", port: "" });

    expect(httpsOriginHint(location)).toBeUndefined();
  });

  it("stays silent for localhost, which never needed HTTPS to begin with", () => {
    const location = fakeLocation({ protocol: "http:", hostname: "localhost", port: "5173" });

    expect(httpsOriginHint(location)).toBeUndefined();
  });

  it("stays silent once already on HTTPS on a .ts.net host — nothing to suggest, you're already there", () => {
    const location = fakeLocation({
      protocol: "https:",
      hostname: "hemangs-macbook-air-1.tail28560e.ts.net",
      port: "",
    });

    expect(httpsOriginHint(location)).toBeUndefined();
  });
});
