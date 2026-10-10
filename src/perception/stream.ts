/**
 * The streamed music following the same targets. Lyria takes weighted words
 * and a few live knobs and is heard seconds later, so it gets what it can use:
 * a word layer per musical axis whose weight follows how far the target leans
 * from neutral, plus density and brightness. No layer means neutral, and an
 * axis changes its words only once its layer has faded to nothing, so a flip
 * is never heard as a jump. The vibe's instruments stay underneath throughout.
 *
 * Pure: it turns targets and the current mix into reducer actions. The caller
 * runs it every couple of seconds (Lyria's chunks are 2 s long); it returns
 * nothing when no change is big enough to hear.
 */

import type { Action, MixConfig, Track } from '../core/types';
import type { Targets } from './mapping';

export const ORIGIN = 'perception';

/** An axis's words at each end. Short phrases, the way Lyria is steered best. */
export const AXES = [
  { label: 'Phrasing', target: 'phrasing', low: 'smooth legato phrases', high: 'punctuated staccato rhythms' },
  { label: 'Touch', target: 'articulation', low: 'soft, gentle attacks', high: 'crisp, plucked notes' },
  { label: 'Register', target: 'register', low: 'low, warm register', high: 'high, airy register' },
  { label: 'Space', target: 'space', low: 'close, intimate sound', high: 'spacious, open reverb' },
] as const satisfies readonly { label: string; target: keyof Targets; low: string; high: string }[];

/** A layer's weight at an axis's extreme; under the instruments, as the listening test balanced moods. */
const LAYER_MAX = 0.3;
/** Within this of neutral an axis plays no layer at all. */
const DEAD = 0.06;
/** Changes smaller than these aren't worth a resend. */
const WEIGHT_STEP = 0.05;
const KNOB_STEP = 0.04;

export interface Layer {
  label: string;
  prompt: string;
  weight: number;
}

export function layersOf(targets: Targets): Layer[] {
  return AXES.map(({ label, target, low, high }) => {
    const lean = targets[target] - 0.5;
    const weight = LAYER_MAX * Math.max(0, Math.min(1, (Math.abs(lean) - DEAD) / (0.5 - DEAD)));
    return { label, prompt: lean < 0 ? low : high, weight: Math.round(weight * 100) / 100 };
  });
}

/** Lyria's two live knobs, as 0..1 dials (the reducer and toApiConfig keep them calm). */
export function knobsOf(targets: Targets): { density: number; brightness: number } {
  const round2 = (v: number) => Math.round(v * 100) / 100;
  return { density: round2(targets.fullness), brightness: round2(0.55 * targets.register + 0.45 * targets.articulation) };
}

/**
 * What to send so the mix follows `targets`, from the tracks and config now:
 * the instruments (added, dropped or rebalanced), each axis's layer, and the knobs.
 */
export function streamActions(
  targets: Targets,
  tracks: Track[],
  config: MixConfig,
  base: { label: string; prompt: string; volume: number }[],
): Action[] {
  if (targets.presence < 0.5) return [];
  const actions: Action[] = [];
  const find = (label: string) => tracks.find((t) => t.label === label);
  // Instruments come and go with the page; the mixer fades both ways.
  for (const t of tracks) {
    if (t.origin === ORIGIN && !AXES.some((a) => a.label === t.label) && !base.some((b) => b.label === t.label)) {
      actions.push({ type: 'REMOVE_TRACK', target: t.id });
    }
  }
  for (const b of base) {
    const track = find(b.label);
    if (!track) actions.push({ type: 'ADD_TRACK', ...b, origin: ORIGIN });
    else if (Math.abs(track.volume - b.volume) >= WEIGHT_STEP) actions.push({ type: 'SET_VOLUME', target: track.id, volume: b.volume });
  }
  for (const layer of layersOf(targets)) {
    const track = find(layer.label);
    if (!track) {
      if (layer.weight > 0) actions.push({ type: 'ADD_TRACK', label: layer.label, prompt: layer.prompt, volume: layer.weight, origin: ORIGIN });
    } else if (track.prompt !== layer.prompt) {
      // Fade the old words out first; they change once nothing of them is heard.
      if (track.volume > 0.02) actions.push({ type: 'SET_VOLUME', target: track.id, volume: 0 });
      else actions.push({ type: 'MODIFY_TRACK', target: track.id, prompt: layer.prompt }, { type: 'SET_VOLUME', target: track.id, volume: layer.weight });
    } else if (Math.abs(track.volume - layer.weight) >= WEIGHT_STEP || (layer.weight === 0 && track.volume > 0)) {
      actions.push({ type: 'SET_VOLUME', target: track.id, volume: layer.weight });
    }
  }
  const knobs = knobsOf(targets);
  if (Math.abs(config.density - knobs.density) >= KNOB_STEP || Math.abs(config.brightness - knobs.brightness) >= KNOB_STEP) {
    actions.push({ type: 'SET_CONFIG', config: knobs });
  }
  return actions;
}
