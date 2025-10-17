/// <reference lib="webworker" />

import { extractUpdates } from "../utils/ris";
import type { FetchWorkerCommand, FetchWorkerEvent, WorkerConnectionState } from "./messages";

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

const RIS_ENDPOINT = "wss://ris-live.ripe.net/v1/ws/";
const SUBSCRIPTION_MESSAGE = JSON.stringify({
  type: "ris_subscribe",
  data: {
    host: "rrc00.ripe.net",
  },
});

let socket: WebSocket | null = null;
let shouldRun = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function postMessage(event: FetchWorkerEvent) {
  ctx.postMessage(event);
}

function updateStatus(status: WorkerConnectionState) {
  postMessage({ type: "status", status });
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (!shouldRun || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (shouldRun) {
      connect();
    }
  }, 4000);
}

function teardownSocket() {
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
    console.error("Failed to close WebSocket", error);
  }
}

function handleSocketMessage(event: MessageEvent) {
  if (typeof event.data !== "string") {
    return;
  }

  try {
    const parsed = JSON.parse(event.data);
    const updates = extractUpdates(parsed);
    const message: FetchWorkerEvent = { type: "updates", updates };
    postMessage(message);
  } catch (error) {
    console.error("Failed to parse RIS payload", error);
    postMessage({ type: "error", error: "Failed to parse update message" });
  }
}

function connect() {
  if (socket || !shouldRun) {
    return;
  }
  updateStatus("connecting");

  try {
    const ws = new WebSocket(RIS_ENDPOINT);
    socket = ws;

    ws.onopen = () => {
      if (!shouldRun) {
        teardownSocket();
        return;
      }
      updateStatus("connected");
      clearReconnectTimer();
      ws.send(SUBSCRIPTION_MESSAGE);
    };

    ws.onmessage = handleSocketMessage;

    ws.onerror = (error) => {
      console.error("WebSocket error", error);
      postMessage({ type: "error", error: "WebSocket connection error" });
      updateStatus("error");
    };

    ws.onclose = () => {
      socket = null;
      updateStatus("error");
      postMessage({ type: "closed" });
      if (shouldRun) {
        scheduleReconnect();
      }
    };
  } catch (error) {
    console.error("Failed to create WebSocket", error);
    postMessage({ type: "error", error: "Failed to create WebSocket" });
    updateStatus("error");
    scheduleReconnect();
  }
}

function start() {
  if (shouldRun) return;
  shouldRun = true;
  clearReconnectTimer();
  connect();
}

function stop() {
  shouldRun = false;
  clearReconnectTimer();
  teardownSocket();
  updateStatus("error");
}

function reconnect() {
  shouldRun = true;
  clearReconnectTimer();
  teardownSocket();
  connect();
}

ctx.onmessage = (event: MessageEvent<FetchWorkerCommand>) => {
  const command = event.data;
  if (!command) return;
  switch (command.type) {
    case "start":
      start();
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

export {}; // ensure module scope
