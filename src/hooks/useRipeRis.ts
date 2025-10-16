import { useCallback, useEffect, useRef, useState } from "react";
import { addUpdates, clearUpdates, getRecentUpdates, type PersistedUpdate } from "../db/indexedDb";
import { extractUpdates } from "../utils/ris";

export type ConnectionState = "connecting" | "connected" | "error";

const RIS_ENDPOINT = "wss://ris-live.ripe.net/v1/ws/";
const SUBSCRIPTION_MESSAGE = JSON.stringify({
  type: "ris_subscribe",
  data: {
    host: "rrc00.ripe.net",
  },
});

export function useRipeRis(limit = 50) {
  const [status, setStatus] = useState<ConnectionState>("connecting");
  const [updates, setUpdates] = useState<PersistedUpdate[]>([]);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectRef = useRef<() => void>();
  const isMountedRef = useRef(true);

  const loadLatest = useCallback(async () => {
    const latest = await getRecentUpdates(limit);
    if (isMountedRef.current) {
      setUpdates(latest);
    }
  }, [limit]);

  useEffect(() => {
    loadLatest();
  }, [loadLatest]);

  useEffect(() => {
    isMountedRef.current = true;
    const connect = () => {
      setStatus("connecting");
      setError(null);
      const ws = new WebSocket(RIS_ENDPOINT);
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        if (!isMountedRef.current) return;
        setStatus("connected");
        ws.send(SUBSCRIPTION_MESSAGE);
      });

      ws.addEventListener("message", (event) => {
        if (!isMountedRef.current) return;
        try {
          const parsed = JSON.parse(event.data);
          const extracted = extractUpdates(parsed);
          if (extracted.length > 0) {
            void addUpdates(extracted).then(loadLatest).catch((err: unknown) => {
              console.error("Failed to persist updates", err);
              if (!isMountedRef.current) return;
              setError("Failed to persist updates");
            });
          }
        } catch (err) {
          console.error("Failed to parse RIS message", err);
          setError("Failed to parse update message");
        }
      });

      ws.addEventListener("error", (event) => {
        console.error("WebSocket error", event);
        if (!isMountedRef.current) return;
        setStatus("error");
        setError("WebSocket connection error");
      });

      ws.addEventListener("close", () => {
        if (!isMountedRef.current) return;
        setStatus("error");
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
        }
        reconnectTimerRef.current = setTimeout(() => {
          if (isMountedRef.current) {
            connect();
          }
        }, 4000);
      });
    };

    connectRef.current = () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      wsRef.current?.close();
      connect();
    };

    connect();

    return () => {
      isMountedRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      wsRef.current?.close();
    };
  }, [loadLatest]);

  const reconnect = useCallback(() => {
    setError(null);
    connectRef.current?.();
  }, []);

  const clearHistory = useCallback(async () => {
    await clearUpdates();
    if (isMountedRef.current) {
      setUpdates([]);
    }
  }, []);

  return { status, updates, error, reconnect, clearHistory };
}
