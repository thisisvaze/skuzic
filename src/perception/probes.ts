/**
 * The model's side of perception: SigLIP 2 looks at the page and each probe
 * asks it one question with two answers ("flowing" or "stiff"). A probe is the
 * difference of its two poles' text vectors (scripts/embed-probes.py), so its
 * score is one dot product with the image, and every probe is scored on its
 * own: "soft", "dense" and "flowing" never compete for one slot.
 *
 * Scores are the model's interpretation, not measurements or calibrated
 * probabilities. Calibration only centres and scales each probe against the
 * drawings it was evaluated on, so 0.5 means "about as much as usual".
 */

import probes from './probes.json';

export type Probe = (typeof probes.probes)[number];
export const PROBES: Probe[] = probes.probes;

export interface ProbeVectors {
  vectors: Record<string, number[]>;
  calibration: Record<string, { mu: number; sigma: number }>;
}

/** Without a calibration, raw scores are read as spread about this much. */
const DEFAULT_SIGMA = 0.02;

export interface ProbeScore {
  /** The model's raw lean toward the first pole: cos(image, pos) - cos(image, neg). */
  raw: number;
  /** 0..1, 0.5 at the calibration's centre. */
  value: number;
}

export function scoreProbes(image: ArrayLike<number>, { vectors, calibration }: ProbeVectors): Record<string, ProbeScore> {
  const out: Record<string, ProbeScore> = {};
  for (const probe of PROBES) {
    const w = vectors[probe.id];
    if (!w) continue;
    let raw = 0;
    for (let i = 0; i < w.length; i++) raw += w[i] * image[i];
    const { mu, sigma } = calibration[probe.id] ?? { mu: 0, sigma: DEFAULT_SIGMA };
    out[probe.id] = { raw, value: 1 / (1 + Math.exp(-(raw - mu) / (sigma || DEFAULT_SIGMA))) };
  }
  return out;
}

/** A probe's centre and spread over a set of raw scores, for its calibration. */
export function calibrate(raws: number[]): { mu: number; sigma: number } {
  const mu = raws.reduce((a, b) => a + b, 0) / (raws.length || 1);
  const sigma = Math.sqrt(raws.reduce((a, b) => a + (b - mu) ** 2, 0) / (raws.length || 1));
  return { mu: Math.round(mu * 1e5) / 1e5, sigma: Math.round(Math.max(sigma, 1e-4) * 1e5) / 1e5 };
}
