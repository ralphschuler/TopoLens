import { describe, expect, it } from "vitest";

import type { AsPathSegment } from "../utils/ris";
import type { TopologyChange, TrackedRoute } from "./routeTracker";
import {
  buildTopologyGraph,
  DEFAULT_MAX_GRAPH_EDGES,
  DEFAULT_MAX_GRAPH_NODES,
  DEFAULT_MAX_GRAPH_ROUTES,
  type GraphBuildOptions,
} from "./graph";

const ASN = (asn: number): AsPathSegment => ({ kind: "asn", asn });
const AS_SET = (...asns: number[]): AsPathSegment => ({ kind: "as-set", asns });

function route(key: string, path: AsPathSegment[], lastObservedAt: number): TrackedRoute {
  const origin = path.at(-1) ?? null;
  return {
    key,
    collector: "rrc00",
    peer: "192.0.2.1",
    prefix: `${key}.example/24`,
    asPath: path,
    asPathDisplay: "fixture",
    origin,
    originAs: origin?.kind === "asn" ? origin.asn : null,
    // Deliberately not used by the graph builder: topology is derived from
    // the structured path so a stale or fabricated edge cannot leak in.
    edges: [{ key: "1--4294967295", source: 1, target: 4_294_967_295 }],
    firstObservedAt: lastObservedAt,
    lastObservedAt,
    firstReceivedAt: lastObservedAt + 1,
    lastReceivedAt: lastObservedAt + 1,
  };
}

function change(
  previousPath: AsPathSegment[],
  currentPath: AsPathSegment[],
  overrides: Partial<TopologyChange> = {},
): TopologyChange {
  return {
    sequence: 7,
    type: "path-changed",
    routeKey: "selected-route",
    timestamp: 7_000,
    receivedAt: 7_001,
    collector: "rrc00",
    peer: "192.0.2.1",
    prefix: "203.0.113.0/24",
    previousPath,
    previousPathDisplay: "previous",
    currentPath,
    currentPathDisplay: "current",
    previousOrigin: previousPath.at(-1) ?? null,
    currentOrigin: currentPath.at(-1) ?? null,
    addedEdges: [],
    removedEdges: [],
    ...overrides,
  };
}

function node(graph: ReturnType<typeof buildTopologyGraph>, asn: number) {
  return graph.nodes.find((candidate) => candidate.asn === asn);
}

function link(graph: ReturnType<typeof buildTopologyGraph>, key: string) {
  return graph.links.find((candidate) => candidate.key === key);
}

