import { useCallback, useEffect, useRef, useState } from "react";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import Sigma from "sigma";

import { cn } from "../lib/utils";
import type { GraphLinkPayload, GraphNodePayload } from "../workers/messages";

const NODE_COLORS: Record<GraphNodePayload["changeState"], string> = {
  unchanged: "#67e8f9",
  added: "#4ade80",
  removed: "#fb7185",
};

const EDGE_COLORS: Record<GraphLinkPayload["changeState"], string> = {
  unchanged: "rgba(71, 85, 105, 0.72)",
  added: "rgba(74, 222, 128, 0.9)",
  removed: "rgba(251, 113, 133, 0.58)",
};

const MAX_NEIGHBORS_FOR_PLACEMENT = 4;

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function hashString(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function hashUnit(value: string): number {
  return hashString(value) / 4_294_967_295;
}

function finiteCoordinate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function graphSpread(graph: Graph, retainedNodeIds: ReadonlySet<string>): number {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const nodeId of retainedNodeIds) {
    if (!graph.hasNode(nodeId)) continue;
    const x = finiteCoordinate(graph.getNodeAttribute(nodeId, "x"));
    const y = finiteCoordinate(graph.getNodeAttribute(nodeId, "y"));
    if (x === null || y === null) continue;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  if (!Number.isFinite(minX)) return 2;
  return Math.max(2, maxX - minX, maxY - minY);
}

function deterministicPosition(
  nodeId: string,
  neighborIds: readonly string[],
  graph: Graph,
  spread: number,
): { x: number; y: number } {
  let neighborX = 0;
  let neighborY = 0;
  let positionedNeighbors = 0;

  for (const neighborId of [...neighborIds].sort()) {
    if (!graph.hasNode(neighborId)) continue;
    const x = finiteCoordinate(graph.getNodeAttribute(neighborId, "x"));
    const y = finiteCoordinate(graph.getNodeAttribute(neighborId, "y"));
    if (x === null || y === null) continue;
    neighborX += x;
    neighborY += y;
    positionedNeighbors += 1;
    if (positionedNeighbors >= MAX_NEIGHBORS_FOR_PLACEMENT) break;
  }

  const angle = hashUnit(`${nodeId}:angle`) * Math.PI * 2;
  if (positionedNeighbors > 0) {
    const offset = Math.max(0.08, spread * (0.018 + hashUnit(`${nodeId}:offset`) * 0.025));
    return {
      x: neighborX / positionedNeighbors + Math.cos(angle) * offset,
      y: neighborY / positionedNeighbors + Math.sin(angle) * offset,
    };
  }

  const radius = spread * (0.22 + hashUnit(`${nodeId}:radius`) * 0.28);
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

function nodeAttributes(node: GraphNodePayload): Record<string, unknown> {
  const changeMarker =
    node.changeState === "added" ? " +" : node.changeState === "removed" ? " ×" : "";
  return {
    asn: node.asn,
    label: `${node.label}${changeMarker}`,
    routeCount: node.routeCount,
    changeState: node.changeState,
    active: node.active,
    size: (node.active ? 5 : 3.8) + Math.log1p(node.routeCount) * 1.35,
    color: NODE_COLORS[node.changeState],
    highlighted: node.changeState !== "unchanged",
    forceLabel: node.changeState !== "unchanged",
    zIndex: node.changeState === "unchanged" ? 1 : 3,
    type: "circle",
  };
}

function edgeAttributes(link: GraphLinkPayload): Record<string, unknown> {
  return {
    label: link.changeState === "unchanged" ? "" : link.changeState,
    routeCount: link.routeCount,
    changeState: link.changeState,
    active: link.active,
    size: (link.active ? 1.15 : 0.75) + Math.log1p(link.routeCount) * 0.72,
    color: EDGE_COLORS[link.changeState],
    forceLabel: link.changeState !== "unchanged",
    zIndex: link.changeState === "unchanged" ? 0 : 2,
    type: "line",
    weight: Math.max(1, Math.log1p(link.routeCount)),
  };
}

function buildAdjacency(links: readonly GraphLinkPayload[]): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const link of links) {
    if (link.source === link.target) continue;
    const sourceNeighbors = adjacency.get(link.source) ?? [];
    sourceNeighbors.push(link.target);
    adjacency.set(link.source, sourceNeighbors);
    const targetNeighbors = adjacency.get(link.target) ?? [];
    targetNeighbors.push(link.source);
    adjacency.set(link.target, targetNeighbors);
  }
  return adjacency;
}

