import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { extractUpdates, formatAsPath } from "./ris";

describe("extractUpdates", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T03:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("normalizes the official RIS Live UPDATE schema", () => {
    const updates = extractUpdates({
      type: "ris_message",
      data: {
        timestamp: 1568279796.63,
        peer: "192.0.2.0",
        peer_asn: "64496",
        id: "21-192-0-2-0-11188782",
        host: "rrc21",
        type: "UPDATE",
        path: [64496, 64500, 64501],
        announcements: [
          {
            next_hop: "192.0.2.0",
            prefixes: ["192.0.3.0/24", "192.0.4.0/24"],
          },
        ],
      },
    });

    expect(updates).toHaveLength(2);
    expect(updates[0]).toEqual({
      kind: "announce",
      timestamp: 1568279796630,
      receivedAt: Date.now(),
      id: "21-192-0-2-0-11188782",
      prefix: "192.0.3.0/24",
      peer: "192.0.2.0",
      collector: "rrc21",
      host: "rrc21",
      peerAsn: 64496,
      originAs: 64501,
      origin: { kind: "asn", asn: 64501 },
      nextHop: "192.0.2.0",
      asPath: [
        { kind: "asn", asn: 64496 },
        { kind: "asn", asn: 64500 },
        { kind: "asn", asn: 64501 },
      ],
      asPathDisplay: "64496 64500 64501",
    });
    expect(updates[1]).toMatchObject({
      id: "21-192-0-2-0-11188782",
      prefix: "192.0.4.0/24",
      nextHop: "192.0.2.0",
    });
  });

  it("preserves an AS_SET structurally without inventing a single origin", () => {
    const [update] = extractUpdates({
      type: "ris_message",
      data: {
        timestamp: 1716660000,
        peer: "2001:db8::1",
        peer_asn: "65000",
        id: "set-example",
        host: "rrc00",
        type: "UPDATE",
        // Sorting and duplicates are normalized defensively even though RIS
        // promises ascending, unique AS_SET values.
        path: [65000, [64497, 64496, 64497]],
        announcements: [
          {
            next_hop: "2001:db8::ffff",
            prefixes: ["2001:db8:42::/48"],
          },
        ],
      },
    });

    expect(update).toMatchObject({
      asPath: [
        { kind: "asn", asn: 65000 },
        { kind: "as-set", asns: [64496, 64497] },
      ],
      asPathDisplay: "65000 {64496,64497}",
      origin: { kind: "as-set", asns: [64496, 64497] },
      originAs: null,
    });
  });

  it("normalizes official withdrawals and tolerates common object variants", () => {
    const updates = extractUpdates({
      type: "ris_message",
      data: {
        timestamp: 1716660000,
        peer: "192.0.2.1",
        peer_asn: 65000,
        id: "withdraw-example",
        host: "rrc01",
        type: "UPDATE",
        withdrawals: [
          "203.0.113.0/24",
          { prefix: "198.51.100.0/24" },
          { prefixes: ["2001:db8::/32", "203.0.113.0/24", null] },
          "   ",
          null,
        ],
      },
    });

    expect(updates.map((update) => update.prefix)).toEqual([
      "203.0.113.0/24",
      "198.51.100.0/24",
      "2001:db8::/32",
    ]);
    expect(updates[0]).toEqual({
      kind: "withdraw",
      timestamp: 1716660000000,
      receivedAt: Date.now(),
      id: "withdraw-example",
      prefix: "203.0.113.0/24",
      peer: "192.0.2.1",
      collector: "rrc01",
      host: "rrc01",
      peerAsn: 65000,
      originAs: null,
      origin: null,
      asPath: [],
      asPathDisplay: "",
    });
  });

  it("deduplicates and trims announcement prefixes", () => {
    const updates = extractUpdates({
      type: "ris_message",
      data: {
        type: "UPDATE",
        peer: "192.0.2.1",
        host: "rrc00",
        path: [65000],
        announcements: [
          {
            next_hop: " 192.0.2.254 ",
            prefixes: [" 203.0.113.0/24 ", "203.0.113.0/24", null, ""],
          },
        ],
      },
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      prefix: "203.0.113.0/24",
      nextHop: "192.0.2.254",
      collector: "rrc00",
    });
  });

  it("does not bridge across a malformed AS path segment", () => {
    const [update] = extractUpdates({
      type: "ris_message",
      data: {
        type: "UPDATE",
        peer: "192.0.2.1",
        host: "rrc00",
        path: [65000, "not-an-asn", 64496],
        announcements: [{ prefixes: ["203.0.113.0/24"] }],
      },
    });

    expect(update.asPath).toEqual([]);
    expect(update.asPathDisplay).toBe("");
    expect(update.origin).toBeNull();
    expect(update.originAs).toBeNull();
  });

  it("uses the receipt time only when the source timestamp is unavailable", () => {
    const [zeroTimestamp] = extractUpdates({
      type: "ris_message",
      data: {
        timestamp: 0,
        type: "UPDATE",
        peer: "192.0.2.1",
        host: "rrc00",
        announcements: [{ prefixes: ["203.0.113.0/24"] }],
      },
    });
    const [missingTimestamp] = extractUpdates({
      type: "ris_message",
      data: {
        type: "UPDATE",
        peer: "192.0.2.1",
        host: "rrc00",
        announcements: [{ prefixes: ["198.51.100.0/24"] }],
      },
    });

    expect(zeroTimestamp.timestamp).toBe(0);
    expect(missingTimestamp.timestamp).toBe(Date.now());
  });

  it("rejects messages without a collision-free collector and peer identity", () => {
    expect(
      extractUpdates({
        type: "ris_message",
        data: {
          type: "UPDATE",
          peer: "192.0.2.1",
          announcements: [{ prefixes: ["203.0.113.0/24"] }],
        },
      }),
    ).toEqual([]);
    expect(
      extractUpdates({
        type: "ris_message",
        data: {
          type: "UPDATE",
          host: "rrc00",
          withdrawals: ["203.0.113.0/24"],
        },
      }),
    ).toEqual([]);
  });

  it("falls back to receipt time for timestamps outside the JavaScript date range", () => {
    const [update] = extractUpdates({
      type: "ris_message",
      data: {
        timestamp: Number.MAX_VALUE,
        type: "UPDATE",
        peer: "192.0.2.1",
        host: "rrc00",
        announcements: [{ prefixes: ["203.0.113.0/24"] }],
      },
    });

    expect(update.timestamp).toBe(Date.now());
  });

  it("ignores unsupported and non-UPDATE messages", () => {
    expect(extractUpdates({ type: "ping" })).toEqual([]);
    expect(
      extractUpdates({
        type: "ris_message",
        data: { type: "KEEPALIVE", announcements: [{ prefixes: ["203.0.113.0/24"] }] },
      }),
    ).toEqual([]);
    expect(extractUpdates(null)).toEqual([]);
  });
});

describe("formatAsPath", () => {
  it("formats individual ASNs and AS_SETs for display", () => {
    expect(
      formatAsPath([
        { kind: "asn", asn: 64500 },
        { kind: "as-set", asns: [64496, 64497] },
      ]),
    ).toBe("64500 {64496,64497}");
  });
});
