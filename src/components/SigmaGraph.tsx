import { useEffect, useRef } from "react";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { assign as assignRandom } from "graphology-layout/random";
import Sigma from "sigma";

import type { GraphLinkPayload, GraphNodePayload } from "../workers/messages";
import { cn } from "../lib/utils";

const NODE_COLORS: Record<GraphNodePayload["type"], string> = {
  peer: "#c4b5fd",
  prefix: "#8b5cf6",
  origin: "#34d399",
};

const EDGE_COLORS: Record<GraphLinkPayload["kind"], string> = {
  announce: "rgba(168, 85, 247, 0.6)",
  withdraw: "rgba(248, 113, 113, 0.6)",
};

export interface SigmaGraphProps {
  nodes: GraphNodePayload[];
  links: GraphLinkPayload[];
  className?: string;
}

export function SigmaGraph({ nodes, links, className }: SigmaGraphProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef(
    new Graph({
      type: "undirected",
      multi: true,
      allowSelfLoops: false,
    }),
  );
  const rendererRef = useRef<Sigma | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const graph = graphRef.current;
    let resizeObserver: ResizeObserver | null = null;
    let resizeRetryId: number | null = null;

    const handleResize = () => {
      rendererRef.current?.refresh();
    };

    const initializeRenderer = () => {
      const element = containerRef.current;
      if (!element || rendererRef.current) return rendererRef.current !== null;
      if (element.clientHeight === 0 || element.clientWidth === 0) return false;

      const renderer = new Sigma(graph, element, {
        renderLabels: true,
        labelDensity: 0.7,
        labelGridCellSize: 60,
        allowInvalidContainer: false,
      });

      rendererRef.current = renderer;
      renderer.refresh();
      window.addEventListener("resize", handleResize);

      return true;
    };

    if (!initializeRenderer()) {
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => {
          if (initializeRenderer()) {
            resizeObserver?.disconnect();
            resizeObserver = null;
          }
        });
        resizeObserver.observe(container);
      } else {
        const attemptInitialization = () => {
          if (initializeRenderer()) {
            if (resizeRetryId !== null) {
              cancelAnimationFrame(resizeRetryId);
              resizeRetryId = null;
            }
            return;
          }
          resizeRetryId = requestAnimationFrame(attemptInitialization);
        };

        resizeRetryId = requestAnimationFrame(attemptInitialization);
      }
    }

    return () => {
      resizeObserver?.disconnect();
      if (resizeRetryId !== null) {
        cancelAnimationFrame(resizeRetryId);
      }
      window.removeEventListener("resize", handleResize);
      rendererRef.current?.kill();
      rendererRef.current = null;
      graph.clear();
    };
  }, []);

  useEffect(() => {
    const graph = graphRef.current;
    const renderer = rendererRef.current;
    graph.clear();

    if (nodes.length === 0) {
      renderer?.refresh();
      return;
    }

    for (const node of nodes) {
      const size = 6 + Math.log1p(node.count) * 2;
      graph.addNode(node.id, {
        label: node.label,
        type: node.type,
        count: node.count,
        size,
        color: NODE_COLORS[node.type],
        x: 0,
        y: 0,
      });
    }

    for (const link of links) {
      if (!graph.hasNode(link.source) || !graph.hasNode(link.target)) continue;
      const key = `${link.source}|${link.target}|${link.relation}|${link.kind}`;
      const size = 1.4 + Math.log1p(link.count) * 1.2;
      if (graph.hasEdge(key)) {
        graph.setEdgeAttributes(key, {
          size,
          color: EDGE_COLORS[link.kind],
          kind: link.kind,
          relation: link.relation,
          count: link.count,
        });
      } else {
        graph.addEdgeWithKey(key, link.source, link.target, {
          size,
          color: EDGE_COLORS[link.kind],
          kind: link.kind,
          relation: link.relation,
          count: link.count,
        });
      }
    }

    assignRandom(graph, { scale: 1 });
    forceAtlas2.assign(graph, {
      iterations: Math.min(250, 30 + graph.order * 2),
      settings: {
        slowDown: 10,
        gravity: 0.9,
        scalingRatio: 6,
        edgeWeightInfluence: 0.4,
      },
    });

    renderer?.refresh();
    renderer?.getCamera().animatedReset({ duration: 800 });
  }, [nodes, links]);

  return <div ref={containerRef} className={cn("h-full w-full", className)} />;
}

export default SigmaGraph;
