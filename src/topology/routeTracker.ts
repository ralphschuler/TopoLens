import { formatAsPath, type AsPathSegment, type RipeUpdate } from "../utils/ris";

export const DEFAULT_MAX_ROUTES = 5_000;
export const DEFAULT_MAX_CHANGES = 1_000;

export interface RouteTrackerOptions {
  /** Maximum active route states retained in least-recently-observed order. */
  maxRoutes?: number;
  /** Maximum topology changes retained in chronological order. */
  maxChanges?: number;
}

/**
 * An undirected, canonical AS adjacency. The lower ASN is always `source`, so
 * observing the same adjacency from the opposite BGP direction cannot create
 * a false link flap.
 */
export interface AsEdge {
  key: string;
  source: number;
  target: number;
}

export interface TrackedRoute {
  key: string;
  collector: string;
  peer: string;
  prefix: string;
  peerAsn?: number;
  nextHop?: string;
  asPath: AsPathSegment[];
  asPathDisplay: string;
  origin: AsPathSegment | null;
  originAs: number | null;
  edges: AsEdge[];
  firstObservedAt: number;
  lastObservedAt: number;
  firstReceivedAt: number;
  lastReceivedAt: number;
  firstMessageId?: string;
  lastMessageId?: string;
}

export type TopologyChangeType =
  "first-observed" | "path-changed" | "origin-changed" | "withdrawn" | "withdrawal-observed";

/** One topology-relevant transition, in tracker processing order. */
export interface TopologyChange {
  sequence: number;
  type: TopologyChangeType;
  routeKey: string;
  messageId?: string;
  timestamp: number;
  receivedAt: number;
  collector: string;
  peer: string;
  prefix: string;
  previousPath: AsPathSegment[];
  previousPathDisplay: string;
  currentPath: AsPathSegment[];
  currentPathDisplay: string;
  previousOrigin: AsPathSegment | null;
  currentOrigin: AsPathSegment | null;
  addedEdges: AsEdge[];
  removedEdges: AsEdge[];
}

/**
 * All-session counters are kept separate from retained-state gauges. This is
 * important once bounded retention starts evicting routes or old changes.
 */
export interface RouteTrackerStats {
  updatesReceived: number;
  announcementsReceived: number;
  withdrawalsReceived: number;
  identicalAnnouncementsIgnored: number;
  nonTopologyAnnouncements: number;
  firstObservedChanges: number;
  pathChangedChanges: number;
  originChangedChanges: number;
  withdrawnChanges: number;
  withdrawalObservedChanges: number;
  /** Total changes since construction/clear, including dropped history. */
  changesObserved: number;
  /** Current bounded route-state size. */
  trackedRoutes: number;
  /** Route states discarded only because maxRoutes was reached. */
  evictedRoutes: number;
  /** Current bounded change-history size. */
  retainedChanges: number;
  /** Historical changes discarded only because maxChanges was reached. */
  droppedChanges: number;
}

export interface RouteTrackerSnapshot {
  /** Oldest to most recently observed retained route (LRU order). */
  routes: TrackedRoute[];
  /** Oldest to newest retained topology change. */
  changes: TopologyChange[];
  stats: RouteTrackerStats;
}

interface SessionCounters {
  updatesReceived: number;
  announcementsReceived: number;
  withdrawalsReceived: number;
  identicalAnnouncementsIgnored: number;
  nonTopologyAnnouncements: number;
  firstObservedChanges: number;
  pathChangedChanges: number;
  originChangedChanges: number;
  withdrawnChanges: number;
  withdrawalObservedChanges: number;
  changesObserved: number;
  evictedRoutes: number;
  droppedChanges: number;
}

