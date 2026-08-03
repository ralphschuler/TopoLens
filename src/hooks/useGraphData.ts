import { useCallback, useEffect, useRef, useState } from "react";

import type { TopologyChange, TrackedRoute } from "../topology/routeTracker";
import type { GraphPayload, GraphWorkerCommand, GraphWorkerEvent } from "../workers/messages";

export interface GraphDataResult {
  graph: GraphPayload;
  isComputing: boolean;
  error: string | null;
}

export const EMPTY_GRAPH: GraphPayload = {
  nodes: [],
  links: [],
  meta: {
    truncated: false,
    selectedChangeSequence: null,
    routes: { included: 0, total: 0 },
    nodes: { included: 0, total: 0 },
    links: { included: 0, total: 0 },
  },
};

const GRAPH_BUILD_INTERVAL_MS = 1_500;
const MAX_TRANSFERRED_ROUTES = 2_000;
const UNSUPPORTED_WORKER_ERROR =
  "Web Workers are not supported. Graph view is unavailable in this environment.";

/**
 * Build the current AS topology off the main thread.
 *
 * Route bursts are coalesced to at most one worker build per interval. A
 * selected historical change is sent as an optional overlay. Only the newest
 * request may update React state, so slow replies cannot roll the graph back.
 */
export function useGraphData(
  routes: TrackedRoute[],
  selectedChange: TopologyChange | null = null,
): GraphDataResult {
  const workersSupported = typeof Worker !== "undefined";
  const workerRef = useRef<Worker | null>(null);
  const latestRoutesRef = useRef<TrackedRoute[]>(routes);
  const latestSelectedChangeRef = useRef<TopologyChange | null>(selectedChange);
  const requestCounterRef = useRef(0);
  const latestRequestRef = useRef(0);
  const scheduledBuildRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastBuildAtRef = useRef<number | null>(null);
  const [graph, setGraph] = useState<GraphPayload>(EMPTY_GRAPH);
  const [isComputing, setIsComputing] = useState(false);
  const [error, setError] = useState<string | null>(() =>
    workersSupported ? null : UNSUPPORTED_WORKER_ERROR,
  );

  const clearScheduledBuild = useCallback(() => {
    if (scheduledBuildRef.current === null) return;
    clearTimeout(scheduledBuildRef.current);
    scheduledBuildRef.current = null;
  }, []);

  const invalidatePendingResponse = useCallback(() => {
    // Worker request identifiers start at one. Zero means that an input newer
    // than the in-flight request is waiting to be dispatched.
    latestRequestRef.current = 0;
  }, []);

  const dispatchLatestBuild = useCallback(() => {
    const worker = workerRef.current;
    if (!worker) {
      setIsComputing(false);
      return;
    }

    const requestId = requestCounterRef.current + 1;
    requestCounterRef.current = requestId;
    latestRequestRef.current = requestId;
    lastBuildAtRef.current = Date.now();

    const allRoutes = latestRoutesRef.current;
    // RouteTracker snapshots are LRU-ordered. Clone only the most recently
    // observed slice across the worker boundary to avoid serializing thousands
    // of unused route objects on phones; the full count is preserved in meta.
    const routesToSend =
      allRoutes.length > MAX_TRANSFERRED_ROUTES
        ? allRoutes.slice(-MAX_TRANSFERRED_ROUTES)
        : allRoutes;
    const changeToSend = latestSelectedChangeRef.current;
    const isEmpty = routesToSend.length === 0 && changeToSend === null;
    const command: GraphWorkerCommand = isEmpty
      ? { type: "reset", requestId }
      : {
          type: "build",
          routes: routesToSend,
          totalRouteCount: allRoutes.length,
          selectedChange: changeToSend,
          requestId,
        };

    if (isEmpty) {
      setGraph(EMPTY_GRAPH);
      setIsComputing(false);
    } else {
      setIsComputing(true);
    }

    try {
      worker.postMessage(command);
    } catch (workerError) {
      invalidatePendingResponse();
      setIsComputing(false);
      const details =
        workerError instanceof Error ? workerError.message : String(workerError ?? "Unknown error");
      setError(`Failed to send graph data to the worker: ${details}`);
    }
  }, [invalidatePendingResponse]);

  const scheduleLatestBuild = useCallback(() => {
    if (!workerRef.current) {
      setIsComputing(false);
      return;
    }

    setIsComputing(true);
    if (scheduledBuildRef.current !== null) return;

    const lastBuildAt = lastBuildAtRef.current;
    const elapsed = lastBuildAt === null ? GRAPH_BUILD_INTERVAL_MS : Date.now() - lastBuildAt;
    const delay = Math.max(0, GRAPH_BUILD_INTERVAL_MS - elapsed);
    if (delay === 0) {
      dispatchLatestBuild();
      return;
    }

    scheduledBuildRef.current = setTimeout(() => {
      scheduledBuildRef.current = null;
      dispatchLatestBuild();
    }, delay);
  }, [dispatchLatestBuild]);

  useEffect(() => {
    latestRoutesRef.current = routes;
    latestSelectedChangeRef.current = selectedChange;
    invalidatePendingResponse();

    if (!workerRef.current) {
      setIsComputing(false);
      return;
    }

    if (routes.length === 0 && selectedChange === null) {
      clearScheduledBuild();
      // Defer the state update/worker reset out of the synchronizing effect.
      scheduledBuildRef.current = setTimeout(() => {
        scheduledBuildRef.current = null;
        dispatchLatestBuild();
      }, 0);
      return;
    }

    scheduleLatestBuild();
  }, [
    clearScheduledBuild,
    dispatchLatestBuild,
    invalidatePendingResponse,
    routes,
    scheduleLatestBuild,
    selectedChange,
  ]);

  useEffect(() => {
    if (!workersSupported) return;

    let worker: Worker;
    try {
      worker = new Worker(new URL("../workers/graphWorker.ts", import.meta.url), {
        type: "module",
      });
    } catch (workerError) {
      const message =
        workerError instanceof Error ? workerError.message : "Unknown error starting graph worker.";
      workerRef.current = null;
      const errorTimer = setTimeout(() => {
        setGraph(EMPTY_GRAPH);
        setIsComputing(false);
        setError(`Failed to start graph worker: ${message}`);
      }, 0);
      return () => clearTimeout(errorTimer);
    }

    workerRef.current = worker;

    const handleMessage = (event: MessageEvent<GraphWorkerEvent>) => {
      const message = event.data;
      if (!message || message.type !== "graph") return;
      if (message.requestId !== latestRequestRef.current) return;

      setGraph(message.graph);
      setIsComputing(false);
      setError(null);
    };

    const handleError = (event: ErrorEvent) => {
      invalidatePendingResponse();
      clearScheduledBuild();
      const details =
        event.message ||
        (event.error instanceof Error ? event.error.message : String(event.error ?? ""));
      setIsComputing(false);
      setError(`Graph worker error: ${details || "Unknown error"}`);
    };

    const handleMessageError = () => {
      invalidatePendingResponse();
      clearScheduledBuild();
      setIsComputing(false);
      setError("Graph worker error: the worker response could not be decoded.");
    };

    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    worker.addEventListener("messageerror", handleMessageError);
    scheduledBuildRef.current = setTimeout(() => {
      scheduledBuildRef.current = null;
      dispatchLatestBuild();
    }, 0);

    return () => {
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
      worker.removeEventListener("messageerror", handleMessageError);
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
      invalidatePendingResponse();
      clearScheduledBuild();
    };
  }, [clearScheduledBuild, dispatchLatestBuild, invalidatePendingResponse, workersSupported]);

  return { graph, isComputing, error };
}
