/// <reference lib="webworker" />

import { buildTopologyGraph } from "../topology/graph";
import type { GraphPayload, GraphWorkerCommand, GraphWorkerEvent } from "./messages";

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

function postGraph(graph: GraphPayload, requestId: number): void {
  const event: GraphWorkerEvent = { type: "graph", graph, requestId };
  ctx.postMessage(event);
}

ctx.onmessage = (event: MessageEvent<GraphWorkerCommand>) => {
  const command = event.data;
  if (!command) return;

  switch (command.type) {
    case "build":
      postGraph(
        buildTopologyGraph(command.routes, command.selectedChange ?? null, {
          totalRouteCount: command.totalRouteCount,
        }),
        command.requestId,
      );
      break;
    case "reset":
      postGraph(buildTopologyGraph([]), command.requestId);
      break;
  }
};

export {};
