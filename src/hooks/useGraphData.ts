import { useEffect, useRef, useState } from "react";
import type { PersistedUpdate } from "../db/indexedDb";
import type { GraphPayload, GraphWorkerCommand, GraphWorkerEvent } from "../workers/messages";

interface GraphDataResult {
  graph: GraphPayload;
  isComputing: boolean;
}

const EMPTY_GRAPH: GraphPayload = { nodes: [], links: [] };

export function useGraphData(updates: PersistedUpdate[]): GraphDataResult {
  const workerRef = useRef<Worker | null>(null);
  const latestUpdatesRef = useRef<PersistedUpdate[]>(updates);
  const requestCounterRef = useRef(0);
  const latestRequestRef = useRef(0);
  const [graph, setGraph] = useState<GraphPayload>(EMPTY_GRAPH);
  const [isComputing, setIsComputing] = useState(false);

  const nextRequestId = () => {
    requestCounterRef.current += 1;
    latestRequestRef.current = requestCounterRef.current;
    return requestCounterRef.current;
  };

  useEffect(() => {
    latestUpdatesRef.current = updates;
    const worker = workerRef.current;
    if (!worker) {
      return;
    }
    if (updates.length === 0) {
      setGraph(EMPTY_GRAPH);
      setIsComputing(false);
      const requestId = nextRequestId();
      const command: GraphWorkerCommand = { type: "reset", requestId };
      worker.postMessage(command);
      return;
    }
    setIsComputing(true);
    const requestId = nextRequestId();
    const command: GraphWorkerCommand = { type: "build", updates, requestId };
    worker.postMessage(command);
  }, [updates]);

  useEffect(() => {
    const worker = new Worker(new URL("../workers/graphWorker.ts", import.meta.url), {
      type: "module",
    });
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
    };

    worker.addEventListener("message", handleMessage);

    const initialUpdates = latestUpdatesRef.current;
    if (initialUpdates.length > 0) {
      setIsComputing(true);
      const requestId = nextRequestId();
      worker.postMessage({ type: "build", updates: initialUpdates, requestId });
    } else {
      const requestId = nextRequestId();
      worker.postMessage({ type: "reset", requestId });
    }

    return () => {
      worker.removeEventListener("message", handleMessage);
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  return { graph, isComputing };
}
