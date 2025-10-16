import { spawn } from "node:child_process";
import { addEvent, upsertEdgesFromASPath, upsertPrefix } from "./db.js";

const GOBGP_BIN = process.env.GOBGP_BIN ?? "gobgp";
const DEMO_MODE = (process.env.DEMO_MODE ?? "false").toLowerCase() === "true";

type Attribute = {
  type?: string;
  value?: unknown;
  nexthop?: string | null;
};

export type AnnounceHandler = (payload: {
  ts: number;
  prefix: string;
  origin_as: number | null;
  as_path?: string;
  next_hop?: string | null;
}) => void;

export type WithdrawHandler = (payload: { ts: number; prefix: string }) => void;

type UpdateMessage = {
  announced?: Array<{
    nlri: { prefix: string };
    attrs?: unknown[];
    nexthop?: string;
  }>;
  withdrawn?: Array<{ prefix: string }>;
};

type RIBEntry = {
  prefix: string;
  paths?: Array<{
    attrs?: unknown[];
    nexthop?: string;
  }>;
};

function toAttributes(attrs: unknown[] | undefined): Attribute[] {
  if (!Array.isArray(attrs)) return [];
  return attrs.filter((attr): attr is Attribute => typeof attr === "object" && attr !== null);
}

function extractOrigin(attrs: unknown[] | undefined): number | null {
  const typedAttrs = toAttributes(attrs);
  const asPathAttr = typedAttrs.find(
    (attr) => typeof attr.type === "string" && attr.type.toLowerCase().includes("as_path"),
  );
  const values: number[] = Array.isArray(asPathAttr?.value)
    ? (asPathAttr.value as unknown[])
        .flat()
        .map((v) => Number(v))
        .filter((v) => Number.isInteger(v))
    : [];
  if (values.length === 0) return null;
  return values[values.length - 1];
}

function extractASPath(attrs: unknown[] | undefined): string | undefined {
  const typedAttrs = toAttributes(attrs);
  const asPathAttr = typedAttrs.find(
    (attr) => typeof attr.type === "string" && attr.type.toLowerCase().includes("as_path"),
  );
  const values = Array.isArray(asPathAttr?.value)
    ? (asPathAttr.value as unknown[]).flat().filter((part) => Number.isInteger(Number(part)))
    : [];
  return values.map((part) => String(part)).join(" ");
}

function extractNextHop(
  attrs: unknown[] | undefined,
  fallback?: string | null,
): string | null | undefined {
  const typedAttrs = toAttributes(attrs);
  const nh = typedAttrs.find((attr) => attr.type?.toLowerCase() === "next_hop");
  if (!nh) return fallback;
  const candidate = nh.nexthop ?? (typeof nh.value === "string" ? nh.value : null);
  if (candidate === null || candidate === undefined) return fallback;
  return candidate;
}

export async function initialRIBLoad(): Promise<void> {
  if (DEMO_MODE) return;
  const proc = spawn(GOBGP_BIN, ["-j", "global", "rib"], { stdio: ["ignore", "pipe", "inherit"] });
  let buffer = "";
  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
  });

  await new Promise<void>((resolve) => {
    proc.on("close", () => resolve());
  });

  if (!buffer.trim()) return;

  const entries: RIBEntry[] = JSON.parse(buffer);
  const now = Date.now();
  for (const entry of entries) {
    const primary = entry.paths?.[0];
    const attrs = primary?.attrs as unknown[] | undefined;
    const origin_as = extractOrigin(attrs);
    const as_path = extractASPath(attrs);
    const next_hop = extractNextHop(attrs, primary?.nexthop ?? null) ?? null;
    upsertPrefix({ prefix: entry.prefix, origin_as, next_hop, as_path, ts: now });
    upsertEdgesFromASPath(as_path, now);
  }
}

export type MonitorStopper = () => void;

export function startUpdateMonitor(
  onAnnounce: AnnounceHandler,
  onWithdraw: WithdrawHandler,
): MonitorStopper {
  if (DEMO_MODE) {
    const timer = setInterval(() => {
      const ts = Date.now();
      const a = Math.floor(65000 + Math.random() * 1000);
      const b = a + 1;
      const prefix = `10.${a % 255}.${b % 255}.0/24`;
      const as_path = `${a} ${b}`;
      const next_hop = `192.0.2.${b % 255}`;
      upsertPrefix({ prefix, origin_as: a, next_hop, as_path, ts });
      upsertEdgesFromASPath(as_path, ts);
      addEvent({ ts, type: "announce", prefix, origin_as: a, as_path, next_hop });
      onAnnounce({ ts, prefix, origin_as: a, as_path, next_hop });
    }, 1000);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  const monitor = spawn(GOBGP_BIN, ["monitor", "global", "updates", "-j"], {
    stdio: ["ignore", "pipe", "inherit"],
  });

  monitor.stdout.on("data", (chunk) => {
    const lines = chunk.toString().split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: UpdateMessage;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const ts = Date.now();
      if (parsed.announced) {
        for (const announcement of parsed.announced) {
          const attrs = announcement.attrs as unknown[] | undefined;
          const origin_as = extractOrigin(attrs);
          const as_path = extractASPath(attrs);
          const next_hop = extractNextHop(attrs, announcement.nexthop ?? null);
          const prefix = announcement.nlri.prefix;
          upsertPrefix({ prefix, origin_as, next_hop: next_hop ?? null, as_path, ts });
          upsertEdgesFromASPath(as_path, ts);
          addEvent({
            ts,
            type: "announce",
            prefix,
            origin_as,
            as_path,
            next_hop: next_hop ?? undefined,
          });
          onAnnounce({ ts, prefix, origin_as, as_path, next_hop });
        }
      }

      if (parsed.withdrawn) {
        for (const withdrawal of parsed.withdrawn) {
          const prefix = withdrawal.prefix;
          addEvent({ ts, type: "withdraw", prefix, origin_as: null });
          onWithdraw({ ts, prefix });
        }
      }
    }
  });

  return () => {
    monitor.kill();
  };
}
