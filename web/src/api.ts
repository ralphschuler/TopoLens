function resolveApiBase(): string {
  const globalOverride = (globalThis as any)?.__VITE_API_BASE__;
  if (typeof globalOverride === "string" && globalOverride.length > 0) {
    return globalOverride;
  }
  const meta = (import.meta as any)?.env?.VITE_API_BASE;
  if (typeof meta === "string" && meta.length > 0) {
    return meta;
  }
  return "";
}

export async function fetchSnapshot(): Promise<{
  nodes: Array<{ asn: number }>;
  edges: Array<{ src_as: number; dst_as: number }>;
}> {
  const base = resolveApiBase();
  const res = await fetch(`${base}/api/snapshot`);
  if (!res.ok) {
    throw new Error(`Snapshot request failed with status ${res.status}`);
  }
  return res.json();
}

export function connectWS(onMessage: (payload: any) => void): WebSocket {
  const base = resolveApiBase() || (typeof window !== "undefined" ? window.location.origin : "");
  const wsUrl = base.replace(/^http/, "ws") + "/ws";
  const socket = new WebSocket(wsUrl);
  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      onMessage(data);
    } catch (error) {
      console.warn("Failed to parse websocket payload", error);
    }
  };
  return socket;
}
