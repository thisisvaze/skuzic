/**
 * Preference dataset collected by A/B mode. Each record pairs the exact
 * planner input (event, drawing, mix) with both plans that came back and which
 * one the user kept — the raw material for fine-tuning or DPO-style preference
 * training later. The drawing rides along as a data URL, which makes records
 * far too large for localStorage, so this lives in IndexedDB.
 */

import type { Action, Backend, MixConfig, Track } from '../core/types';
import type { PlannerConfigId } from '../llm/configs';
import type { PlannerModel } from '../llm/planner';

export interface AbVariantRecord {
  configId: PlannerConfigId;
  model: PlannerModel;
  reasoning: string;
  actions: Action[];
  /** The mix after applying the actions — what the user actually auditioned. */
  tracks: Track[];
  config: MixConfig;
}

export interface AbRecord {
  id: string;
  /** Epoch ms. */
  ts: number;
  event: string;
  /** The pad as the planner saw it; null when the pad was blank. */
  image: string | null;
  backend: Backend;
  /** The mix both plans were made against. */
  base: { tracks: Track[]; config: MixConfig };
  /** In display order: [0] was shown as A, [1] as B. */
  variants: AbVariantRecord[];
  /** Index into variants. */
  chosen: number;
  /** How long the user compared before choosing, ms. */
  decisionMs: number;
}

const DB_NAME = 'skuzic';
const STORE = 'ab-choices';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
  });
}

/** Never throws — a record that fails to save must not break the choice flow. */
export async function addRecord(record: AbRecord): Promise<boolean> {
  try {
    await tx('readwrite', (s) => s.add(record));
    return true;
  } catch (error) {
    console.error('[skuzic] failed to save A/B record', error);
    return false;
  }
}

export async function countRecords(): Promise<number> {
  try {
    return await tx('readonly', (s) => s.count());
  } catch {
    return 0;
  }
}

/**
 * Download everything as JSONL — one record per line, so a training pipeline
 * can stream it without holding the images in memory all at once.
 */
export async function exportDataset(): Promise<number> {
  let records: AbRecord[];
  try {
    records = await tx('readonly', (s) => s.getAll());
  } catch (error) {
    console.error('[skuzic] failed to read A/B records', error);
    return 0;
  }
  if (!records.length) return 0;

  const jsonl = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const blob = new Blob([jsonl], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `skuzic-ab-${new Date().toISOString().slice(0, 10)}.jsonl`;
  a.click();
  URL.revokeObjectURL(url);
  return records.length;
}
