import { Scale } from '@google/genai';

export type TrackId = string;

/** Which music model is generating. Chosen before connecting. */
export type Backend = 'lyria' | 'magenta';

/**
 * One track = one weighted text prompt sent to the music model.
 * `volume` is relative: the engine normalizes weights across all live tracks.
 */
export interface Track {
  id: TrackId;
  label: string;
  prompt: string;
  volume: number;
  muted: boolean;
  origin: string;
}

/**
 * The superset of controls across backends. Which fields actually do anything
 * depends on the engine — see CAPABILITIES in `src/audio/engine.ts`.
 */
export interface MixConfig {
  bpm: number;
  density: number;
  brightness: number;
  guidance: number;
  scale: Scale;
  muteBass: boolean;
  muteDrums: boolean;
}

export interface SkuzicState {
  backend: Backend;
  tracks: Track[];
  config: MixConfig;
  /** Bumped when the model should hard-restart generation. */
  contextEpoch: number;
}

/** `target` accepts a track id or a label; the reducer resolves either. */
export type Action =
  | { type: 'ADD_TRACK'; label: string; prompt: string; volume: number; origin?: string }
  | { type: 'REMOVE_TRACK'; target: string }
  | { type: 'MODIFY_TRACK'; target: string; label?: string; prompt?: string }
  | { type: 'SET_VOLUME'; target: string; volume: number }
  | { type: 'SET_MUTED'; target: string; muted: boolean }
  | { type: 'SET_CONFIG'; config: Partial<MixConfig> }
  | { type: 'SET_BACKEND'; backend: Backend }
  | { type: 'CLEAR_TRACKS' }
  | { type: 'RESET_CONTEXT' };

/**
 * Tuned for *listenability over a long session*, not for neutrality.
 *
 * `scale` is the big one. Unspecified lets the model drift tonally, and since
 * this instrument is permanently crossfading between prompt sets, drift means
 * each blend lands in a slightly different key from the one before it — which
 * is most of what "the music isn't pleasant" turns out to be. Anchoring a key
 * makes every mix consonant with every other mix by construction. Each Lyria
 * scale value is a major and its relative minor, so one setting already covers
 * both a happy drawing and a sad one; the planner never needs to change it.
 * F/Dm is warm and idiom-neutral — swap the value to change the whole session's
 * colour, it is the single most audible line in this file.
 *
 * `guidance` trades prompt adherence against transition smoothness (the API's
 * own words). At the 4.0 default, every steer arrives as a lurch. Below it the
 * model bends toward the new prompts instead of snapping to them, which is the
 * DJ-blend feel this instrument is built around.
 *
 * `bpm` 90 sits where the model can read either half-time or double-time
 * without a context reset, so energy can swing wide while the pulse holds.
 */
export const INITIAL_CONFIG: MixConfig = {
  bpm: 90,
  density: 0.5,
  brightness: 0.5,
  guidance: 3.0,
  scale: Scale.F_MAJOR_D_MINOR,
  muteBass: false,
  muteDrums: false,
};

export const INITIAL_STATE: SkuzicState = {
  backend: 'lyria',
  tracks: [],
  config: INITIAL_CONFIG,
  contextEpoch: 0,
};
