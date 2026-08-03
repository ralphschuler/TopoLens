/// <reference lib="webworker" />

import { extractUpdates } from "../utils/ris";
import {
  buildRisSubscriptionPayload,
  DEFAULT_RIS_SUBSCRIPTION,
  normalizeRisSubscription,
  type RisSubscription,
} from "../utils/subscription";
import type { FetchWorkerCommand, FetchWorkerEvent, WorkerConnectionState } from "./messages";

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

const RIS_ENDPOINT = "wss://ris-live.ripe.net/v1/ws/?client=topolens-web";
const UPDATE_BATCH_INTERVAL_MS = 200;
const UPDATE_BATCH_SIZE = 250;
const SUBSCRIPTION_ACK_TIMEOUT_MS = 8_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

let socket: WebSocket | null = null;
let shouldRun = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let acknowledgementTimer: ReturnType<typeof setTimeout> | null = null;
let batchTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let pendingUpdates: ReturnType<typeof extractUpdates> = [];
let subscription: RisSubscription = DEFAULT_RIS_SUBSCRIPTION;
let subscriptionConfirmed = false;
let activeGeneration = 0;

type FetchEventPayload = FetchWorkerEvent extends infer Event
  ? Event extends { generation: number }
    ? Omit<Event, "generation">
    : never
  : never;

function isActiveGeneration(generation: number): boolean {
  return generation === activeGeneration;
}

function emit(event: FetchEventPayload, generation = activeGeneration): void {
  if (!isActiveGeneration(generation)) return;
  ctx.postMessage({ ...event, generation } as FetchWorkerEvent);
}

function updateStatus(status: WorkerConnectionState, generation: number, retryInMs?: number): void {
  emit({ type: "status", status, retryInMs }, generation);
}

function clearTimer(timer: ReturnType<typeof setTimeout> | null): void {
  if (timer !== null) clearTimeout(timer);
}

function clearReconnectTimer(): void {
  clearTimer(reconnectTimer);
  reconnectTimer = null;
}

function clearAcknowledgementTimer(): void {
  clearTimer(acknowledgementTimer);
  acknowledgementTimer = null;
}

function discardPendingUpdates(): void {
  clearTimer(batchTimer);
  batchTimer = null;
  pendingUpdates = [];
}

function flushUpdates(generation: number): void {
  if (!isActiveGeneration(generation)) return;
  clearTimer(batchTimer);
  batchTimer = null;
  if (pendingUpdates.length === 0) return;

  const updates = pendingUpdates;
  pendingUpdates = [];
  emit({ type: "updates", updates }, generation);
}

function queueUpdates(updates: ReturnType<typeof extractUpdates>, generation: number): void {
  if (!isActiveGeneration(generation) || updates.length === 0) return;
  pendingUpdates.push(...updates);

  if (pendingUpdates.length >= UPDATE_BATCH_SIZE) {
    flushUpdates(generation);
    return;
  }

  if (batchTimer === null) {
    batchTimer = setTimeout(() => flushUpdates(generation), UPDATE_BATCH_INTERVAL_MS);
  }
}

function teardownSocket(): void {
  clearAcknowledgementTimer();
  if (!socket) return;

  const current = socket;
  socket = null;
  current.onopen = null;
  current.onclose = null;
  current.onmessage = null;
  current.onerror = null;
  try {
    current.close();
  } catch (error) {
    console.error("Failed to close RIS Live WebSocket", error);
  }
}

function scheduleReconnect(generation: number): void {
  if (!shouldRun || !isActiveGeneration(generation) || reconnectTimer !== null) return;

  const exponentialDelay = Math.min(
    MAX_RECONNECT_DELAY_MS,
    1_000 * 2 ** Math.min(reconnectAttempt, 5),
  );
  const retryInMs = exponentialDelay + Math.round(Math.random() * 500);
  reconnectAttempt += 1;
  updateStatus("reconnecting", generation, retryInMs);

  reconnectTimer = setTimeout(() => {
    if (!isActiveGeneration(generation)) return;
    reconnectTimer = null;
    connect(generation);
  }, retryInMs);
}

function describeRisError(data: unknown): string {
  if (typeof data === "string" && data.trim()) return data;
  if (data && typeof data === "object") {
    const value = data as Record<string, unknown>;
    if (typeof value.message === "string") return value.message;
    if (typeof value.error === "string") return value.error;
  }
  return "RIS Live rejected the subscription.";
}

