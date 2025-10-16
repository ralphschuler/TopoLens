PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS prefix (
  prefix TEXT PRIMARY KEY,
  origin_as INTEGER,
  next_hop TEXT,
  as_path TEXT,
  last_seen INTEGER
);

CREATE TABLE IF NOT EXISTS as_edge (
  src_as INTEGER,
  dst_as INTEGER,
  last_seen INTEGER,
  PRIMARY KEY (src_as, dst_as)
);

CREATE TABLE IF NOT EXISTS events (
  ts INTEGER,
  type TEXT,
  prefix TEXT,
  origin_as INTEGER,
  as_path TEXT,
  next_hop TEXT
);
