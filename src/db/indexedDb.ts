import { openDB, type DBSchema } from "idb";
import type { RipeUpdate } from "../utils/ris";

interface TopoLensSchema extends DBSchema {
  updates: {
    key: number;
    value: RipeUpdate & { id?: number };
    indexes: { timestamp: number };
  };
}

const DB_NAME = "topolens-ris";
const DB_VERSION = 1;
const STORE_UPDATES = "updates";

const dbPromise = openDB<TopoLensSchema>(DB_NAME, DB_VERSION, {
  upgrade(db) {
    if (!db.objectStoreNames.contains(STORE_UPDATES)) {
      const store = db.createObjectStore(STORE_UPDATES, {
        keyPath: "id",
        autoIncrement: true,
      });
      store.createIndex("timestamp", "timestamp");
    }
  },
});

export type PersistedUpdate = RipeUpdate & { id?: number };

export async function addUpdates(updates: RipeUpdate[]): Promise<void> {
  if (updates.length === 0) return;
  const db = await dbPromise;
  const tx = db.transaction(STORE_UPDATES, "readwrite");
  for (const update of updates) {
    await tx.store.add(update);
  }
  await tx.done;
}

export async function getRecentUpdates(limit = 50): Promise<PersistedUpdate[]> {
  const db = await dbPromise;
  const tx = db.transaction(STORE_UPDATES, "readonly");
  const index = tx.store.index("timestamp");
  const results: PersistedUpdate[] = [];
  let cursor = await index.openCursor(null, "prev");
  while (cursor && results.length < limit) {
    results.push(cursor.value);
    cursor = await cursor.continue();
  }
  await tx.done;
  return results;
}

export async function clearUpdates(): Promise<void> {
  const db = await dbPromise;
  const tx = db.transaction(STORE_UPDATES, "readwrite");
  await tx.store.clear();
  await tx.done;
}
