/// <reference lib="webworker" />

import type {
  GraphLinkPayload,
  GraphNodePayload,
  GraphPayload,
  GraphWorkerCommand,
  GraphWorkerEvent,
} from "./messages";
import type { RipeUpdate } from "../utils/ris";

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

interface NodeAccumulator {
  id: string;
  label: string;
  type: GraphNodePayload["type"];
  count: number;
}

interface LinkAccumulator {
  source: string;
  target: string;
  kind: GraphLinkPayload["kind"];
  relation: GraphLinkPayload["relation"];
  count: number;
}

function makeNodeKey(type: GraphNodePayload["type"], identifier: string): string {
  return `${type}:${identifier}`;
}

function trackNode(
  map: Map<string, NodeAccumulator>,
  type: GraphNodePayload["type"],
  identifier: string,
  label: string,
): NodeAccumulator {
  const key = makeNodeKey(type, identifier);
  const existing = map.get(key);
  if (existing) {
    existing.count += 1;
    return existing;
  }
  const created: NodeAccumulator = { id: key, label, type, count: 1 };
  map.set(key, created);
  return created;
}

function trackLink(
  map: Map<string, LinkAccumulator>,
  source: string,
  target: string,
  kind: GraphLinkPayload["kind"],
  relation: GraphLinkPayload["relation"],
): void {
  const key = `${source}->${target}:${relation}:${kind}`;
  const existing = map.get(key);
  if (existing) {
    existing.count += 1;
    return;
  }
  map.set(key, { source, target, kind, relation, count: 1 });
}

function buildGraph(updates: RipeUpdate[]): GraphPayload {
  const nodeMap = new Map<string, NodeAccumulator>();
  const linkMap = new Map<string, LinkAccumulator>();

  for (const update of updates) {
    const peerNode = trackNode(nodeMap, "peer", update.peer, update.peer);
    const prefixNode = trackNode(nodeMap, "prefix", update.prefix, update.prefix);
    trackLink(linkMap, peerNode.id, prefixNode.id, update.kind, "peer-prefix");

    if (typeof update.originAs === "number" && Number.isFinite(update.originAs)) {
      const originLabel = `AS${update.originAs}`;
      const originNode = trackNode(nodeMap, "origin", String(update.originAs), originLabel);
      trackLink(linkMap, originNode.id, prefixNode.id, update.kind, "origin-prefix");
      trackLink(linkMap, peerNode.id, originNode.id, update.kind, "peer-origin");
    }
  }

  const nodes: GraphNodePayload[] = Array.from(nodeMap.values()).map((entry) => ({
    id: entry.id,
    label: entry.label,
    type: entry.type,
    count: entry.count,
  }));

  const links: GraphLinkPayload[] = Array.from(linkMap.values()).map((entry) => ({
    source: entry.source,
    target: entry.target,
    kind: entry.kind,
    relation: entry.relation,
    count: entry.count,
  }));

  return { nodes, links };
}

function postGraph(graph: GraphPayload, requestId: number) {
  const event: GraphWorkerEvent = { type: "graph", graph, requestId };
  ctx.postMessage(event);
}

ctx.onmessage = (event: MessageEvent<GraphWorkerCommand>) => {
  const command = event.data;
  if (!command) return;
  switch (command.type) {
    case "build":
      postGraph(buildGraph(command.updates), command.requestId);
      break;
    case "reset":
      postGraph({ nodes: [], links: [] }, command.requestId);
      break;
    default:
      break;
  }
};

export {};
