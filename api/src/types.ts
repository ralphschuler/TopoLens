export type SnapshotNode = { asn: number };
export type SnapshotEdge = { src_as: number; dst_as: number };

export type LiveAnnounce = {
  type: "announce";
  ts: number;
  prefix: string;
  origin_as: number | null;
  as_path?: string;
  next_hop?: string | null;
};

export type LiveWithdraw = {
  type: "withdraw";
  ts: number;
  prefix: string;
};

export type Heartbeat = {
  type: "heartbeat";
  ts: number;
};

export type LiveMessage = LiveAnnounce | LiveWithdraw | Heartbeat;
