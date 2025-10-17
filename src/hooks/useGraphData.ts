import { useCallback, useEffect, useRef, useState } from "react";
import type { GraphPayload, GraphWorkerCommand, GraphWorkerEvent } from "../workers/messages";
import type { RipeUpdate } from "../utils/ris";

interface GraphDataResult {
  graph: GraphPayload;
  isComputing: boolean;
  error: string | null;
}

const EMPTY_GRAPH: GraphPayload = { nodes: [], links: [] };
const GRAPH_BUILD_INTERVAL_MS = 1500;

export function useGraphData(updates: RipeUpdate[]): GraphDataResult {
  const workerRef = useRef<Worker | null>(null);
  const latestUpdatesRef = useRef<RipeUpdate[]>(updates);
  const requestCounterRef = useRef(0);
  const latestRequestRef = useRef(0);
  const scheduledBuildRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [graph, setGraph] = useState<GraphPayload>(EMPTY_GRAPH);
  const [isComputing, setIsComputing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearScheduledBuild = useCallback(() => {
    if (scheduledBuildRef.current !== null) {
      clearTimeout(scheduledBuildRef.current);
      scheduledBuildRef.current = null;
    }
  }, []);

  const nextRequestId = useCallback(() => {
    requestCounterRef.current += 1;
    latestRequestRef.current = requestCounterRef.current;
    return requestCounterRef.current;
  }, []);

  const sendGraphCommand = useCallback(
    (updatesToSend: RipeUpdate[]) => {
      const worker = workerRef.current;
      if (!worker) {
        setIsComputing(false);
        return;
      }

      const requestId = nextRequestId();
      if (updatesToSend.length === 0) {
        setGraph(EMPTY_GRAPH);
        setIsComputing(false);
        const command: GraphWorkerCommand = { type: "reset", requestId };
        worker.postMessage(command);
        return;
      }

      setIsComputing(true);
      const command: GraphWorkerCommand = { type: "build", updates: updatesToSend, requestId };
      worker.postMessage(command);
    },
    [nextRequestId],
  );

  useEffect(() => {
    latestUpdatesRef.current = updates;
    const worker = workerRef.current;
    if (!worker) {
      setIsComputing(false);
      return;
    }

    if (updates.length === 0) {
      clearScheduledBuild();
      sendGraphCommand([]);
      return;
    }

    setIsComputing(true);

    if (scheduledBuildRef.current !== null) {
      return;
    }

    scheduledBuildRef.current = setTimeout(() => {
      scheduledBuildRef.current = null;
      sendGraphCommand(latestUpdatesRef.current);
    }, GRAPH_BUILD_INTERVAL_MS);
  }, [sendGraphCommand, updates, clearScheduledBuild]);

  useEffect(() => {
    if (typeof Worker === "undefined") {
      setGraph(EMPTY_GRAPH);
      setIsComputing(false);
      setError("Web Workers are not supported. Graph view is unavailable in this environment.");
      return () => {
        workerRef.current = null;
      };
    }

    let worker: Worker;
    try {
      worker = new Worker(new URL("../workers/graphWorker.ts", import.meta.url), {
        type: "module",
      });
    } catch (workerError) {
      const message = workerError instanceof Error ? workerError.message : "Unknown error starting graph worker.";
      setGraph(EMPTY_GRAPH);
      setIsComputing(false);
      setError(`Failed to start graph worker: ${message}`);
      workerRef.current = null;
      return () => {
        workerRef.current = null;
      };
    }

    setError(null);
    workerRef.current = worker;

    const handleMessage = (event: MessageEvent<GraphWorkerEvent>) => {
      const message = event.data;
      if (!message || message.type !== "graph") {
        return;
      }
      if (message.requestId !== latestRequestRef.current) {
        return;
      }
      setGraph(message.graph);
      setIsComputing(false);
      setError(null);
    };

    const handleError = (event: ErrorEvent) => {
      const details = event.message || (event.error instanceof Error ? event.error.message : String(event.error ?? ""));
      setIsComputing(false);
      setError(`Graph worker error: ${details || "Unknown error"}`);
    };

    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);

    const initialUpdates = latestUpdatesRef.current;
    if (initialUpdates.length > 0) {
      sendGraphCommand(initialUpdates);
    } else {
      sendGraphCommand([]);
    }

    return () => {
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
      worker.terminate();
      workerRef.current = null;
      clearScheduledBuild();
    };
  }, [clearScheduledBuild, sendGraphCommand]);

  useEffect(
    () => () => {
      clearScheduledBuild();
    },
    [clearScheduledBuild],
  );

  return { graph, isComputing, error };
}
