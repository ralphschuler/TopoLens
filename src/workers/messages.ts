import type { RipeUpdate } from "../utils/ris";
import type { RisSubscription } from "../utils/subscription";
import type { TopologyChange, TrackedRoute } from "../topology/routeTracker";

export type WorkerConnectionState = "connecting" | "connected" | "reconnecting" | "error";

export type FetchWorkerCommand =
  | { type: "start"; subscription: RisSubscription; generation: number }
  | { type: "stop" }
  | { type: "reconnect" }
  | { type: "configure"; subscription: RisSubscription; generation: number };

type FetchWorkerEventPayload =
  | { type: "status"; status: WorkerConnectionState; retryInMs?: number }
  | { type: "updates"; updates: RipeUpdate[] }
  | { type: "error"; error: string; fatal?: boolean }
  | { type: "subscribed"; subscription: RisSubscription }
  | { type: "closed"; at: number; reason?: string };

/** Every worker event is scoped to exactly one atomic subscription session. */
export type FetchWorkerEvent = FetchWorkerEventPayload & { generation: number };

export type GraphWorkerCommand =
  | {
      type: "build";
      routes: TrackedRoute[];
      /** Full filtered route count before the main-thread transfer cap. */
      totalRouteCount: number;
      selectedChange?: TopologyChange | null;
      requestId: number;
    }
  | { type: "reset"; requestId: number };

export type GraphChangeState = "unchanged" | "added" | "removed";

export interface GraphNodePayload {
  id: string;
  asn: number;
  label: string;
  /** Number of included active routes that contain this ASN. */
  routeCount: number;
  changeState: GraphChangeState;
  /** False only for a historical overlay node with no current route support. */
  active: boolean;
}

export interface GraphLinkPayload {
  /** Canonical, direction-independent numeric edge key (`lower--higher`). */
  key: string;
  source: string;
  target: string;
  sourceAsn: number;
  targetAsn: number;
  /** Number of included active routes that support this adjacency. */
  routeCount: number;
  changeState: GraphChangeState;
  /** False only for a historical overlay edge with no current route support. */
  active: boolean;
}

export interface GraphCountMeta {
  included: number;
  total: number;
}

export interface GraphMetaPayload {
  truncated: boolean;
  selectedChangeSequence: number | null;
  routes: GraphCountMeta;
  /** Counts within the included route slice plus the selected overlay. */
  nodes: GraphCountMeta;
  /** Counts within the included route slice plus the selected overlay. */
  links: GraphCountMeta;
}

export interface GraphPayload {
  nodes: GraphNodePayload[];
  links: GraphLinkPayload[];
  meta: GraphMetaPayload;
}

export type GraphWorkerEvent = { type: "graph"; graph: GraphPayload; requestId: number };
