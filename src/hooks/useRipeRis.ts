import { useCallback, useEffect, useRef, useState } from "react";

import {
  DEFAULT_MAX_CHANGES,
  DEFAULT_MAX_ROUTES,
  RouteTracker,
  type RouteTrackerSnapshot,
} from "../topology/routeTracker";
import type { RipeUpdate } from "../utils/ris";
import {
  DEFAULT_RIS_SUBSCRIPTION,
  normalizeRisSubscription,
  type RisSubscription,
} from "../utils/subscription";
import type {
  FetchWorkerCommand,
  FetchWorkerEvent,
  WorkerConnectionState,
} from "../workers/messages";

const MAX_PAUSED_UPDATES = 5_000;
const MAX_RECORDED_GAPS = 24;
const RESUME_CHUNK_SIZE = 250;
const SNAPSHOT_PUBLISH_INTERVAL_MS = 750;

export type ConnectionState = WorkerConnectionState | "paused";

export interface ObservationGap {
  id: number;
  startedAt: number;
  endedAt?: number;
  reason: string;
  droppedUpdates?: number;
}

export interface UseRipeRisOptions {
  initialSubscription?: RisSubscription;
  maxRoutes?: number;
  maxChanges?: number;
}

function createTracker(options: UseRipeRisOptions): RouteTracker {
  return new RouteTracker({
    maxRoutes: options.maxRoutes ?? DEFAULT_MAX_ROUTES,
    maxChanges: options.maxChanges ?? DEFAULT_MAX_CHANGES,
  });
}

function latestReceivedAt(updates: readonly RipeUpdate[]): number | null {
  let latest: number | null = null;
  for (const update of updates) {
    latest = latest === null ? update.receivedAt : Math.max(latest, update.receivedAt);
  }
  return latest;
}

