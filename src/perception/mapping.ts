/**
 * From what the page looks like to what the music should do. These are design
 * hypotheses to tune by ear, not rules: lighter marks play higher, a fuller
 * page plays fuller, soft edges play gently, angular lines play punctuated.
 * Related inputs are blended into a few musical targets rather than each
 * property getting a sound of its own, and every target is bounded so
 * energetic drawing stays enjoyable.
 *
 * Inputs are named: "lightness" is the whole page, "local.lightness" the
 * region around the latest change, "model.flowing" a SigLIP probe and
 * "gesture.energy" the live hand. An input that is missing (no model yet, an
 * empty page) drops out and the rest carry the target.
 */

export interface Targets {
  /** 0 low register .. 1 high. */
  register: number;
  /** 0 sparse arrangement .. 1 full. */
  fullness: number;
  /** 0 gentle attacks .. 1 articulated. */
  articulation: number;
  /** 0 smooth, legato phrasing .. 1 punctuated. */
  phrasing: number;
  /** 0 calm .. 1 lively. */
  energy: number;
  /** 0 consonant .. 1 tense; capped well below 1. */
  tension: number;
  /** 0 close and dry .. 1 spacious. */
  space: number;
  /** Stereo position of the latest marks, -1 left .. 1 right. */
  pan: number;
  /** 0 when there is nothing on the page to play, 1 once there is. */
  presence: number;
}

export interface Input {
  value: number;
  support: number;
}

export type Inputs = Record<string, Input | undefined>;

/** One input's part in a target: weight, its value as used (inverted if need be) and its support. */
export interface Term {
  input: string;
  weight: number;
  value: number;
  support: number;
}

type Rule = { base: number; span: number; terms: [input: string, weight: number, invert?: true][] };

/**
 * Model probes feed the music only once the evaluation shows they add
 * something repeatable the measurements don't; the rest show in the lab only.
 * As of the 2026-10-09 scene run (app brushes, q4 SigLIP on WebGPU): "soft"
 * agreed with measured softness on 3 of 3 pairs and also told a grainy broad
 * pencil from a smooth wash of the same width, which edge width can't, so it
 * feeds articulation. "flowing" and "restless" agreed on 3 of 4 (under the
 * 80% bar) and "heavy" mostly repeats measured tone, weight and density.
 */
export const MODEL_FEEDS: Record<string, number> = {
  'model.flowing': 0,
  'model.restless': 0,
  'model.soft': 1,
  'model.heavy': 0,
};

export const RULES: Record<Exclude<keyof Targets, 'pan' | 'presence'>, Rule> = {
  register: { base: 0.15, span: 0.7, terms: [['lightness', 0.65], ['local.lightness', 0.35]] },
  fullness: { base: 0.1, span: 0.8, terms: [['density', 0.55], ['texture', 0.2], ['weight', 0.1], ['local.density', 0.15]] },
  articulation: { base: 0.1, span: 0.8, terms: [['softness', 0.6, true], ['contrast', 0.2], ['model.soft', 0.2, true]] },
  phrasing: { base: 0.1, span: 0.8, terms: [['angularity', 0.5], ['local.angularity', 0.2], ['model.flowing', 0.15, true], ['model.restless', 0.15]] },
  energy: { base: 0.15, span: 0.7, terms: [['gesture.energy', 0.6], ['texture', 0.2], ['model.restless', 0.2]] },
  tension: { base: 0, span: 0.6, terms: [['angularity', 0.4], ['contrast', 0.3], ['model.restless', 0.3]] },
  space: { base: 0.15, span: 0.7, terms: [['openness', 0.7], ['model.heavy', 0.3, true]] },
};

/** Ink share at which the page counts as fully present. */
const PRESENT = 0.002;
const PAN = 1.2;
const PAN_CAP = 0.6;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The targets for these inputs, and for each the terms that made it, for the lab to show. */
export function targetsOf(inputs: Inputs): { targets: Targets; why: Record<string, Term[]> } {
  const why: Record<string, Term[]> = {};
  const out = {} as Targets;
  for (const [name, rule] of Object.entries(RULES) as [keyof typeof RULES, Rule][]) {
    const terms: Term[] = [];
    let sum = 0;
    let weights = 0;
    for (const [input, w, invert] of rule.terms) {
      const weight = w * (input in MODEL_FEEDS ? MODEL_FEEDS[input] : 1);
      const x = inputs[input];
      if (!x || weight <= 0) continue;
      const raw = invert ? 1 - x.value : x.value;
      // Weak evidence pulls toward the middle rather than dragging the target.
      const support = clamp(x.support, 0, 1);
      const value = 0.5 + (raw - 0.5) * support;
      terms.push({ input, weight, value, support });
      sum += weight * value;
      weights += weight;
    }
    why[name] = terms;
    out[name] = rule.base + rule.span * (weights ? sum / weights : 0.5);
  }
  const x = inputs['local.x'] ?? inputs.x;
  out.pan = x ? clamp((x.value - 0.5) * PAN * x.support, -PAN_CAP, PAN_CAP) : 0;
  out.presence = clamp((inputs.ink?.value ?? 0) / PRESENT, 0, 1);
  return { targets: out, why };
}