describe("buildTopologyGraph", () => {
  it("projects only canonical AS-to-AS adjacencies from active structured paths", () => {
    const graph = buildTopologyGraph([
      route("route-a", [ASN(65000), ASN(65000), ASN(64500), ASN(64496)], 100),
    ]);

    expect(graph.nodes).toEqual([
      {
        id: "as:65000",
        asn: 65000,
        label: "AS65000",
        routeCount: 1,
        changeState: "unchanged",
        active: true,
      },
      {
        id: "as:64500",
        asn: 64500,
        label: "AS64500",
        routeCount: 1,
        changeState: "unchanged",
        active: true,
      },
      {
        id: "as:64496",
        asn: 64496,
        label: "AS64496",
        routeCount: 1,
        changeState: "unchanged",
        active: true,
      },
    ]);
    expect(graph.links).toEqual([
      {
        key: "64500--65000",
        source: "as:64500",
        target: "as:65000",
        sourceAsn: 64500,
        targetAsn: 65000,
        routeCount: 1,
        changeState: "unchanged",
        active: true,
      },
      {
        key: "64496--64500",
        source: "as:64496",
        target: "as:64500",
        sourceAsn: 64496,
        targetAsn: 64500,
        routeCount: 1,
        changeState: "unchanged",
        active: true,
      },
    ]);
    expect(graph.nodes.every(({ id }) => id.startsWith("as:"))).toBe(true);
    expect(JSON.stringify(graph)).not.toContain("prefix:");
    expect(JSON.stringify(graph)).not.toContain("peer:");
    expect(link(graph, "1--4294967295")).toBeUndefined();
  });

  it("aggregates route support once per active route", () => {
    const graph = buildTopologyGraph([
      route("route-a", [ASN(65000), ASN(64500), ASN(64496)], 100),
      route("route-b", [ASN(65000), ASN(64500), ASN(64497)], 200),
      route("route-c", [ASN(65000), ASN(64500), ASN(65000)], 300),
    ]);

    expect(node(graph, 65000)?.routeCount).toBe(3);
    expect(node(graph, 64500)?.routeCount).toBe(3);
    expect(link(graph, "64500--65000")?.routeCount).toBe(3);
    expect(link(graph, "64496--64500")?.routeCount).toBe(1);
    expect(link(graph, "64497--64500")?.routeCount).toBe(1);
  });

  it("keeps AS_SET members as nodes without inventing set attachment or internal edges", () => {
    const graph = buildTopologyGraph([
      route("set-route", [ASN(65000), ASN(64500), AS_SET(64496, 64497), ASN(64495)], 100),
    ]);

    expect(graph.nodes.map(({ asn }) => asn)).toEqual([65000, 64500, 64496, 64497, 64495]);
    expect(graph.links.map(({ key }) => key)).toEqual(["64500--65000"]);
    expect(node(graph, 64496)).toMatchObject({ routeCount: 1, active: true });
    expect(node(graph, 64497)).toMatchObject({ routeCount: 1, active: true });
  });

  it("prioritizes the most recently observed routes and reports route truncation", () => {
    const oldest = route("oldest", [ASN(1), ASN(2)], 100);
    const newest = route("newest", [ASN(5), ASN(6)], 300);
    const middle = route("middle", [ASN(3), ASN(4)], 200);
    const input = [oldest, newest, middle];

    const graph = buildTopologyGraph(input, null, {
      maxRoutes: 2,
      maxNodes: 10,
      maxEdges: 10,
    });

    expect(graph.nodes.map(({ asn }) => asn)).toEqual([5, 6, 3, 4]);
    expect(graph.links.map(({ key }) => key)).toEqual(["5--6", "3--4"]);
    expect(graph.meta).toEqual({
      truncated: true,
      selectedChangeSequence: null,
      routes: { included: 2, total: 3 },
      nodes: { included: 4, total: 4 },
      links: { included: 2, total: 2 },
    });
    expect(input).toEqual([oldest, newest, middle]);
  });

  it("preserves the full route count when the worker input was pre-truncated", () => {
    const graph = buildTopologyGraph(
      [route("newest-a", [ASN(1), ASN(2)], 200), route("newest-b", [ASN(2), ASN(3)], 300)],
      null,
      { totalRouteCount: 5_000 },
    );

    expect(graph.meta.routes).toEqual({ included: 2, total: 5_000 });
    expect(graph.meta.truncated).toBe(true);
  });

  it("enforces node and edge limits without emitting dangling links", () => {
    const graph = buildTopologyGraph(
      [
        route("newest", [ASN(10), ASN(11), ASN(12)], 300),
        route("middle", [ASN(20), ASN(21)], 200),
        route("oldest", [ASN(30), ASN(31)], 100),
      ],
      null,
      { maxRoutes: 3, maxNodes: 4, maxEdges: 2 },
    );

    expect(graph.nodes.map(({ asn }) => asn)).toEqual([10, 11, 12, 20]);
    expect(graph.links.map(({ key }) => key)).toEqual(["10--11", "11--12"]);
    expect(
      graph.links.every(
        ({ source, target }) =>
          graph.nodes.some(({ id }) => id === source) &&
          graph.nodes.some(({ id }) => id === target),
      ),
    ).toBe(true);
    expect(graph.meta).toEqual({
      truncated: true,
      selectedChangeSequence: null,
      routes: { included: 3, total: 3 },
      nodes: { included: 4, total: 7 },
      links: { included: 2, total: 4 },
    });
  });

  it("overlays a selected change and retains removed ghost edges and nodes", () => {
    const selected = change(
      [ASN(65000), ASN(64500), ASN(64496)],
      [ASN(65000), ASN(64501), ASN(64496)],
      {
        addedEdges: [
          { key: "64501--65000", source: 64501, target: 65000 },
          { key: "64496--64501", source: 64496, target: 64501 },
        ],
        removedEdges: [
          { key: "64500--65000", source: 64500, target: 65000 },
          { key: "64496--64500", source: 64496, target: 64500 },
        ],
      },
    );
    const graph = buildTopologyGraph(
      [route("selected-route", [ASN(65000), ASN(64501), ASN(64496)], 1_000)],
      selected,
    );

    expect(node(graph, 64501)).toMatchObject({
      changeState: "added",
      active: true,
      routeCount: 1,
    });
    expect(node(graph, 64500)).toMatchObject({
      changeState: "removed",
      active: false,
      routeCount: 0,
    });
    expect(node(graph, 65000)?.changeState).toBe("unchanged");
    expect(link(graph, "64501--65000")).toMatchObject({
      changeState: "added",
      active: true,
      routeCount: 1,
    });
    expect(link(graph, "64500--65000")).toMatchObject({
      changeState: "removed",
      active: false,
      routeCount: 0,
    });
    expect(graph.meta.selectedChangeSequence).toBe(7);
  });

  it("marks a removed adjacency active when another current route still supports it", () => {
    const selected = change([ASN(1), ASN(2), ASN(3)], [ASN(1), ASN(4), ASN(3)], {
      addedEdges: [
        { key: "1--4", source: 1, target: 4 },
        { key: "3--4", source: 3, target: 4 },
      ],
      removedEdges: [
        { key: "1--2", source: 1, target: 2 },
        { key: "2--3", source: 2, target: 3 },
      ],
    });
    const graph = buildTopologyGraph(
      [
        route("selected-route", [ASN(1), ASN(4), ASN(3)], 300),
        route("other-route", [ASN(1), ASN(2), ASN(3)], 200),
      ],
      selected,
    );

    expect(node(graph, 2)).toMatchObject({
      changeState: "removed",
      active: true,
      routeCount: 1,
    });
    expect(link(graph, "1--2")).toMatchObject({
      changeState: "removed",
      active: true,
      routeCount: 1,
    });
  });

  it("includes removed AS_SET members as isolated ghost nodes", () => {
    const selected = change([ASN(65000), AS_SET(64496, 64497)], [ASN(65000), ASN(64495)]);
    const graph = buildTopologyGraph(
      [route("selected-route", [ASN(65000), ASN(64495)], 300)],
      selected,
    );

    expect(node(graph, 64496)).toMatchObject({
      changeState: "removed",
      active: false,
      routeCount: 0,
    });
    expect(node(graph, 64497)).toMatchObject({
      changeState: "removed",
      active: false,
      routeCount: 0,
    });
    expect(graph.links.map(({ key }) => key)).toEqual(["64495--65000"]);
  });

  it("uses finite hard defaults and truncates oversized input without options", () => {
    expect(DEFAULT_MAX_GRAPH_ROUTES).toBeGreaterThan(0);
    expect(DEFAULT_MAX_GRAPH_NODES).toBeGreaterThan(0);
    expect(DEFAULT_MAX_GRAPH_EDGES).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_MAX_GRAPH_ROUTES)).toBe(true);
    expect(Number.isFinite(DEFAULT_MAX_GRAPH_NODES)).toBe(true);
    expect(Number.isFinite(DEFAULT_MAX_GRAPH_EDGES)).toBe(true);

    const routes = Array.from({ length: DEFAULT_MAX_GRAPH_ROUTES + 1 }, (_, index) =>
      route(`route-${index}`, [ASN(index + 1)], index),
    );
    const graph = buildTopologyGraph(routes);

    expect(graph.meta.routes).toEqual({
      included: DEFAULT_MAX_GRAPH_ROUTES,
      total: DEFAULT_MAX_GRAPH_ROUTES + 1,
    });
    expect(graph.meta.truncated).toBe(true);
    expect(graph.nodes.length).toBeLessThanOrEqual(DEFAULT_MAX_GRAPH_NODES);
    expect(graph.links.length).toBeLessThanOrEqual(DEFAULT_MAX_GRAPH_EDGES);
  });

  it.each([
    { maxRoutes: 0 },
    { maxNodes: -1 },
    { maxEdges: Number.NaN },
    { maxEdges: 1.5 },
  ] as GraphBuildOptions[])("rejects invalid graph limits: %o", (options) => {
    expect(() => buildTopologyGraph([], null, options)).toThrow(/positive integer/i);
  });

  it("returns honest empty metadata", () => {
    expect(buildTopologyGraph([])).toEqual({
      nodes: [],
      links: [],
      meta: {
        truncated: false,
        selectedChangeSequence: null,
        routes: { included: 0, total: 0 },
        nodes: { included: 0, total: 0 },
        links: { included: 0, total: 0 },
      },
    });
  });
});
