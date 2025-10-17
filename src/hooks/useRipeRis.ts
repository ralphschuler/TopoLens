import { useCallback, useEffect, useRef, useState } from "react";
import { addUpdates, clearUpdates, getRecentUpdates, type PersistedUpdate } from "../db/indexedDb";
import type { ParseWorkerEvent, FetchWorkerEvent, FetchWorkerCommand } from "../workers/messages";

export type ConnectionState = "connecting" | "connected" | "error";

export function useRipeRis(limit = 50) {
  const [status, setStatus] = useState<ConnectionState>("connecting");
  const [updates, setUpdates] = useState<PersistedUpdate[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetchWorkerRef = useRef<Worker | null>(null);
  const isMountedRef = useRef(true);

  const loadLatest = useCallback(async () => {
    const latest = await getRecentUpdates(limit);
    if (isMountedRef.current) {
      setUpdates(latest);
    }
  }, [limit]);

  useEffect(() => {
    loadLatest().catch((err) => {
      console.error("Failed to load updates", err);
      if (isMountedRef.current) {
        setError("Failed to load stored updates");
      }
    });
  }, [loadLatest]);

  useEffect(() => {
    isMountedRef.current = true;

    const fetchWorker = new Worker(new URL("../workers/fetchWorker.ts", import.meta.url), {
      type: "module",
    });
    const parseWorker = new Worker(new URL("../workers/parseWorker.ts", import.meta.url), {
      type: "module",
    });

    fetchWorkerRef.current = fetchWorker;

    const handleFetchMessage = (event: MessageEvent<FetchWorkerEvent>) => {
      const message = event.data;
      if (!message) return;
      switch (message.type) {
        case "status":
          setStatus(message.status);
          if (message.status === "connected") {
            setError(null);
          }
          break;
        case "message":
          parseWorker.postMessage({ type: "parse", payload: message.payload });
          break;
        case "error":
          setError(message.error);
          break;
        case "closed":
          break;
        default:
          break;
      }
    };

    const handleParseMessage = (event: MessageEvent<ParseWorkerEvent>) => {
      const message = event.data;
      if (!message) return;
      switch (message.type) {
        case "updates":
          if (message.updates.length > 0) {
            void addUpdates(message.updates)
              .then(loadLatest)
              .catch((err: unknown) => {
                console.error("Failed to persist updates", err);
                if (!isMountedRef.current) return;
                setError("Failed to persist updates");
              });
          }
          break;
        case "error":
          setError(message.error);
          break;
        default:
          break;
      }
    };

    fetchWorker.addEventListener("message", handleFetchMessage);
    parseWorker.addEventListener("message", handleParseMessage);

    const startCommand: FetchWorkerCommand = { type: "start" };
    fetchWorker.postMessage(startCommand);

    return () => {
      isMountedRef.current = false;
      fetchWorker.removeEventListener("message", handleFetchMessage);
      parseWorker.removeEventListener("message", handleParseMessage);
      fetchWorker.postMessage({ type: "stop" });
      fetchWorker.terminate();
      parseWorker.terminate();
      fetchWorkerRef.current = null;
    };
  }, [loadLatest]);

  const reconnect = useCallback(() => {
    setError(null);
    setStatus("connecting");
    const worker = fetchWorkerRef.current;
    if (worker) {
      const command: FetchWorkerCommand = { type: "reconnect" };
      worker.postMessage(command);
    }
  }, []);

  const clearHistory = useCallback(async () => {
    await clearUpdates();
    if (isMountedRef.current) {
      setUpdates([]);
    }
  }, []);

  return { status, updates, error, reconnect, clearHistory };
}
