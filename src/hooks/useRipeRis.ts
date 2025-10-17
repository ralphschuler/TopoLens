import { useCallback, useEffect, useRef, useState } from "react";
import type { FetchWorkerEvent, FetchWorkerCommand } from "../workers/messages";
import type { RipeUpdate } from "../utils/ris";

export type ConnectionState = "connecting" | "connected" | "error";

export function useRipeRis(limit = 50) {
  const [status, setStatus] = useState<ConnectionState>("connecting");
  const [updates, setUpdates] = useState<RipeUpdate[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetchWorkerRef = useRef<Worker | null>(null);
  const isMountedRef = useRef(true);
  const limitRef = useRef(limit);

  useEffect(() => {
    limitRef.current = limit;
    setUpdates((previous) => previous.slice(0, limit));
  }, [limit]);

  useEffect(() => {
    isMountedRef.current = true;

    const fetchWorker = new Worker(new URL("../workers/fetchWorker.ts", import.meta.url), {
      type: "module",
    });

    fetchWorkerRef.current = fetchWorker;

    const handleFetchMessage = (event: MessageEvent<FetchWorkerEvent>) => {
      const message = event.data;
      if (!message) return;
      switch (message.type) {
        case "status":
          if (!isMountedRef.current) return;
          setStatus(message.status);
          if (message.status === "connected") {
            setError(null);
          }
          break;
        case "updates":
          if (!isMountedRef.current) return;
          if (message.updates.length > 0) {
            setUpdates((previous) => {
              const merged = [...message.updates, ...previous];
              const max = limitRef.current;
              if (merged.length <= max) {
                return merged;
              }
              return merged.slice(0, max);
            });
          }
          break;
        case "error":
          if (!isMountedRef.current) return;
          setError(message.error);
          break;
        default:
          break;
      }
    };

    fetchWorker.addEventListener("message", handleFetchMessage);

    const startCommand: FetchWorkerCommand = { type: "start" };
    fetchWorker.postMessage(startCommand);

    return () => {
      isMountedRef.current = false;
      fetchWorker.removeEventListener("message", handleFetchMessage);
      fetchWorker.postMessage({ type: "stop" });
      fetchWorker.terminate();
      fetchWorkerRef.current = null;
    };
  }, []);

  const reconnect = useCallback(() => {
    setError(null);
    setStatus("connecting");
    const worker = fetchWorkerRef.current;
    if (worker) {
      const command: FetchWorkerCommand = { type: "reconnect" };
      worker.postMessage(command);
    }
  }, []);

  const clearHistory = useCallback(() => {
    if (!isMountedRef.current) return;
    setUpdates([]);
  }, []);

  return { status, updates, error, reconnect, clearHistory };
}
