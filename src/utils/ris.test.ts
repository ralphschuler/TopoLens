import { describe, expect, it } from "vitest";
import { extractUpdates } from "./ris";

describe("extractUpdates", () => {
  it("returns announce updates for prefixes", () => {
    const updates = extractUpdates({
      type: "ris_message",
      data: {
        timestamp: 1716660000,
        peer: "192.0.2.1",
        host: "rrc00",
        peer_asn: "65000",
        announcements: [
          {
            prefix: "203.0.113.0/24",
            next_hop: "192.0.2.254",
            as_path: [65000, 64496],
          },
        ],
      },
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      kind: "announce",
      prefix: "203.0.113.0/24",
      peer: "192.0.2.1",
      peerAsn: 65000,
      originAs: 64496,
      nextHop: "192.0.2.254",
      asPath: "65000 64496",
    });
  });

  it("returns withdraw updates", () => {
    const updates = extractUpdates({
      type: "ris_message",
      data: {
        timestamp: 1716660000,
        peer: "192.0.2.1",
        withdrawals: ["203.0.113.0/24"],
      },
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      kind: "withdraw",
      prefix: "203.0.113.0/24",
    });
  });

  it("ignores unsupported messages", () => {
    expect(extractUpdates({ type: "ping" })).toHaveLength(0);
    expect(extractUpdates(null)).toHaveLength(0);
  });
});
