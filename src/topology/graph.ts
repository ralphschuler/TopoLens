import type {
  GraphChangeState,
  GraphLinkPayload,
  GraphNodePayload,
  GraphPayload,
} from "../workers/messages";
import type { AsPathSegment } from "../utils/ris";
import { routeEdges, type AsEdge, type TopologyChange, type TrackedRoute } from "./routeTracker";

/** Browser-safe graph projection caps. RouteTracker retains a larger table. */
export const DEFAULT_MAX_GRAPH_ROUTES = 2_000;
export const DEFAULT_MAX_GRAPH_NODES = 1_000;
export const DEFAULT_MAX_GRAPH_EDGES = 2_000;

const MAX_ASN = 4_294_967_295;

export interface GraphBuildOptions {
  maxRoutes?: number;
  maxNodes?: number;
  maxEdges?: number;
  /** Full route count when callers already pre-truncated the input slice. */
  totalRouteCount?: number;
}

interface ResolvedGraphLimits {
  maxRoutes: number;
  maxNodes: number;
  maxEdges: number;
}

interface NodeAccumulator {
  asn: number;
  routeCount: number;
  activePriority: number;
  overlayPriority: number;
  changeState: GraphChangeState;
}

interface LinkAccumulator {
  key: string;
  sourceAsn: number;
  targetAsn: number;
  routeCount: number;
  activePriority: number;
  overlayPriority: number;
  changeState: GraphChangeState;
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function resolveLimits(options: GraphBuildOptions): ResolvedGraphLimits {
  const limits = {
    maxRoutes: options.maxRoutes ?? DEFAULT_MAX_GRAPH_ROUTES,
    maxNodes: options.maxNodes ?? DEFAULT_MAX_GRAPH_NODES,
    maxEdges: options.maxEdges ?? DEFAULT_MAX_GRAPH_EDGES,
  };
  assertPositiveInteger("maxRoutes", limits.maxRoutes);
  assertPositiveInteger("maxNodes", limits.maxNodes);
  assertPositiveInteger("maxEdges", limits.maxEdges);
  return limits;
}

function isAsn(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_ASN;
}

export function asNodeId(asn: number): string {
  return `as:${asn}`;
}

function canonicalEdge(source: number, target: number): AsEdge | undefined {
  if (!isAsn(source) || !isAsn(target) || source === target) return undefined;
  const lower = Math.min(source, target);
  const higher = Math.max(source, target);
  return { key: `${lower}--${higher}`, source: lower, target: higher };
}

function certainPathEdges(path: readonly AsPathSegment[]): AsEdge[] {
  return routeEdges(path).flatMap((edge) => {
    const canonical = canonicalEdge(edge.source, edge.target);
    return canonical ? [canonical] : [];
  });
}

function pathAsns(path: readonly AsPathSegment[]): number[] {
  const asns: number[] = [];
  const seen = new Set<number>();
  for (const segment of path) {
    const members = segment.kind === "asn" ? [segment.asn] : segment.asns;
    for (const asn of members) {
      if (!isAsn(asn) || seen.has(asn)) continue;
      seen.add(asn);
      asns.push(asn);
    }
  }
  return asns;
}

function recency(value: number): number {
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function compareRoutesByRecency(left: TrackedRoute, right: TrackedRoute): number {
  const leftObservedAt = recency(left.lastObservedAt);
  const rightObservedAt = recency(right.lastObservedAt);
  if (leftObservedAt !== rightObservedAt) {
    return leftObservedAt > rightObservedAt ? -1 : 1;
  }
  const leftReceivedAt = recency(left.lastReceivedAt);
  const rightReceivedAt = recency(right.lastReceivedAt);
  if (leftReceivedAt !== rightReceivedAt) {
    return leftReceivedAt > rightReceivedAt ? -1 : 1;
  }
  return left.key.localeCompare(right.key);
}

function ensureNode(nodes: Map<number, NodeAccumulator>, asn: number): NodeAccumulator {
  const existing = nodes.get(asn);
  if (existing) return existing;
  const created: NodeAccumulator = {
    asn,
    routeCount: 0,
    activePriority: Number.POSITIVE_INFINITY,
    overlayPriority: Number.POSITIVE_INFINITY,
    changeState: "unchanged",
  };
  nodes.set(asn, created);
  return created;
}

function ensureLink(links: Map<string, LinkAccumulator>, edge: AsEdge): LinkAccumulator {
  const existing = links.get(edge.key);
  if (existing) return existing;
  const created: LinkAccumulator = {
    key: edge.key,
    sourceAsn: edge.source,
    targetAsn: edge.target,
    routeCount: 0,
    activePriority: Number.POSITIVE_INFINITY,
    overlayPriority: Number.POSITIVE_INFINITY,
    changeState: "unchanged",
  };
  links.set(edge.key, created);
  return created;
}

function markOverlayNode(nodes: Map<number, NodeAccumulator>, asn: number, priority: number): void {
  const node = ensureNode(nodes, asn);
  node.overlayPriority = Math.min(node.overlayPriority, priority);
}

function addActiveRoutes(
  routes: readonly TrackedRoute[],
  nodes: Map<number, NodeAccumulator>,
  links: Map<string, LinkAccumulator>,
): void {
  let nodePriority = 0;
  let linkPriority = 0;
  for (const route of routes) {
    for (const asn of pathAsns(route.asPath)) {
      const node = ensureNode(nodes, asn);
      node.routeCount += 1;
      node.activePriority = Math.min(node.activePriority, nodePriority);
      nodePriority += 1;
    }

    // Reconstruct from the structured path. `TrackedRoute.edges` is a useful
    // tracker cache, but it must not be able to introduce stale/fake links.
    for (const edge of certainPathEdges(route.asPath)) {
      const link = ensureLink(links, edge);
      link.routeCount += 1;
      link.activePriority = Math.min(link.activePriority, linkPriority);
      linkPriority += 1;
    }
  }
}

function addChangeOverlay(
  change: TopologyChange,
  nodes: Map<number, NodeAccumulator>,
  links: Map<string, LinkAccumulator>,
): void {
  const previousAsns = pathAsns(change.previousPath);
  const currentAsns = pathAsns(change.currentPath);
  const previousAsnSet = new Set(previousAsns);
  const currentAsnSet = new Set(currentAsns);
  const previousEdges = new Map(
    certainPathEdges(change.previousPath).map((edge) => [edge.key, edge]),
  );
  const currentEdges = new Map(
    certainPathEdges(change.currentPath).map((edge) => [edge.key, edge]),
  );
  const removedEdges = [...previousEdges.values()].filter((edge) => !currentEdges.has(edge.key));
  const addedEdges = [...currentEdges.values()].filter((edge) => !previousEdges.has(edge.key));
  const removedEdgeKeys = new Set(removedEdges.map(({ key }) => key));

  let overlayPriority = 0;
  // Removed entities are deliberately first: tight output limits must retain
  // as much of the otherwise invisible ghost topology as possible.
  for (const edge of [...removedEdges, ...addedEdges]) {
    const link = ensureLink(links, edge);
    link.overlayPriority = Math.min(link.overlayPriority, overlayPriority);
    link.changeState = removedEdgeKeys.has(edge.key) ? "removed" : "added";
    markOverlayNode(nodes, edge.source, overlayPriority);
    markOverlayNode(nodes, edge.target, overlayPriority);
    overlayPriority += 1;
  }

  for (const asn of [...previousAsns, ...currentAsns]) {
    markOverlayNode(nodes, asn, overlayPriority);
    overlayPriority += 1;
  }

  for (const asn of new Set([...previousAsns, ...currentAsns])) {
    const node = ensureNode(nodes, asn);
    if (!currentAsnSet.has(asn)) node.changeState = "removed";
    else if (!previousAsnSet.has(asn)) node.changeState = "added";
    else node.changeState = "unchanged";
  }
}

function comparePriority(
  left: { overlayPriority: number; activePriority: number },
  right: { overlayPriority: number; activePriority: number },
): number {
  if (left.overlayPriority !== right.overlayPriority) {
    return left.overlayPriority < right.overlayPriority ? -1 : 1;
  }
  if (left.activePriority !== right.activePriority) {
    return left.activePriority < right.activePriority ? -1 : 1;
  }
  return 0;
}

function toNodePayload(node: NodeAccumulator): GraphNodePayload {
  return {
    id: asNodeId(node.asn),
    asn: node.asn,
    label: `AS${node.asn}`,
    routeCount: node.routeCount,
    changeState: node.changeState,
    active: node.routeCount > 0,
  };
}

function toLinkPayload(link: LinkAccumulator): GraphLinkPayload {
  return {
    key: link.key,
    source: asNodeId(link.sourceAsn),
    target: asNodeId(link.targetAsn),
    sourceAsn: link.sourceAsn,
    targetAsn: link.targetAsn,
    routeCount: link.routeCount,
    changeState: link.changeState,
    active: link.routeCount > 0,
  };
}

/**
 * Build a bounded, deterministic AS-only projection of current route state.
 *
 * Counts are support counts over the included (most recently observed)
 * routes. A selected historical change is an overlay: it never changes active
 * counts, while removed entities remain available as zero-support ghosts.
 */
export function buildTopologyGraph(
  routes: readonly TrackedRoute[],
  selectedChange: TopologyChange | null = null,
  options: GraphBuildOptions = {},
): GraphPayload {
  const limits = resolveLimits(options);
  const includedRoutes = [...routes].sort(compareRoutesByRecency).slice(0, limits.maxRoutes);
  const nodeMap = new Map<number, NodeAccumulator>();
  const linkMap = new Map<string, LinkAccumulator>();

  addActiveRoutes(includedRoutes, nodeMap, linkMap);
  if (selectedChange) addChangeOverlay(selectedChange, nodeMap, linkMap);

  const selectedNodes = [...nodeMap.values()]
    .sort((left, right) => comparePriority(left, right) || left.asn - right.asn)
    .slice(0, limits.maxNodes);
  const selectedNodeIds = new Set(selectedNodes.map(({ asn }) => asNodeId(asn)));
  const selectedLinks = [...linkMap.values()]
    .sort((left, right) => comparePriority(left, right) || left.key.localeCompare(right.key))
    .filter(
      ({ sourceAsn, targetAsn }) =>
        selectedNodeIds.has(asNodeId(sourceAsn)) && selectedNodeIds.has(asNodeId(targetAsn)),
    )
    .slice(0, limits.maxEdges);

  const routesMeta = {
    included: includedRoutes.length,
    total: Math.max(routes.length, options.totalRouteCount ?? routes.length),
  };
  const nodesMeta = { included: selectedNodes.length, total: nodeMap.size };
  const linksMeta = { included: selectedLinks.length, total: linkMap.size };

  return {
    nodes: selectedNodes.map(toNodePayload),
    links: selectedLinks.map(toLinkPayload),
    meta: {
      truncated:
        routesMeta.included < routesMeta.total ||
        nodesMeta.included < nodesMeta.total ||
        linksMeta.included < linksMeta.total,
      selectedChangeSequence: selectedChange?.sequence ?? null,
      routes: routesMeta,
      nodes: nodesMeta,
      links: linksMeta,
    },
  };
}
