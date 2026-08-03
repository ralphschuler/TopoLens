import { describe, expect, it } from "vitest";

import {
  buildRisSubscriptionPayload,
  normalizeRisSubscription,
  validateRisSubscription,
} from "./subscription";

describe("RIS subscription helpers", () => {
  it("builds a narrow UPDATE subscription with acknowledgement enabled", () => {
    expect(
      buildRisSubscriptionPayload({
        collector: " rrc21 ",
        prefix: " 203.0.113.0/24 ",
        path: " 64496 ",
      }),
    ).toEqual({
      host: "rrc21",
      type: "UPDATE",
      prefix: "203.0.113.0/24",
      moreSpecific: true,
      path: 64496,
      socketOptions: {
        acknowledge: true,
        includeRaw: false,
      },
    });
  });

  it("omits empty optional filters", () => {
    expect(buildRisSubscriptionPayload({ collector: "rrc00", prefix: "", path: "" })).toEqual({
      host: "rrc00",
      type: "UPDATE",
      socketOptions: {
        acknowledge: true,
        includeRaw: false,
      },
    });
  });

  it("preserves official AS-path patterns and normalizes whitespace", () => {
    const normalized = normalizeRisSubscription({
      collector: "rrc00.ripe.net",
      prefix: " 2001:db8::/32 ",
      path: " ^64496,64497$ ",
    });

    expect(normalized).toEqual({
      collector: "rrc00.ripe.net",
      prefix: "2001:db8::/32",
      path: "^64496,64497$",
    });
    expect(buildRisSubscriptionPayload(normalized).path).toBe("^64496,64497$");
  });

  it("rejects malformed collector, prefix, and path values", () => {
    expect(validateRisSubscription({ collector: "ams", prefix: "", path: "" })).toContain(
      "collector",
    );
    expect(
      validateRisSubscription({ collector: "rrc00", prefix: "not-a-prefix", path: "" }),
    ).toContain("prefix");
    expect(
      validateRisSubscription({ collector: "rrc00", prefix: "", path: "hello world" }),
    ).toContain("AS path");
  });
});
