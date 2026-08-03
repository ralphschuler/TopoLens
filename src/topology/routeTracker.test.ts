import { describe, expect, it } from "vitest";

import type { AsPathSegment, RipeUpdate } from "../utils/ris";
import { makeRouteKey, RouteTracker, type RouteTrackerOptions } from "./routeTracker";

const ASN = (asn: number): AsPathSegment => ({ kind: "asn", asn });
const AS_SET = (...asns: number[]): AsPathSegment => ({ kind: "as-set", asns });

let messageSequence = 0;

function announce(
  prefix: string,
  asPath: AsPathSegment[],
  overrides: Partial<RipeUpdate> = {},
): RipeUpdate {
  messageSequence += 1;
  const origin = asPath.at(-1) ?? null;
  return {
    kind: "announce",
    timestamp: messageSequence * 1_000,
    receivedAt: messageSequence * 1_000 + 10,
    id: `message-${messageSequence}`,
    prefix,
    peer: "192.0.2.1",
    collector: "rrc00",
    host: "rrc00",
    peerAsn: 65000,
    originAs: origin?.kind === "asn" ? origin.asn : null,
    origin,
    nextHop: "192.0.2.254",
    asPath,
    asPathDisplay: "input display is not trusted",
    ...overrides,
  } as RipeUpdate;
}

function withdraw(prefix: string, overrides: Partial<RipeUpdate> = {}): RipeUpdate {
  messageSequence += 1;
  return {
    kind: "withdraw",
    timestamp: messageSequence * 1_000,
    receivedAt: messageSequence * 1_000 + 10,
    id: `message-${messageSequence}`,
    prefix,
    peer: "192.0.2.1",
    collector: "rrc00",
    host: "rrc00",
    peerAsn: 65000,
    originAs: null,
    origin: null,
    asPath: [],
    asPathDisplay: "",
    ...overrides,
  } as RipeUpdate;
}

function tracker(options?: RouteTrackerOptions): RouteTracker {
  messageSequence = 0;
  return new RouteTracker(options);
}

