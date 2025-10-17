import type { RipeUpdate, UpdateKind } from "../utils/ris";

export type WorkerConnectionState = "connecting" | "connected" | "error";

export type FetchWorkerCommand =
  | { type: "start" }
  | { type: "stop" }
  | { type: "reconnect" };

export type FetchWorkerEvent =
  | { type: "status"; status: WorkerConnectionState }
  | { type: "message"; payload: string }
  | { type: "error"; error: string }
  | { type: "closed" };

export type ParseWorkerCommand = { type: "parse"; payload: string };

export type ParseWorkerEvent =
  | { type: "updates"; updates: RipeUpdate[] }
  | { type: "error"; error: string };

export type GraphWorkerCommand =
  | { type: "build"; updates: RipeUpdate[]; requestId: number }
  | { type: "reset"; requestId: number };

export interface GraphNodePayload {
  id: string;
  label: string;
  type: "peer" | "prefix" | "origin";
  count: number;
}

export interface GraphLinkPayload {
  source: string;
  target: string;
  kind: UpdateKind;
  relation: "peer-prefix" | "origin-prefix" | "peer-origin";
  count: number;
}

export interface GraphPayload {
  nodes: GraphNodePayload[];
  links: GraphLinkPayload[];
}

export type GraphWorkerEvent = { type: "graph"; graph: GraphPayload; requestId: number };
