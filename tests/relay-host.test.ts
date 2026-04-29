import { describe, expect, test } from "bun:test";
import { isRelayTlsDomainAllowed, slugFromRelayHostname } from "../src/relay-host";

describe("relay host helpers", () => {
  test("extracts one-label slugs from relay subdomains", () => {
    expect(slugFromRelayHostname("toolittlecakes.codex-dispatcher.app", "codex-dispatcher.app")).toBe("toolittlecakes");
    expect(slugFromRelayHostname("ToolittleCakes.Codex-Dispatcher.App.", "codex-dispatcher.app")).toBe("toolittlecakes");
  });

  test("rejects root, nested, and invalid relay hostnames", () => {
    expect(slugFromRelayHostname("codex-dispatcher.app", "codex-dispatcher.app")).toBeNull();
    expect(slugFromRelayHostname("a.b.codex-dispatcher.app", "codex-dispatcher.app")).toBeNull();
    expect(slugFromRelayHostname("-bad.codex-dispatcher.app", "codex-dispatcher.app")).toBeNull();
    expect(slugFromRelayHostname("example.com", "codex-dispatcher.app")).toBeNull();
  });

  test("allows tls only for the root domain and known slugs", () => {
    const knownSlugs = new Set(["toolittlecakes", "alice-2"]);
    const isKnown = (slug: string) => knownSlugs.has(slug);

    expect(isRelayTlsDomainAllowed("codex-dispatcher.app", "codex-dispatcher.app", isKnown)).toBe(true);
    expect(isRelayTlsDomainAllowed("toolittlecakes.codex-dispatcher.app", "codex-dispatcher.app", isKnown)).toBe(true);
    expect(isRelayTlsDomainAllowed("alice-2.codex-dispatcher.app", "codex-dispatcher.app", isKnown)).toBe(true);
    expect(isRelayTlsDomainAllowed("unknown.codex-dispatcher.app", "codex-dispatcher.app", isKnown)).toBe(false);
    expect(isRelayTlsDomainAllowed("a.b.codex-dispatcher.app", "codex-dispatcher.app", isKnown)).toBe(false);
  });
});