function synchronizeGraph(
  graph: Graph,
  nodes: readonly GraphNodePayload[],
  links: readonly GraphLinkPayload[],
): boolean {
  const nextNodes = new Map(nodes.map((node) => [node.id, node]));
  const nextLinks = new Map(
    links
      .filter(
        (link) =>
          link.source !== link.target && nextNodes.has(link.source) && nextNodes.has(link.target),
      )
      .map((link) => [link.key, link]),
  );
  const nextNodeIds = new Set(nextNodes.keys());
  const adjacency = buildAdjacency([...nextLinks.values()]);
  const newNodeIds = [...nextNodeIds].filter((nodeId) => !graph.hasNode(nodeId)).sort();
  const spread = graphSpread(graph, nextNodeIds);
  let topologyChanged = false;

  for (const edgeKey of graph.edges()) {
    if (nextLinks.has(edgeKey)) continue;
    graph.dropEdge(edgeKey);
    topologyChanged = true;
  }

  for (const nodeId of newNodeIds) {
    const node = nextNodes.get(nodeId);
    if (!node) continue;
    const position = deterministicPosition(nodeId, adjacency.get(nodeId) ?? [], graph, spread);
    graph.addNode(nodeId, { ...nodeAttributes(node), ...position });
    topologyChanged = true;
  }

  for (const [nodeId, node] of nextNodes) {
    if (!graph.hasNode(nodeId)) continue;
    // Deliberately merge only display/domain attributes: the layout's x/y
    // coordinates stay untouched for nodes that survive an update.
    graph.mergeNodeAttributes(nodeId, nodeAttributes(node));
  }

  for (const nodeId of graph.nodes()) {
    if (nextNodeIds.has(nodeId)) continue;
    graph.dropNode(nodeId);
    topologyChanged = true;
  }

  for (const [edgeKey, link] of nextLinks) {
    const attributes = edgeAttributes(link);
    if (graph.hasEdge(edgeKey)) {
      graph.mergeEdgeAttributes(edgeKey, attributes);
    } else {
      graph.addEdgeWithKey(edgeKey, link.source, link.target, attributes);
      topologyChanged = true;
    }
  }

  return topologyChanged;
}

function reducedMotionDuration(): number {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : 220;
}

export interface SigmaGraphProps {
  nodes: GraphNodePayload[];
  links: GraphLinkPayload[];
  className?: string;
  onError?: (error: Error) => void;
  onNodeSelect?: (node: GraphNodePayload) => void;
  onReady?: () => void;
}

