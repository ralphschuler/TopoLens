import { formatAsPath, type AsPathSegment } from "../utils/ris";

const compactNumberFormatter = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const fullNumberFormatter = new Intl.NumberFormat("en");

export function formatCount(value: number): string {
  return value >= 10_000 ? compactNumberFormatter.format(value) : fullNumberFormatter.format(value);
}

export function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

export function formatAbsolute(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

export function formatRelative(timestamp: number, now = Date.now()): string {
  const difference = Math.max(0, now - timestamp);
  const seconds = Math.floor(difference / 1_000);
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatOrigin(segment: AsPathSegment | null): string {
  if (!segment) return "Unknown";
  if (segment.kind === "asn") return `AS${segment.asn}`;
  return `{${segment.asns.map((asn) => `AS${asn}`).join(", ")}}`;
}

export function formatPath(path: readonly AsPathSegment[]): string {
  return formatAsPath(path) || "No AS path";
}

export function isIpv6Prefix(prefix: string): boolean {
  return prefix.includes(":");
}