describe("RouteTracker", () => {
  it("records the first observation of a route and its canonical topology edges", () => {
    const subject = tracker();
    const update = announce("203.0.113.0/24", [ASN(65000), ASN(64500), ASN(64496)]);

    const changes = subject.apply([update]);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      sequence: 1,
      type: "first-observed",
      routeKey: makeRouteKey("rrc00", "192.0.2.1", "203.0.113.0/24"),
      messageId: update.id,
      previousPath: [],
      currentPath: [ASN(65000), ASN(64500), ASN(64496)],
      previousOrigin: null,
      currentOrigin: ASN(64496),
      removedEdges: [],
    });
    expect(changes[0].addedEdges).toEqual([
      { key: "64500--65000", source: 64500, target: 65000 },
      { key: "64496--64500", source: 64496, target: 64500 },
    ]);

    const snapshot = subject.getSnapshot();
    expect(snapshot.routes).toHaveLength(1);
    expect(snapshot.routes[0]).toMatchObject({
      key: changes[0].routeKey,
      collector: "rrc00",
      peer: "192.0.2.1",
      prefix: "203.0.113.0/24",
      asPathDisplay: "65000 64500 64496",
      origin: ASN(64496),
      originAs: 64496,
      firstObservedAt: update.timestamp,
      lastObservedAt: update.timestamp,
    });
    expect(snapshot.stats).toMatchObject({
      updatesReceived: 1,
      announcementsReceived: 1,
      withdrawalsReceived: 0,
      firstObservedChanges: 1,
      changesObserved: 1,
      trackedRoutes: 1,
      retainedChanges: 1,
    });
  });

  it("keys routes by collector, peer, and prefix", () => {
    const subject = tracker();
    const path = [ASN(65000), ASN(64496)];

    subject.apply([
      announce("203.0.113.0/24", path),
      announce("203.0.113.0/24", path, { collector: "rrc01", host: "rrc01" }),
      announce("203.0.113.0/24", path, { peer: "192.0.2.2" }),
    ]);

    expect(subject.getSnapshot().routes.map((route) => route.key)).toEqual([
      makeRouteKey("rrc00", "192.0.2.1", "203.0.113.0/24"),
      makeRouteKey("rrc01", "192.0.2.1", "203.0.113.0/24"),
      makeRouteKey("rrc00", "192.0.2.2", "203.0.113.0/24"),
    ]);
  });

  it("ignores identical announcements while refreshing the retained route", () => {
    const subject = tracker();
    const first = announce("203.0.113.0/24", [ASN(65000), ASN(64496)]);
    const duplicate = announce("203.0.113.0/24", [ASN(65000), ASN(64496)]);

    subject.apply([first]);
    expect(subject.apply([duplicate])).toEqual([]);

    const snapshot = subject.getSnapshot();
    expect(snapshot.changes).toHaveLength(1);
    expect(snapshot.routes[0]).toMatchObject({
      firstObservedAt: first.timestamp,
      lastObservedAt: duplicate.timestamp,
      lastMessageId: duplicate.id,
    });
    expect(snapshot.stats).toMatchObject({
      updatesReceived: 2,
      announcementsReceived: 2,
      identicalAnnouncementsIgnored: 1,
      changesObserved: 1,
    });
  });

  it("updates non-topological attributes without claiming the AS path changed", () => {
    const subject = tracker();
    subject.apply([announce("203.0.113.0/24", [ASN(65000), ASN(64496)])]);

    const changes = subject.apply([
      announce("203.0.113.0/24", [ASN(65000), ASN(64496)], {
        nextHop: "192.0.2.253",
      }),
    ]);

    expect(changes).toEqual([]);
    expect(subject.getSnapshot()).toMatchObject({
      routes: [{ nextHop: "192.0.2.253" }],
      stats: {
        identicalAnnouncementsIgnored: 0,
        nonTopologyAnnouncements: 1,
        changesObserved: 1,
      },
    });
  });

  it("reports an exact edge diff for a path change with the same origin", () => {
    const subject = tracker();
    subject.apply([announce("203.0.113.0/24", [ASN(65000), ASN(64500), ASN(64496)])]);

    const [change] = subject.apply([
      announce("203.0.113.0/24", [ASN(65000), ASN(64501), ASN(64496)]),
    ]);

    expect(change).toMatchObject({
      type: "path-changed",
      previousOrigin: ASN(64496),
      currentOrigin: ASN(64496),
      addedEdges: [
        { key: "64501--65000", source: 64501, target: 65000 },
        { key: "64496--64501", source: 64496, target: 64501 },
      ],
      removedEdges: [
        { key: "64500--65000", source: 64500, target: 65000 },
        { key: "64496--64500", source: 64496, target: 64500 },
      ],
    });
    expect(subject.getSnapshot().stats.pathChangedChanges).toBe(1);
  });

  it("classifies an origin change once instead of also emitting a path change", () => {
    const subject = tracker();
    subject.apply([announce("203.0.113.0/24", [ASN(65000), ASN(64496)])]);

    const changes = subject.apply([announce("203.0.113.0/24", [ASN(65000), ASN(64497)])]);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      type: "origin-changed",
      previousOrigin: ASN(64496),
      currentOrigin: ASN(64497),
      addedEdges: [{ key: "64497--65000", source: 64497, target: 65000 }],
      removedEdges: [{ key: "64496--65000", source: 64496, target: 65000 }],
    });
    expect(subject.getSnapshot().stats).toMatchObject({
      pathChangedChanges: 0,
      originChangedChanges: 1,
    });
  });

  it("preserves AS_SETs but skips uncertain adjacencies and AS-prepending self-loops", () => {
    const subject = tracker();

    const [change] = subject.apply([
      announce("203.0.113.0/24", [ASN(65000), ASN(65000), ASN(64500), AS_SET(64497, 64496, 64497)]),
    ]);

    expect(change.currentPath).toEqual([ASN(65000), ASN(65000), ASN(64500), AS_SET(64496, 64497)]);
    expect(change.currentPathDisplay).toBe("65000 65000 64500 {64496,64497}");
    expect(change.addedEdges).toEqual([{ key: "64500--65000", source: 64500, target: 65000 }]);
    expect(change.currentOrigin).toEqual(AS_SET(64496, 64497));
    expect(subject.getSnapshot().routes[0].originAs).toBeNull();
  });

  it("removes a known route and emits all removed route edges", () => {
    const subject = tracker();
    subject.apply([announce("203.0.113.0/24", [ASN(65000), ASN(64500), ASN(64496)])]);

    const [change] = subject.apply([withdraw("203.0.113.0/24")]);

    expect(change).toMatchObject({
      type: "withdrawn",
      previousPath: [ASN(65000), ASN(64500), ASN(64496)],
      currentPath: [],
      addedEdges: [],
      removedEdges: [
        { key: "64500--65000", source: 64500, target: 65000 },
        { key: "64496--64500", source: 64496, target: 64500 },
      ],
    });
    expect(subject.getSnapshot()).toMatchObject({
      routes: [],
      stats: {
        withdrawalsReceived: 1,
        withdrawnChanges: 1,
        withdrawalObservedChanges: 0,
        trackedRoutes: 0,
      },
    });
  });

  it("records an unmatched withdrawal as an observation without fabricating edges", () => {
    const subject = tracker();

    const [change] = subject.apply([withdraw("203.0.113.0/24")]);

    expect(change).toMatchObject({
      type: "withdrawal-observed",
      previousPath: [],
      currentPath: [],
      previousOrigin: null,
      currentOrigin: null,
      addedEdges: [],
      removedEdges: [],
    });
    expect(subject.getSnapshot().stats).toMatchObject({
      withdrawalsReceived: 1,
      withdrawnChanges: 0,
      withdrawalObservedChanges: 1,
      changesObserved: 1,
    });
  });

  it("applies a batch in order", () => {
    const subject = tracker();
    const prefix = "203.0.113.0/24";

    const changes = subject.apply([
      announce(prefix, [ASN(65000), ASN(64496)]),
      announce(prefix, [ASN(65000), ASN(64496)]),
      announce(prefix, [ASN(65000), ASN(64500), ASN(64496)]),
      withdraw(prefix),
    ]);

    expect(changes.map((change) => change.type)).toEqual([
      "first-observed",
      "path-changed",
      "withdrawn",
    ]);
    expect(changes.map((change) => change.sequence)).toEqual([1, 2, 3]);
    expect(subject.getSnapshot().routes).toEqual([]);
  });

  it("bounds route state with least-recently-observed eviction", () => {
    const subject = tracker({ maxRoutes: 2, maxChanges: 20 });
    const path = [ASN(65000), ASN(64496)];
    const firstPrefix = "203.0.113.0/24";
    const secondPrefix = "198.51.100.0/24";
    const thirdPrefix = "192.0.2.0/24";

    subject.apply([announce(firstPrefix, path), announce(secondPrefix, path)]);
    // An identical observation still makes the first route the most recently used.
    subject.apply([announce(firstPrefix, path), announce(thirdPrefix, path)]);

    const snapshot = subject.getSnapshot();
    expect(snapshot.routes.map((route) => route.prefix)).toEqual([firstPrefix, thirdPrefix]);
    expect(snapshot.stats).toMatchObject({
      trackedRoutes: 2,
      evictedRoutes: 1,
      firstObservedChanges: 3,
    });
  });

  it("bounds change history while retaining honest all-session counters", () => {
    const subject = tracker({ maxRoutes: 10, maxChanges: 2 });

    subject.apply([
      withdraw("203.0.113.0/24"),
      withdraw("198.51.100.0/24"),
      withdraw("192.0.2.0/24"),
    ]);

    const snapshot = subject.getSnapshot();
    expect(snapshot.changes.map((change) => change.prefix)).toEqual([
      "198.51.100.0/24",
      "192.0.2.0/24",
    ]);
    expect(snapshot.stats).toMatchObject({
      changesObserved: 3,
      withdrawalObservedChanges: 3,
      retainedChanges: 2,
      droppedChanges: 1,
    });
  });

  it("returns defensive snapshots", () => {
    const subject = tracker();
    subject.apply([announce("203.0.113.0/24", [ASN(65000), ASN(64496)])]);

    const snapshot = subject.getSnapshot();
    snapshot.routes[0].asPath.push(ASN(1));
    snapshot.routes[0].edges.length = 0;
    snapshot.changes.length = 0;

    const fresh = subject.getSnapshot();
    expect(fresh.routes[0].asPath).toEqual([ASN(65000), ASN(64496)]);
    expect(fresh.routes[0].edges).toHaveLength(1);
    expect(fresh.changes).toHaveLength(1);
  });

  it("clears route state, history, sequence, and all statistics", () => {
    const subject = tracker();
    subject.apply([announce("203.0.113.0/24", [ASN(65000), ASN(64496)])]);

    subject.clear();

    expect(subject.getSnapshot()).toEqual({
      routes: [],
      changes: [],
      stats: {
        updatesReceived: 0,
        announcementsReceived: 0,
        withdrawalsReceived: 0,
        identicalAnnouncementsIgnored: 0,
        nonTopologyAnnouncements: 0,
        firstObservedChanges: 0,
        pathChangedChanges: 0,
        originChangedChanges: 0,
        withdrawnChanges: 0,
        withdrawalObservedChanges: 0,
        changesObserved: 0,
        trackedRoutes: 0,
        evictedRoutes: 0,
        retainedChanges: 0,
        droppedChanges: 0,
      },
    });

    const [change] = subject.apply([withdraw("203.0.113.0/24")]);
    expect(change.sequence).toBe(1);
  });

  it.each([
    { maxRoutes: 0 },
    { maxRoutes: -1 },
    { maxChanges: 0 },
    { maxChanges: Number.NaN },
    { maxChanges: 1.5 },
  ] as RouteTrackerOptions[])("rejects invalid retention options: %o", (options) => {
    expect(() => new RouteTracker(options)).toThrow(/positive integer/i);
  });
});
