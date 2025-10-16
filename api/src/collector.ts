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

  const parsed = JSON.parse(buffer);
  const entries: RIBEntry[] = Array.isArray(parsed) ? parsed : [];
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

// Realistic ASNs representing major ISPs and networks
const MAJOR_ASNS = [
  7922, // Comcast
  3356, // Level3
  174,  // Cogent
  6939, // Hurricane Electric
  1299, // Telia
  2914, // NTT Communications
  3257, // GTT
  5511, // Orange
  1273, // Vodafone
  15169, // Google
  16509, // Amazon
  8075,  // Microsoft
  13335, // Cloudflare
  32934, // Facebook
];

const demoAnnouncedPrefixes = new Set<string>();

function initializeDemoData(onAnnounce: AnnounceHandler): void {
  const ts = Date.now();
  
  // Generate initial "internet routing table" with major networks
  for (let i = 0; i < 100; i++) {
    const originAS = MAJOR_ASNS[Math.floor(Math.random() * MAJOR_ASNS.length)];
    const transitAS = MAJOR_ASNS[Math.floor(Math.random() * MAJOR_ASNS.length)];
    
    // Create realistic prefixes
    const octet1 = Math.floor(Math.random() * 223) + 1; // Avoid 0 and reserved ranges
    const octet2 = Math.floor(Math.random() * 256);
    const octet3 = Math.floor(Math.random() * 256);
    const maskLength = Math.random() < 0.7 ? 24 : (Math.random() < 0.5 ? 16 : 8);
    
    const prefix = `${octet1}.${octet2}.${octet3}.0/${maskLength}`;
    const as_path = originAS !== transitAS ? `${transitAS} ${originAS}` : `${originAS}`;
    const next_hop = `10.0.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
    
    demoAnnouncedPrefixes.add(prefix);
    upsertPrefix({ prefix, origin_as: originAS, next_hop, as_path, ts });
    upsertEdgesFromASPath(as_path, ts);
    addEvent({ ts, type: "announce", prefix, origin_as: originAS, as_path, next_hop });
    onAnnounce({ ts, prefix, origin_as: originAS, as_path, next_hop });
  }
}

function generateRealisticAnnouncement(ts: number, onAnnounce: AnnounceHandler): void {
  const originAS = MAJOR_ASNS[Math.floor(Math.random() * MAJOR_ASNS.length)];
  const transitAS = MAJOR_ASNS[Math.floor(Math.random() * MAJOR_ASNS.length)];
  
  // Generate new prefix
  const octet1 = Math.floor(Math.random() * 223) + 1;
  const octet2 = Math.floor(Math.random() * 256);
  const octet3 = Math.floor(Math.random() * 256);
  const prefix = `${octet1}.${octet2}.${octet3}.0/24`;
  
  const as_path = originAS !== transitAS ? `${transitAS} ${originAS}` : `${originAS}`;
  const next_hop = `10.0.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
  
  demoAnnouncedPrefixes.add(prefix);
  upsertPrefix({ prefix, origin_as: originAS, next_hop, as_path, ts });
  upsertEdgesFromASPath(as_path, ts);
  addEvent({ ts, type: "announce", prefix, origin_as: originAS, as_path, next_hop });
  onAnnounce({ ts, prefix, origin_as: originAS, as_path, next_hop });
}

function generateMultiHopAnnouncement(ts: number, onAnnounce: AnnounceHandler): void {
  // Create longer AS paths (2-4 hops) to show more network topology
  const pathLength = Math.floor(Math.random() * 3) + 2;
  const asPath: number[] = [];
  
  for (let i = 0; i < pathLength; i++) {
    let candidate: number;
    do {
      candidate = MAJOR_ASNS[Math.floor(Math.random() * MAJOR_ASNS.length)];
    } while (asPath.includes(candidate)); // Avoid loops
    asPath.push(candidate);
  }
  
  const originAS = asPath[asPath.length - 1];
  const octet1 = Math.floor(Math.random() * 223) + 1;
  const octet2 = Math.floor(Math.random() * 256);
  const octet3 = Math.floor(Math.random() * 256);
  const prefix = `${octet1}.${octet2}.${octet3}.0/24`;
  
  const as_path = asPath.join(" ");
  const next_hop = `10.0.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
  
  demoAnnouncedPrefixes.add(prefix);
  upsertPrefix({ prefix, origin_as: originAS, next_hop, as_path, ts });
  upsertEdgesFromASPath(as_path, ts);
  addEvent({ ts, type: "announce", prefix, origin_as: originAS, as_path, next_hop });
  onAnnounce({ ts, prefix, origin_as: originAS, as_path, next_hop });
}

function generateWithdrawal(ts: number, onWithdraw: WithdrawHandler): void {
  if (demoAnnouncedPrefixes.size === 0) return;
  
  const prefixes = Array.from(demoAnnouncedPrefixes);
  const randomPrefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  
  demoAnnouncedPrefixes.delete(randomPrefix);
  addEvent({ ts, type: "withdraw", prefix: randomPrefix, origin_as: null });
  onWithdraw({ ts, prefix: randomPrefix });
}

export function startUpdateMonitor(
  onAnnounce: AnnounceHandler,
  onWithdraw: WithdrawHandler,
): MonitorStopper {
  if (DEMO_MODE) {
    // Initialize with some realistic looking BGP data to simulate "whole internet"
    initializeDemoData(onAnnounce);
    
    const timer = setInterval(() => {
      const ts = Date.now();
      // Create more realistic AS paths and announcements
      const scenario = Math.random();
      
      if (scenario < 0.7) {
        // Normal announcement with realistic AS path
        generateRealisticAnnouncement(ts, onAnnounce);
      } else if (scenario < 0.9) {
        // Multi-hop AS path announcement  
        generateMultiHopAnnouncement(ts, onAnnounce);
      } else {
        // Withdrawal
        generateWithdrawal(ts, onWithdraw);
      }
    }, Math.random() * 2000 + 500); // Variable timing 0.5-2.5s
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
