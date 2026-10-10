import type { PromptWeight } from '../audio/engine';
import type { Vibe } from '../vision/eyes';
import type { SkuzicState } from './types';

/**
 * The drawing supplies every weighted layer. Its first audible layer also
 * carries the chosen idiom, once, so style has no weight or channel of its
 * own. Repeating a genre on every layer can wash out the drawing's details.
 * Raw, editable track words stay untouched; changing vibe cannot accumulate
 * old genre cues. Every engine path, including A/B, uses this same boundary.
 */
export function musicPrompts(state: SkuzicState, vibe: Vibe): PromptWeight[] {
  const live = state.tracks.filter((track) => !track.muted && track.volume > 0 && track.prompt.trim());
  return live.map((track, i) => ({
    text: i === 0 && !state.soundEffects ? `${track.prompt}; ${vibe.ground[state.backend]}` : track.prompt,
    weight: track.volume,
  }));
}