function confirmSubscription(generation: number): void {
  if (!isActiveGeneration(generation)) return;
  clearAcknowledgementTimer();
  if (subscriptionConfirmed) return;
  subscriptionConfirmed = true;
  reconnectAttempt = 0;
  updateStatus("connected", generation);
}

function handleSocketMessage(event: MessageEvent, current: WebSocket, generation: number): void {
  if (!isActiveGeneration(generation) || socket !== current || typeof event.data !== "string") {
    return;
  }

  try {
    const parsed = JSON.parse(event.data) as { type?: string; data?: unknown };
    switch (parsed.type) {
      case "ris_subscribe_ok":
        confirmSubscription(generation);
        emit({ type: "subscribed", subscription }, generation);
        return;
      case "ris_error":
        shouldRun = false;
        clearReconnectTimer();
        emit({ type: "error", error: describeRisError(parsed.data), fatal: true }, generation);
        updateStatus("error", generation);
        teardownSocket();
        return;
      case "ris_message": {
        // Some older endpoints can send the first message before the acknowledgement.
        confirmSubscription(generation);
        queueUpdates(extractUpdates(parsed), generation);
        return;
      }
      case "pong":
      default:
        return;
    }
  } catch (error) {
    console.error("Failed to parse RIS Live payload", error);
    emit({ type: "error", error: "Received an invalid message from RIS Live." }, generation);
  }
}

function connect(generation: number): void {
  if (!shouldRun || !isActiveGeneration(generation) || socket !== null) return;

  clearReconnectTimer();
  subscriptionConfirmed = false;
  updateStatus(reconnectAttempt > 0 ? "reconnecting" : "connecting", generation);

  try {
    const current = new WebSocket(RIS_ENDPOINT);
    socket = current;

    current.onopen = () => {
      if (!shouldRun || !isActiveGeneration(generation) || socket !== current) {
        if (socket === current) {
          teardownSocket();
        } else {
          try {
            current.close();
          } catch (error) {
            console.error("Failed to close stale RIS Live WebSocket", error);
          }
        }
        return;
      }

      current.send(
        JSON.stringify({
          type: "ris_subscribe",
          data: buildRisSubscriptionPayload(subscription),
        }),
      );

      const timer = setTimeout(() => {
        if (acknowledgementTimer === timer) acknowledgementTimer = null;
        if (!isActiveGeneration(generation) || socket !== current) return;
        emit(
          {
            type: "error",
            error: "RIS Live did not acknowledge the subscription in time.",
          },
          generation,
        );
        current.close();
      }, SUBSCRIPTION_ACK_TIMEOUT_MS);
      acknowledgementTimer = timer;
    };

    current.onmessage = (event) => handleSocketMessage(event, current, generation);

    current.onerror = () => {
      if (!isActiveGeneration(generation) || socket !== current) return;
      emit(
        { type: "error", error: "The RIS Live WebSocket reported a connection error." },
        generation,
      );
      current.close();
    };

    current.onclose = (event) => {
      if (!isActiveGeneration(generation) || socket !== current) return;
      socket = null;
      clearAcknowledgementTimer();
      flushUpdates(generation);
      emit(
        {
          type: "closed",
          at: Date.now(),
          reason: event.reason || undefined,
        },
        generation,
      );
      scheduleReconnect(generation);
    };
  } catch (error) {
    if (!isActiveGeneration(generation)) return;
    console.error("Failed to create RIS Live WebSocket", error);
    emit({ type: "error", error: "Failed to create the RIS Live WebSocket." }, generation);
    scheduleReconnect(generation);
  }
}

function start(nextSubscription: RisSubscription, generation: number): void {
  activeGeneration = generation;
  subscription = normalizeRisSubscription(nextSubscription);
  shouldRun = true;
  reconnectAttempt = 0;
  clearReconnectTimer();
  discardPendingUpdates();
  teardownSocket();
  connect(generation);
}

function stop(): void {
  shouldRun = false;
  clearReconnectTimer();
  teardownSocket();
  flushUpdates(activeGeneration);
}

function reconnect(): void {
  shouldRun = true;
  reconnectAttempt = 0;
  clearReconnectTimer();
  teardownSocket();
  connect(activeGeneration);
}

ctx.onmessage = (event: MessageEvent<FetchWorkerCommand>) => {
  const command = event.data;
  if (!command) return;

  switch (command.type) {
    case "start":
      start(command.subscription, command.generation);
      break;
    case "configure":
      start(command.subscription, command.generation);
      break;
    case "stop":
      stop();
      break;
    case "reconnect":
      reconnect();
      break;
    default:
      break;
  }
};

export {};
