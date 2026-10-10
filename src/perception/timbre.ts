/**
 * Which instruments the art asks for, from what it is made of rather than what
 * it shows. Each instrument has a timbre: how sharp its attack is, where its
 * register sits, and for some a colour, after Kandinsky's correspondences in
 * Concerning the Spiritual in Art (1911): light blue a flute, deeper blue a
 * cello, green the calm middle of the violins, violet the reeds (his English
 * horn and bassoon), warm red the brass, orange a bell, yellow the brightest
 * high voice (his trumpet, kept gentle here as a glockenspiel). Greys and black
 * carry no colour, his grey is soundless, so a graphite drawing is chosen by
 * its line and tone alone. Line and tone follow the crossmodal findings: soft
 * edges and curves play bowed, blown and legato, crisp corners plucked and
 * struck, lighter marks higher (Spence 2011; Köhler's bouba and kiki).
 *
 * Pure. Design hypotheses to tune by ear, like mapping.ts.
 */

import palette from '../vision/palette.json';
import type { Vibe } from '../vision/eyes';
import type { Inputs, Targets } from './mapping';
import { WARM_HUE } from './measure';

export interface Timbre {
  id: string;
  label: string;
  prompt: string;
  /** 0 bowed, blown, swelling .. 1 plucked, struck. */
  attack: number;
  /** Where it sings, 0 low .. 1 high. */
  register: number;
  /** Kandinsky's colour for it, as a hue in degrees on the a*b* plane, if it has one. */
  hue?: number;
  /** For instruments the palette doesn't have: the vibes they belong in. */
  vibes?: string[];
}

const of = (id: string) => {
  const { label, prompt } = palette.instruments.find((i) => i.id === id)!;
  return { id, label, prompt };
};

/** Hues are the studio inks': red 19, orange 57, amber 76, green 131, blue 277, violet 309. */
export const TIMBRES: Timbre[] = [
  { ...of('pads'), attack: 0.05, register: 0.5 },
  { ...of('strings'), attack: 0.15, register: 0.55, hue: 135 },
  { id: 'cello', label: 'cello', prompt: 'warm singing cello', attack: 0.2, register: 0.2, hue: 275, vibes: ['blank', 'lofi', 'ambient', 'folk', 'strings'] },
  { ...of('flute'), attack: 0.25, register: 0.8, hue: 250 },
  { id: 'horn', label: 'French horn', prompt: 'mellow French horn', attack: 0.25, register: 0.35, hue: 25, vibes: ['blank', 'lofi', 'ambient', 'folk'] },
  { id: 'clarinet', label: 'clarinet', prompt: 'soft woody clarinet', attack: 0.3, register: 0.45, hue: 310, vibes: ['blank', 'lofi', 'jazz', 'folk', 'bossa'] },
  { ...of('piano'), attack: 0.45, register: 0.45 },
  { ...of('rhodes'), attack: 0.5, register: 0.4 },
  { ...of('vibes'), attack: 0.55, register: 0.6, hue: 57 },
  { ...of('guitar'), attack: 0.65, register: 0.45 },
  { ...of('harp'), attack: 0.7, register: 0.6 },
  { ...of('kalimba'), attack: 0.8, register: 0.7 },
  { ...of('glockenspiel'), attack: 0.9, register: 0.9, hue: 80 },
];

/** How much each part counts: colour leads when there is colour, then the line's attack, then tone. */
const WEIGHTS = { colour: 1.2, attack: 4, register: 2.5 };
/** A coloured instrument starts this far behind, so it needs its colour on the page to win. */
const COLOURLESS = 0.3;
/** Scores to shares. */
const SCALE = 4;
/** A challenger must lead the weaker seat by this share to take it. */
const MARGIN = 0.12;

export interface TimbreScore {
  timbre: Timbre;
  p: number;
  why: { colour: number; attack: number; register: number };
}

/** Every instrument the vibe allows, ranked for this page, best first. */
export function timbresFor(targets: Targets, inputs: Inputs, vibe: Vibe): TimbreScore[] {
  // Line: soft edges and curves against crisp edges and corners.
  const attack = (targets.articulation + targets.phrasing) / 2;
  // Colour as a direction on the a*b* plane, as long as the marks are coloured.
  const axis = (k: string) => {
    const x = inputs[k];
    return x ? (x.value - 0.5) * 2 * x.support : 0;
  };
  const warm = axis('warmth');
  const tint = axis('tint');
  const scored = TIMBRES.filter((t) => vibe.instruments.includes(t.id) || t.vibes?.includes(vibe.id)).map((timbre) => {
    const hue = timbre.hue === undefined ? 0 : (timbre.hue * Math.PI) / 180 - WARM_HUE;
    const why = {
      colour: timbre.hue === undefined ? 0 : WEIGHTS.colour * (warm * Math.cos(hue) + tint * Math.sin(hue) - COLOURLESS),
      attack: -WEIGHTS.attack * (attack - timbre.attack) ** 2,
      register: -WEIGHTS.register * (targets.register - timbre.register) ** 2,
    };
    return { timbre, why, score: why.colour + why.attack + why.register };
  });
  const top = Math.max(...scored.map((s) => s.score));
  const weights = scored.map((s) => Math.exp(SCALE * (s.score - top)));
  const sum = weights.reduce((a, b) => a + b, 0);
  return scored.map(({ timbre, why }, i) => ({ timbre, why, p: weights[i] / sum })).sort((a, b) => b.p - a.p);
}

/**
 * Two seats, lead first. Instruments playing keep their seats unless one not
 * playing leads the weaker by MARGIN, and only one changes at a time, so the
 * other carries the music through.
 */
export function seatTimbres(ranked: TimbreScore[], playing: string[], seats = 2): Timbre[] {
  const p = (id: string) => ranked.find((r) => r.timbre.id === id)?.p ?? 0;
  const kept = playing.filter((id) => ranked.some((r) => r.timbre.id === id)).slice(0, seats);
  for (const r of ranked) if (kept.length < seats && !kept.includes(r.timbre.id)) kept.push(r.timbre.id);
  const challenger = ranked.find((r) => !kept.includes(r.timbre.id));
  const weakest = kept.reduce((a, b) => (p(a) <= p(b) ? a : b), kept[0]);
  if (challenger && challenger.p - p(weakest) >= MARGIN) kept[kept.indexOf(weakest)] = challenger.timbre.id;
  return kept.sort((a, b) => p(b) - p(a)).map((id) => ranked.find((r) => r.timbre.id === id)!.timbre);
}
