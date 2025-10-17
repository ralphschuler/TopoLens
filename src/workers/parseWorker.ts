/// <reference lib="webworker" />

import { extractUpdates } from "../utils/ris";
import type { ParseWorkerCommand, ParseWorkerEvent } from "./messages";

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

function handleParse({ payload }: { payload: string }) {
  try {
    const parsed = JSON.parse(payload);
    const updates = extractUpdates(parsed);
    const event: ParseWorkerEvent = { type: "updates", updates };
    ctx.postMessage(event);
  } catch (error) {
    console.error("Failed to parse RIS payload", error);
    const event: ParseWorkerEvent = { type: "error", error: "Failed to parse update message" };
    ctx.postMessage(event);
  }
}

ctx.onmessage = (event: MessageEvent<ParseWorkerCommand>) => {
  const command = event.data;
  if (!command) return;
  switch (command.type) {
    case "parse":
      handleParse(command);
      break;
    default:
      break;
  }
};

export {};
