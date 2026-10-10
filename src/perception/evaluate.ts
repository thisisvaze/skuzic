/**
 * Scores perception against the scenes' design: does each pair read the way
 * it was drawn to, do the dimensions that should stay put stay put, do the
 * same picture drawn in different orders settle on the same reading, and does
 * a drawing growing step by step move the reading in proportion? Measured
 * qualities and the model's probes are scored on the same pairs, which is
 * what decides whether a probe adds anything (see MODEL_FEEDS in mapping.ts).
 */

import { calibrate } from './probes';
import { COMPARISONS, PROBE_FOR, PROGRESSIONS, SAME_PICTURE, type Comparison } from './scenes';

export interface SceneReading {
  /** Settled values by dimension: measured ones by name, model probes as "model.<id>". */
  values: Record<string, number>;
  /** Raw probe scores by probe id, for calibration. */
  raw: Record<string, number>;
}

/** A difference smaller than this doesn't count as reading either way. */
const NOTICE = 0.02;
/** An unrelated dimension moving more than this breaks isolation. */
const DRIFT = 0.15;
/** Settled readings of one picture may differ by this much. */
const SAME = 0.06;

export interface ComparisonResult extends Comparison {
  delta: number | null;
  agrees: boolean | null;
  /** The model's probe for the same quality on the same pair, when there is one. */
  probe: { dim: string; delta: number; agrees: boolean } | null;
  drift: { dim: string; delta: number }[];
}

export interface Report {
  comparisons: ComparisonResult[];
  /** Per dimension: [agreeing, scored] for the measurement and for the model. */
  agreement: Record<string, { measured: [number, number]; model: [number, number] }>;
  measured: [number, number];
  model: [number, number];
  /** Pairs where an unrelated dimension moved too far. */
  drifts: { pair: string; dim: string; delta: number }[];
  same: { scenes: string[]; worst: string; delta: number; ok: boolean }[];
  progressions: { scenes: string[]; density: number[]; ok: boolean }[];
  calibration: Record<string, { mu: number; sigma: number }>;
  missing: string[];
}

const tally = (rows: (boolean | null)[]): [number, number] => [rows.filter((r) => r === true).length, rows.filter((r) => r !== null).length];

export function evaluate(readings: Record<string, SceneReading>): Report {
  const missing = new Set<string>();
  const value = (scene: string, dim: string) => {
    const v = readings[scene]?.values[dim];
    if (v === undefined) missing.add(`${scene}:${dim}`);
    return v;
  };

  const comparisons = COMPARISONS.map((c): ComparisonResult => {
    const a = value(c.a, c.dim);
    const b = value(c.b, c.dim);
    const delta = a === undefined || b === undefined ? null : b - a;
    const twin = PROBE_FOR[c.dim];
    let probe: ComparisonResult['probe'] = null;
    if (twin) {
      const pa = value(c.a, twin.probe);
      const pb = value(c.b, twin.probe);
      if (pa !== undefined && pb !== undefined) {
        const d = (pb - pa) * (twin.invert ? -1 : 1);
        probe = { dim: twin.probe, delta: d, agrees: d > NOTICE };
      }
    }
    const drift = (c.same ?? []).flatMap((dim) => {
      const x = value(c.a, dim);
      const y = value(c.b, dim);
      return x === undefined || y === undefined ? [] : [{ dim, delta: y - x }];
    });
    return { ...c, delta, agrees: delta === null ? null : delta > NOTICE, probe, drift };
  });

  const agreement: Report['agreement'] = {};
  for (const r of comparisons) {
    const row = (agreement[r.dim] ??= { measured: [0, 0], model: [0, 0] });
    const isModel = r.dim.startsWith('model.');
    if (r.agrees !== null) {
      const side = isModel ? row.model : row.measured;
      side[1]++;
      if (r.agrees) side[0]++;
    }
    if (r.probe) {
      row.model[1]++;
      if (r.probe.agrees) row.model[0]++;
    }
  }

  const same = SAME_PICTURE.map((scenes) => {
    let worst = '';
    let delta = 0;
    const dims = Object.keys(readings[scenes[0]]?.values ?? {}).filter((d) => !d.startsWith('local.') && d !== 'x' && d !== 'y');
    for (const dim of dims) {
      const vs = scenes.map((s) => readings[s]?.values[dim]).filter((v): v is number => v !== undefined);
      const spread = Math.max(...vs) - Math.min(...vs);
      if (spread > delta) [worst, delta] = [dim, spread];
    }
    return { scenes, worst, delta, ok: delta <= SAME };
  });

  const progressions = PROGRESSIONS.map((scenes) => {
    const density = scenes.map((s) => value(s, 'density') ?? NaN);
    const steps = density.slice(1).map((d, i) => d - density[i]);
    // Each step adds to the page, and none is out of all proportion to the rest.
    const ok = steps.every((s) => s > 0) && Math.max(...steps) <= 4 * Math.max(Math.min(...steps), 0.01);
    return { scenes, density, ok };
  });

  const probes = new Set(Object.values(readings).flatMap((r) => Object.keys(r.raw)));
  const calibration = Object.fromEntries(
    [...probes].map((p) => [p, calibrate(Object.values(readings).flatMap((r) => (p in r.raw ? [r.raw[p]] : [])))]),
  );

  return {
    comparisons,
    agreement,
    measured: tally(comparisons.filter((c) => !c.dim.startsWith('model.')).map((c) => c.agrees)),
    model: tally([
      ...comparisons.filter((c) => c.dim.startsWith('model.')).map((c) => c.agrees),
      ...comparisons.map((c) => (c.probe ? c.probe.agrees : null)),
    ]),
    drifts: comparisons.flatMap((c) =>
      c.drift.filter((d) => Math.abs(d.delta) > DRIFT).map((d) => ({ pair: `${c.a} → ${c.b}`, dim: d.dim, delta: d.delta })),
    ),
    same,
    progressions,
    calibration,
    missing: [...missing],
  };
}