export function SigmaGraph({
  nodes,
  links,
  className,
  onError,
  onNodeSelect,
  onReady,
}: SigmaGraphProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [graph] = useState(
    () =>
      new Graph({
        type: "undirected",
        multi: false,
        allowSelfLoops: false,
      }),
  );
  const rendererRef = useRef<Sigma | null>(null);
  const initialFitDoneRef = useRef(false);
  const layoutFrameRef = useRef<number | null>(null);
  const fitFrameRef = useRef<number | null>(null);
  const onErrorRef = useRef(onError);
  const onNodeSelectRef = useRef(onNodeSelect);
  const onReadyRef = useRef(onReady);
  const readyNotifiedRef = useRef(false);
  const rendererHadErrorRef = useRef(false);
  const nodePayloadsRef = useRef(new Map<string, GraphNodePayload>());

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    onNodeSelectRef.current = onNodeSelect;
  }, [onNodeSelect]);

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  const reportError = useCallback((error: unknown) => {
    rendererHadErrorRef.current = true;
    onErrorRef.current?.(toError(error));
  }, []);

  const reportReady = useCallback(() => {
    if (readyNotifiedRef.current && !rendererHadErrorRef.current) return;
    readyNotifiedRef.current = true;
    rendererHadErrorRef.current = false;
    try {
      onReadyRef.current?.();
    } catch (error) {
      reportError(error);
    }
  }, [reportError]);

  const fitGraph = useCallback(
    (markInitialFit = false) => {
      const renderer = rendererRef.current;
      if (!renderer || graph.order === 0) return;
      try {
        renderer.refresh();
        reportReady();
        void renderer
          .getCamera()
          .animatedReset({ duration: reducedMotionDuration() })
          .catch(reportError);
        if (markInitialFit) initialFitDoneRef.current = true;
      } catch (error) {
        reportError(error);
      }
    },
    [graph, reportError, reportReady],
  );

  const scheduleInitialFit = useCallback(() => {
    if (
      initialFitDoneRef.current ||
      fitFrameRef.current !== null ||
      layoutFrameRef.current !== null
    )
      return;
    fitFrameRef.current = requestAnimationFrame(() => {
      fitFrameRef.current = null;
      fitGraph(true);
    });
  }, [fitGraph]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let resizeObserver: ResizeObserver | null = null;
    let resizeRetryId: number | null = null;
    let initializationFailed = false;
    let nodeClickListener: ((event: { node: string }) => void) | null = null;

    const initializeRenderer = (): boolean => {
      const element = containerRef.current;
      if (rendererRef.current || initializationFailed) return true;
      if (!element || element.clientHeight === 0 || element.clientWidth === 0) return false;

      try {
        const renderer = new Sigma(graph, element, {
          renderLabels: true,
          renderEdgeLabels: true,
          labelDensity: 0.65,
          labelGridCellSize: 72,
          labelRenderedSizeThreshold: 7,
          edgeLabelSize: 10,
          hideEdgesOnMove: true,
          hideLabelsOnMove: true,
          zIndex: true,
          minCameraRatio: 0.06,
          maxCameraRatio: 8,
          allowInvalidContainer: false,
        });

        nodeClickListener = ({ node }) => {
          const payload = nodePayloadsRef.current.get(node);
          if (!payload) return;
          try {
            onNodeSelectRef.current?.(payload);
          } catch (error) {
            reportError(error);
          }
        };
        renderer.on("clickNode", nodeClickListener);
        rendererRef.current = renderer;
        renderer.refresh();
        reportReady();
        if (graph.order > 0) scheduleInitialFit();
        return true;
      } catch (error) {
        initializationFailed = true;
        reportError(error);
        return true;
      }
    };

    const handleResize = () => {
      const element = containerRef.current;
      // Mobile tabs intentionally collapse this container to 0 × 0. Sigma's
      // strict container validation must not turn that normal state into an
      // application error; ResizeObserver will call us again when it is shown.
      if (!element || element.clientWidth === 0 || element.clientHeight === 0) return;
      if (!initializeRenderer()) return;
      try {
        const renderer = rendererRef.current;
        if (!renderer) return;
        renderer.resize();
        renderer.refresh();
        reportReady();
      } catch (error) {
        reportError(error);
      }
    };

    initializeRenderer();
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(handleResize);
      resizeObserver.observe(container);
    } else if (!rendererRef.current && !initializationFailed) {
      const attemptInitialization = () => {
        if (initializeRenderer()) {
          resizeRetryId = null;
          return;
        }
        resizeRetryId = requestAnimationFrame(attemptInitialization);
      };
      resizeRetryId = requestAnimationFrame(attemptInitialization);
    }
    window.addEventListener("resize", handleResize);

    return () => {
      resizeObserver?.disconnect();
      if (resizeRetryId !== null) cancelAnimationFrame(resizeRetryId);
      if (layoutFrameRef.current !== null) cancelAnimationFrame(layoutFrameRef.current);
      if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current);
      window.removeEventListener("resize", handleResize);
      const renderer = rendererRef.current;
      if (renderer && nodeClickListener) renderer.off("clickNode", nodeClickListener);
      renderer?.kill();
      rendererRef.current = null;
      graph.clear();
    };
  }, [graph, reportError, reportReady, scheduleInitialFit]);

  useEffect(() => {
    try {
      nodePayloadsRef.current = new Map(nodes.map((node) => [node.id, node]));
      const topologyChanged = synchronizeGraph(graph, nodes, links);
      if (graph.order === 0) {
        initialFitDoneRef.current = false;
        if (layoutFrameRef.current !== null) {
          cancelAnimationFrame(layoutFrameRef.current);
          layoutFrameRef.current = null;
        }
        rendererRef.current?.refresh();
        return;
      }

      const layoutWithinFrameBudget = graph.order <= 500 && graph.size <= 750;
      if (topologyChanged && layoutWithinFrameBudget && graph.order > 1 && graph.size > 0) {
        if (layoutFrameRef.current !== null) cancelAnimationFrame(layoutFrameRef.current);
        layoutFrameRef.current = requestAnimationFrame(() => {
          layoutFrameRef.current = null;
          try {
            const iterations =
              graph.order <= 60 && graph.size <= 100
                ? 6
                : graph.order <= 180 && graph.size <= 300
                  ? 3
                  : 1;
            forceAtlas2.assign(graph, {
              iterations,
              getEdgeWeight: "weight",
              settings: {
                barnesHutOptimize: graph.order >= 100,
                slowDown: 12,
                gravity: 0.8,
                scalingRatio: 7,
                edgeWeightInfluence: 0.25,
              },
            });
            const renderer = rendererRef.current;
            if (renderer) {
              renderer.refresh();
              reportReady();
            }
          } catch (error) {
            reportError(error);
          } finally {
            scheduleInitialFit();
          }
        });
      }

      const renderer = rendererRef.current;
      if (renderer) {
        renderer.refresh();
        reportReady();
      }
      scheduleInitialFit();
    } catch (error) {
      reportError(error);
    }
  }, [graph, links, nodes, reportError, reportReady, scheduleInitialFit]);

  const zoomIn = () => {
    try {
      void rendererRef.current
        ?.getCamera()
        .animatedZoom({ factor: 1.5, duration: reducedMotionDuration() })
        .catch(reportError);
    } catch (error) {
      reportError(error);
    }
  };

  const zoomOut = () => {
    try {
      void rendererRef.current
        ?.getCamera()
        .animatedUnzoom({ factor: 1.5, duration: reducedMotionDuration() })
        .catch(reportError);
    } catch (error) {
      reportError(error);
    }
  };

  return (
    <div className={cn("relative h-full min-h-0 w-full overflow-hidden", className)}>
      <div
        ref={containerRef}
        className="absolute inset-0 h-full w-full"
        role="img"
        aria-label={`Partial live AS topology graph with ${nodes.length} nodes and ${links.length} links. Added topology is green and removed topology is pink.`}
      />
      <div
        className="absolute bottom-3 right-3 z-10 flex gap-1 rounded-xl border border-slate-700/80 bg-slate-950/85 p-1 shadow-lg backdrop-blur"
        role="group"
        aria-label="Topology graph navigation"
      >
        <button
          type="button"
          className="grid min-h-11 min-w-11 place-items-center rounded-lg text-lg font-semibold text-cyan-100 transition hover:bg-cyan-400/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
          onClick={zoomIn}
          aria-label="Zoom in"
          title="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          className="grid min-h-11 min-w-11 place-items-center rounded-lg text-lg font-semibold text-cyan-100 transition hover:bg-cyan-400/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
          onClick={zoomOut}
          aria-label="Zoom out"
          title="Zoom out"
        >
          −
        </button>
        <button
          type="button"
          className="grid min-h-11 min-w-11 place-items-center rounded-lg font-mono text-xs font-semibold uppercase text-cyan-100 transition hover:bg-cyan-400/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
          onClick={() => fitGraph(false)}
          aria-label="Fit topology to view"
          title="Fit topology to view"
        >
          Fit
        </button>
      </div>
    </div>
  );
}

export default SigmaGraph;
