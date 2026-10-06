// Builds a full copy of the database as one JSON file.
import { db, collection, getDocs } from "./firebase.js";

export const BACKUP_COLLECTIONS = ["categories", "lists", "clients", "suppliers", "transactions", "meta"];

// Firestore timestamps -> ISO text, so the file is plain JSON.
export function plain(v) {
  if (v == null) return v;
  if (typeof v.toDate === "function") return v.toDate().toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

export async function buildBackup(dateStr) {
  const out = { app: "parlour-accounts", format: 1, exportedAt: new Date().toISOString(), collections: {} };
  let count = 0;
  for (const name of BACKUP_COLLECTIONS) {
    const snap = await getDocs(collection(db, name));
    out.collections[name] = snap.docs.map((d) => ({ id: d.id, ...plain(d.data()) }));
    count += snap.size;
    out.fromCacheOnly = (out.fromCacheOnly ?? true) && snap.metadata.fromCache;
  }
  const json = JSON.stringify(out, null, 1);
  const file = new File([json], `parlour-backup-${dateStr}.json`, { type: "application/json" });
  return { file, count, fromCacheOnly: !!out.fromCacheOnly };
}