export function useRipeRis(options: UseRipeRisOptions = {}) {
  const [tracker] = useState(() => createTracker(options));
  const trackerRef = useRef<RouteTracker | null>(tracker);
  const [initialSubscription] = useState(() =>
    normalizeRisSubscription(options.initialSubscription ?? DEFAULT_RIS_SUBSCRIPTION),
  );
  const subscriptionRef = useRef(initialSubscription);
  const generationRef = useRef(1);
  const workerRef = useRef<Worker | null>(null);
  const mountedRef = useRef(true);
  const pausedRef = useRef(false);
  const pausedUpdatesRef = useRef<RipeUpdate[]>([]);
  const snapshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resumeTokenRef = useRef(0);
  const resumingRef = useRef(false);
  const pauseOverflowRef = useRef<{
    startedAt: number;
    endedAt: number;
    dropped: number;
  } | null>(null);
  const openConnectionGapRef = useRef<ObservationGap | null>(null);
  const gapSequenceRef = useRef(0);

  const workerSupported = typeof Worker !== "undefined";
  const [workerStatus, setWorkerStatus] = useState<WorkerConnectionState>(
    workerSupported ? "connecting" : "error",
  );
  const [snapshot, setSnapshot] = useState<RouteTrackerSnapshot>(() => tracker.getSnapshot());
  const [subscription, setSubscription] = useState(initialSubscription);
  const [isPaused, setIsPaused] = useState(false);
  const [pendingUpdateCount, setPendingUpdateCount] = useState(0);
  const [droppedPausedUpdates, setDroppedPausedUpdates] = useState(0);
  const [retryInMs, setRetryInMs] = useState<number | null>(null);
  const [sessionStartedAt, setSessionStartedAt] = useState(() => Date.now());
  const [lastUpdateAt, setLastUpdateAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(
    workerSupported
      ? null
      : "This browser does not support Web Workers, so the live view cannot start.",
  );
  const [gaps, setGaps] = useState<ObservationGap[]>([]);

  const publishSnapshot = useCallback(() => {
    if (snapshotTimerRef.current !== null) {
      clearTimeout(snapshotTimerRef.current);
      snapshotTimerRef.current = null;
    }
    if (!mountedRef.current || !trackerRef.current) return;
    setSnapshot(trackerRef.current.getSnapshot());
  }, []);

  const scheduleSnapshot = useCallback(() => {
    if (snapshotTimerRef.current !== null) return;
    snapshotTimerRef.current = setTimeout(publishSnapshot, SNAPSHOT_PUBLISH_INTERVAL_MS);
  }, [publishSnapshot]);

  const applyUpdates = useCallback(
    (updates: readonly RipeUpdate[]) => {
      if (updates.length === 0 || !trackerRef.current) return;
      trackerRef.current.apply(updates);
      scheduleSnapshot();
    },
    [scheduleSnapshot],
  );

  const openConnectionGap = useCallback((startedAt: number, reason: string) => {
    if (openConnectionGapRef.current) return;
    gapSequenceRef.current += 1;
    const gap: ObservationGap = {
      id: gapSequenceRef.current,
      startedAt,
      reason,
    };
    openConnectionGapRef.current = gap;
    setGaps((previous) => [...previous, gap].slice(-MAX_RECORDED_GAPS));
  }, []);

  const closeConnectionGap = useCallback((endedAt: number) => {
    const openGap = openConnectionGapRef.current;
    if (!openGap) return;
    openConnectionGapRef.current = null;
    setGaps((previous) =>
      previous.map((gap) => (gap.id === openGap.id ? { ...gap, endedAt } : gap)),
    );
  }, []);

  const queueWhilePaused = useCallback((updates: readonly RipeUpdate[]) => {
    const available = Math.max(0, MAX_PAUSED_UPDATES - pausedUpdatesRef.current.length);
    if (available > 0) pausedUpdatesRef.current.push(...updates.slice(0, available));

    const dropped = Math.max(0, updates.length - available);
    if (dropped > 0) {
      const timestamp = latestReceivedAt(updates) ?? Date.now();
      if (pauseOverflowRef.current) {
        pauseOverflowRef.current.endedAt = timestamp;
        pauseOverflowRef.current.dropped += dropped;
      } else {
        pauseOverflowRef.current = {
          startedAt: timestamp,
          endedAt: timestamp,
          dropped,
        };
      }
      setDroppedPausedUpdates((previous) => previous + dropped);
    }

    setPendingUpdateCount(pausedUpdatesRef.current.length);
  }, []);

  const cancelResumeProcessing = useCallback(() => {
    resumeTokenRef.current += 1;
    resumingRef.current = false;
    if (resumeTimerRef.current !== null) {
      clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    if (!workerSupported) {
      return () => {
        mountedRef.current = false;
      };
    }

    let worker: Worker;
    try {
      worker = new Worker(new URL("../workers/fetchWorker.ts", import.meta.url), {
        type: "module",
      });
    } catch (workerError) {
      const message =
        workerError instanceof Error ? workerError.message : "Unknown worker initialization error";
      queueMicrotask(() => {
        if (!mountedRef.current) return;
        setWorkerStatus("error");
        setError(`Failed to start the RIS Live worker: ${message}`);
      });
      return () => {
        mountedRef.current = false;
      };
    }

    workerRef.current = worker;

    const handleMessage = (event: MessageEvent<FetchWorkerEvent>) => {
      if (!mountedRef.current || !event.data) return;
      const message = event.data;
      if (message.generation !== generationRef.current) return;

      switch (message.type) {
        case "status":
          setWorkerStatus(message.status);
          setRetryInMs(message.retryInMs ?? null);
          if (message.status === "connected") {
            setError(null);
            closeConnectionGap(Date.now());
          }
          break;
        case "subscribed":
          subscriptionRef.current = message.subscription;
          setSubscription(message.subscription);
          break;
        case "updates": {
          const latest = latestReceivedAt(message.updates);
          if (latest !== null) setLastUpdateAt(latest);
          if (pausedRef.current || resumingRef.current) queueWhilePaused(message.updates);
          else applyUpdates(message.updates);
          break;
        }
        case "closed":
          openConnectionGap(message.at, message.reason || "RIS Live connection interrupted");
          break;
        case "error":
          setError(message.error);
          if (message.fatal) setWorkerStatus("error");
          break;
        default:
          break;
      }
    };

    const handleError = (event: ErrorEvent) => {
      if (!mountedRef.current) return;
      if (workerRef.current === worker) workerRef.current = null;
      worker.terminate();
      const detail =
        event.message ||
        (event.error instanceof Error ? event.error.message : String(event.error ?? ""));
      setWorkerStatus("error");
      setError(`RIS Live worker crashed: ${detail || "Unknown error"}`);
      openConnectionGap(Date.now(), "Update worker crashed");
    };

    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    const command: FetchWorkerCommand = {
      type: "start",
      subscription: subscriptionRef.current,
      generation: generationRef.current,
    };
    worker.postMessage(command);

    return () => {
      mountedRef.current = false;
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
      if (workerRef.current === worker) {
        worker.postMessage({ type: "stop" } satisfies FetchWorkerCommand);
        workerRef.current = null;
      }
      worker.terminate();
      if (snapshotTimerRef.current !== null) {
        clearTimeout(snapshotTimerRef.current);
        snapshotTimerRef.current = null;
      }
      cancelResumeProcessing();
    };
  }, [
    applyUpdates,
    cancelResumeProcessing,
    closeConnectionGap,
    openConnectionGap,
    queueWhilePaused,
    workerSupported,
  ]);

  const pause = useCallback(() => {
    if (pausedRef.current) return;
    cancelResumeProcessing();
    pausedRef.current = true;
    setIsPaused(true);
  }, [cancelResumeProcessing]);

  const resume = useCallback(() => {
    if (!pausedRef.current) return;
    pausedRef.current = false;
    setIsPaused(false);

    const overflow = pauseOverflowRef.current;
    if (overflow) {
      gapSequenceRef.current += 1;
      const gap: ObservationGap = {
        id: gapSequenceRef.current,
        startedAt: overflow.startedAt,
        endedAt: overflow.endedAt,
        reason: "Paused update buffer exceeded",
        droppedUpdates: overflow.dropped,
      };
      setGaps((previous) => [...previous, gap].slice(-MAX_RECORDED_GAPS));
      pauseOverflowRef.current = null;
    }

    cancelResumeProcessing();
    if (pausedUpdatesRef.current.length === 0) {
      setPendingUpdateCount(0);
      return;
    }

    resumingRef.current = true;
    const token = resumeTokenRef.current;
    const processChunk = () => {
      if (token !== resumeTokenRef.current || !resumingRef.current) return;

      const chunk = pausedUpdatesRef.current.splice(0, RESUME_CHUNK_SIZE);
      applyUpdates(chunk);
      setPendingUpdateCount(pausedUpdatesRef.current.length);

      if (pausedUpdatesRef.current.length === 0) {
        resumingRef.current = false;
        resumeTimerRef.current = null;
        return;
      }
      resumeTimerRef.current = setTimeout(processChunk, 0);
    };
    resumeTimerRef.current = setTimeout(processChunk, 0);
  }, [applyUpdates, cancelResumeProcessing]);

  const reconnect = useCallback(() => {
    const worker = workerRef.current;
    if (!worker) {
      setWorkerStatus("error");
      setError("The RIS Live worker is unavailable. Reload the page to restart it.");
      return;
    }
    setError(null);
    setWorkerStatus("connecting");
    openConnectionGap(Date.now(), "Manual reconnect");
    worker.postMessage({ type: "reconnect" } satisfies FetchWorkerCommand);
  }, [openConnectionGap]);

  const clearSession = useCallback(() => {
    cancelResumeProcessing();
    trackerRef.current?.clear();
    pausedUpdatesRef.current = [];
    pauseOverflowRef.current = null;
    pausedRef.current = false;
    openConnectionGapRef.current = null;
    gapSequenceRef.current = 0;
    setIsPaused(false);
    setPendingUpdateCount(0);
    setDroppedPausedUpdates(0);
    setGaps([]);
    setSessionStartedAt(Date.now());
    setLastUpdateAt(null);
    publishSnapshot();
  }, [cancelResumeProcessing, publishSnapshot]);

  const configure = useCallback(
    (nextSubscription: RisSubscription) => {
      const worker = workerRef.current;
      if (!worker) {
        setWorkerStatus("error");
        setError("The RIS Live worker is unavailable. The scope was not changed.");
        return;
      }

      const normalized = normalizeRisSubscription(nextSubscription);
      generationRef.current += 1;
      const generation = generationRef.current;
      cancelResumeProcessing();
      subscriptionRef.current = normalized;
      setSubscription(normalized);
      trackerRef.current?.clear();
      pausedUpdatesRef.current = [];
      pauseOverflowRef.current = null;
      pausedRef.current = false;
      openConnectionGapRef.current = null;
      gapSequenceRef.current = 0;
      setIsPaused(false);
      setPendingUpdateCount(0);
      setDroppedPausedUpdates(0);
      setGaps([]);
      setError(null);
      setWorkerStatus("connecting");
      setRetryInMs(null);
      setSessionStartedAt(Date.now());
      setLastUpdateAt(null);
      publishSnapshot();
      worker.postMessage({
        type: "configure",
        subscription: normalized,
        generation,
      } satisfies FetchWorkerCommand);
    },
    [cancelResumeProcessing, publishSnapshot],
  );

  return {
    status: (isPaused ? "paused" : workerStatus) as ConnectionState,
    workerStatus,
    snapshot,
    subscription,
    sessionStartedAt,
    lastUpdateAt,
    error,
    gaps,
    isPaused,
    pendingUpdateCount,
    droppedPausedUpdates,
    retryInMs,
    pause,
    resume,
    reconnect,
    clearSession,
    configure,
  };
}