function emptyCounters(): SessionCounters {
  return {
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
    evictedRoutes: 0,
    droppedChanges: 0,
  };
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function normalizeIdentityPart(value: string | undefined, fallback = "unknown"): string {
  const normalized = value?.trim();
  return normalized ? normalized : fallback;
}

/** Build the collision-free collector + peer + prefix route identity. */
export function makeRouteKey(collector: string, peer: string, prefix: string): string {
  return JSON.stringify([collector, peer, prefix]);
}

function normalizeStructuredPath(path: readonly AsPathSegment[]): AsPathSegment[] {
  const normalized: AsPathSegment[] = [];

  for (const segment of path) {
    if (
      segment?.kind === "asn" &&
      Number.isSafeInteger(segment.asn) &&
      segment.asn >= 0 &&
      segment.asn <= 4_294_967_295
    ) {
      normalized.push({ kind: "asn", asn: segment.asn });
      continue;
    }

    if (segment?.kind === "as-set" && Array.isArray(segment.asns) && segment.asns.length > 0) {
      const valid = segment.asns.every(
        (asn) => Number.isSafeInteger(asn) && asn >= 0 && asn <= 4_294_967_295,
      );
      if (valid) {
        normalized.push({
          kind: "as-set",
          asns: [...new Set(segment.asns)].sort((left, right) => left - right),
        });
        continue;
      }
    }

    // As with the wire normalizer, never join the valid portions around a bad
    // segment: doing so would manufacture an AS adjacency.
    return [];
  }

  return normalized;
}

function cloneSegment(segment: AsPathSegment): AsPathSegment {
  return segment.kind === "asn"
    ? { kind: "asn", asn: segment.asn }
    : { kind: "as-set", asns: [...segment.asns] };
}

function clonePath(path: readonly AsPathSegment[]): AsPathSegment[] {
  return path.map(cloneSegment);
}

function segmentKey(segment: AsPathSegment | null): string {
  if (!segment) return "none";
  return segment.kind === "asn" ? `asn:${segment.asn}` : `set:${segment.asns.join(",")}`;
}

function pathKey(path: readonly AsPathSegment[]): string {
  return path.map(segmentKey).join("|");
}

function sameOptionalValue<T>(left: T | undefined, right: T | undefined): boolean {
  return left === right;
}

/**
 * Convert a structured path to certain AS adjacencies only.
 *
 * - AS-prepending self-loops are ignored.
 * - Any adjacency touching an AS_SET is skipped because the set has no
 *   trustworthy internal order or single attachment ASN.
 * - Opposite path directions share one canonical undirected edge.
 */
export function routeEdges(path: readonly AsPathSegment[]): AsEdge[] {
  const edges = new Map<string, AsEdge>();
  for (let index = 0; index < path.length - 1; index += 1) {
    const left = path[index];
    const right = path[index + 1];
    if (left.kind !== "asn" || right.kind !== "asn" || left.asn === right.asn) continue;

    const source = Math.min(left.asn, right.asn);
    const target = Math.max(left.asn, right.asn);
    const key = `${source}--${target}`;
    if (!edges.has(key)) edges.set(key, { key, source, target });
  }
  return [...edges.values()];
}

function edgeDiff(previous: readonly AsEdge[], current: readonly AsEdge[]) {
  const previousKeys = new Set(previous.map((edge) => edge.key));
  const currentKeys = new Set(current.map((edge) => edge.key));
  return {
    addedEdges: current.filter((edge) => !previousKeys.has(edge.key)).map(cloneEdge),
    removedEdges: previous.filter((edge) => !currentKeys.has(edge.key)).map(cloneEdge),
  };
}

function cloneEdge(edge: AsEdge): AsEdge {
  return { key: edge.key, source: edge.source, target: edge.target };
}

function originOf(path: readonly AsPathSegment[]): AsPathSegment | null {
  return path.length > 0 ? cloneSegment(path[path.length - 1]) : null;
}

function cloneRoute(route: TrackedRoute): TrackedRoute {
  return {
    ...route,
    asPath: clonePath(route.asPath),
    origin: route.origin ? cloneSegment(route.origin) : null,
    edges: route.edges.map(cloneEdge),
  };
}

function cloneChange(change: TopologyChange): TopologyChange {
  return {
    ...change,
    previousPath: clonePath(change.previousPath),
    currentPath: clonePath(change.currentPath),
    previousOrigin: change.previousOrigin ? cloneSegment(change.previousOrigin) : null,
    currentOrigin: change.currentOrigin ? cloneSegment(change.currentOrigin) : null,
    addedEdges: change.addedEdges.map(cloneEdge),
    removedEdges: change.removedEdges.map(cloneEdge),
  };
}

/**
 * Stateful route-table projection over normalized RIS updates.
 *
 * `apply` returns only changes caused by that call. `getSnapshot` returns
 * defensive copies of bounded current state and session history. `clear`
 * starts a completely fresh session, including sequence and statistics.
 */
export class RouteTracker {
  private readonly maxRoutes: number;
  private readonly maxChanges: number;
  private readonly routes = new Map<string, TrackedRoute>();
  private readonly changes: TopologyChange[] = [];
  private counters = emptyCounters();
  private sequence = 0;

  constructor(options: RouteTrackerOptions = {}) {
    this.maxRoutes = options.maxRoutes ?? DEFAULT_MAX_ROUTES;
    this.maxChanges = options.maxChanges ?? DEFAULT_MAX_CHANGES;
    assertPositiveInteger("maxRoutes", this.maxRoutes);
    assertPositiveInteger("maxChanges", this.maxChanges);
  }

  apply(updates: readonly RipeUpdate[]): TopologyChange[] {
    const emitted: TopologyChange[] = [];
    for (const update of updates) {
      this.counters.updatesReceived += 1;
      const change =
        update.kind === "announce" ? this.applyAnnouncement(update) : this.applyWithdrawal(update);
      if (change) emitted.push(cloneChange(change));
    }
    return emitted;
  }

  getSnapshot(): RouteTrackerSnapshot {
    return {
      routes: [...this.routes.values()].map(cloneRoute),
      changes: this.changes.map(cloneChange),
      stats: {
        ...this.counters,
        trackedRoutes: this.routes.size,
        retainedChanges: this.changes.length,
      },
    };
  }

  clear(): void {
    this.routes.clear();
    this.changes.length = 0;
    this.counters = emptyCounters();
    this.sequence = 0;
  }

  private applyAnnouncement(update: RipeUpdate): TopologyChange | undefined {
    this.counters.announcementsReceived += 1;
    const identity = this.identity(update);
    const previous = this.routes.get(identity.key);
    const currentPath = normalizeStructuredPath(update.asPath);
    const currentOrigin = originOf(currentPath);
    const currentEdges = routeEdges(currentPath);

    if (!previous) {
      const route = this.createRoute(update, identity, currentPath, currentOrigin, currentEdges);
      this.touchRoute(identity.key, route);
      this.evictRoutesIfNeeded();
      return this.recordChange({
        type: "first-observed",
        update,
        identity,
        previousPath: [],
        currentPath,
        previousOrigin: null,
        currentOrigin,
        addedEdges: currentEdges,
        removedEdges: [],
      });
    }

    const samePath = pathKey(previous.asPath) === pathKey(currentPath);
    const sameAttributes =
      sameOptionalValue(previous.nextHop, update.nextHop) &&
      sameOptionalValue(previous.peerAsn, update.peerAsn);

    const refreshed: TrackedRoute = {
      ...previous,
      peerAsn: update.peerAsn,
      nextHop: update.nextHop,
      asPath: clonePath(currentPath),
      asPathDisplay: formatAsPath(currentPath),
      origin: currentOrigin ? cloneSegment(currentOrigin) : null,
      originAs: currentOrigin?.kind === "asn" ? currentOrigin.asn : null,
      edges: currentEdges.map(cloneEdge),
      lastObservedAt: update.timestamp,
      lastReceivedAt: update.receivedAt,
      lastMessageId: update.id,
    };
    this.touchRoute(identity.key, refreshed);

    if (samePath) {
      if (sameAttributes) this.counters.identicalAnnouncementsIgnored += 1;
      else this.counters.nonTopologyAnnouncements += 1;
      return undefined;
    }

    const type: TopologyChangeType =
      segmentKey(previous.origin) === segmentKey(currentOrigin) ? "path-changed" : "origin-changed";
    const { addedEdges, removedEdges } = edgeDiff(previous.edges, currentEdges);
    return this.recordChange({
      type,
      update,
      identity,
      previousPath: previous.asPath,
      currentPath,
      previousOrigin: previous.origin,
      currentOrigin,
      addedEdges,
      removedEdges,
    });
  }

  private applyWithdrawal(update: RipeUpdate): TopologyChange {
    this.counters.withdrawalsReceived += 1;
    const identity = this.identity(update);
    const previous = this.routes.get(identity.key);

    if (!previous) {
      return this.recordChange({
        type: "withdrawal-observed",
        update,
        identity,
        previousPath: [],
        currentPath: [],
        previousOrigin: null,
        currentOrigin: null,
        addedEdges: [],
        removedEdges: [],
      });
    }

    this.routes.delete(identity.key);
    return this.recordChange({
      type: "withdrawn",
      update,
      identity,
      previousPath: previous.asPath,
      currentPath: [],
      previousOrigin: previous.origin,
      currentOrigin: null,
      addedEdges: [],
      removedEdges: previous.edges,
    });
  }

  private identity(update: RipeUpdate) {
    const collector = normalizeIdentityPart(update.collector || update.host);
    const peer = normalizeIdentityPart(update.peer);
    const prefix = normalizeIdentityPart(update.prefix);
    return {
      key: makeRouteKey(collector, peer, prefix),
      collector,
      peer,
      prefix,
    };
  }

  private createRoute(
    update: RipeUpdate,
    identity: ReturnType<RouteTracker["identity"]>,
    path: readonly AsPathSegment[],
    origin: AsPathSegment | null,
    edges: readonly AsEdge[],
  ): TrackedRoute {
    return {
      key: identity.key,
      collector: identity.collector,
      peer: identity.peer,
      prefix: identity.prefix,
      peerAsn: update.peerAsn,
      nextHop: update.nextHop,
      asPath: clonePath(path),
      asPathDisplay: formatAsPath(path),
      origin: origin ? cloneSegment(origin) : null,
      originAs: origin?.kind === "asn" ? origin.asn : null,
      edges: edges.map(cloneEdge),
      firstObservedAt: update.timestamp,
      lastObservedAt: update.timestamp,
      firstReceivedAt: update.receivedAt,
      lastReceivedAt: update.receivedAt,
      firstMessageId: update.id,
      lastMessageId: update.id,
    };
  }

  private touchRoute(key: string, route: TrackedRoute): void {
    this.routes.delete(key);
    this.routes.set(key, route);
  }

  private evictRoutesIfNeeded(): void {
    while (this.routes.size > this.maxRoutes) {
      const oldestKey = this.routes.keys().next().value as string | undefined;
      if (oldestKey === undefined) return;
      this.routes.delete(oldestKey);
      this.counters.evictedRoutes += 1;
    }
  }

  private recordChange(input: {
    type: TopologyChangeType;
    update: RipeUpdate;
    identity: ReturnType<RouteTracker["identity"]>;
    previousPath: readonly AsPathSegment[];
    currentPath: readonly AsPathSegment[];
    previousOrigin: AsPathSegment | null;
    currentOrigin: AsPathSegment | null;
    addedEdges: readonly AsEdge[];
    removedEdges: readonly AsEdge[];
  }): TopologyChange {
    this.sequence += 1;
    const change: TopologyChange = {
      sequence: this.sequence,
      type: input.type,
      routeKey: input.identity.key,
      messageId: input.update.id,
      timestamp: input.update.timestamp,
      receivedAt: input.update.receivedAt,
      collector: input.identity.collector,
      peer: input.identity.peer,
      prefix: input.identity.prefix,
      previousPath: clonePath(input.previousPath),
      previousPathDisplay: formatAsPath(input.previousPath),
      currentPath: clonePath(input.currentPath),
      currentPathDisplay: formatAsPath(input.currentPath),
      previousOrigin: input.previousOrigin ? cloneSegment(input.previousOrigin) : null,
      currentOrigin: input.currentOrigin ? cloneSegment(input.currentOrigin) : null,
      addedEdges: input.addedEdges.map(cloneEdge),
      removedEdges: input.removedEdges.map(cloneEdge),
    };

    this.counters.changesObserved += 1;
    switch (input.type) {
      case "first-observed":
        this.counters.firstObservedChanges += 1;
        break;
      case "path-changed":
        this.counters.pathChangedChanges += 1;
        break;
      case "origin-changed":
        this.counters.originChangedChanges += 1;
        break;
      case "withdrawn":
        this.counters.withdrawnChanges += 1;
        break;
      case "withdrawal-observed":
        this.counters.withdrawalObservedChanges += 1;
        break;
    }

    this.changes.push(change);
    while (this.changes.length > this.maxChanges) {
      this.changes.shift();
      this.counters.droppedChanges += 1;
    }
    return change;
  }
}
