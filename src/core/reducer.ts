import { CAPABILITIES } from '../audio/engine';
import type { Action, Backend, SkuzicState, Track } from './types';

/** Lyria has no documented prompt cap; MRT2's engine constant is 6. */
export const maxTracksFor = (backend: Backend) => CAPABILITIES[backend].maxPrompts;

let seq = 0;
export const newId = () => `t${++seq}`;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * The model refers to tracks by id when it can, but often uses the label it
 * invented a moment ago. Accept both, then fall back to fuzzy matching so a
 * near-miss degrades into the right track instead of a silently dropped action.
 */
function resolve(tracks: Track[], target: string): Track | undefined {
  if (!target) return undefined;
  const needle = target.trim().toLowerCase();
  return (
    tracks.find((t) => t.id === target) ??
    tracks.find((t) => t.label.toLowerCase() === needle) ??
    tracks.find((t) => t.label.toLowerCase().includes(needle)) ??
    tracks.find((t) => needle.includes(t.label.toLowerCase())) ??
    tracks.find((t) => t.prompt.toLowerCase().includes(needle))
  );
}

export function reduce(state: SkuzicState, action: Action): SkuzicState {
  switch (action.type) {
    case 'ADD_TRACK': {
      const track: Track = {
        id: newId(),
        label: action.label.slice(0, 24),
        prompt: action.prompt,
        volume: clamp01(action.volume ?? 0.8),
        muted: false,
        origin: action.origin ?? '',
      };
      let tracks = [...state.tracks, track];
      if (tracks.length > maxTracksFor(state.backend)) {
        // Evict the quietest existing track so the mix stays legible.
        const victim = tracks
          .slice(0, -1)
          .reduce((a, b) => (b.volume < a.volume ? b : a));
        tracks = tracks.filter((t) => t.id !== victim.id);
      }
      return { ...state, tracks };
    }

    case 'REMOVE_TRACK': {
      const hit = resolve(state.tracks, action.target);
      if (!hit) return state;
      return { ...state, tracks: state.tracks.filter((t) => t.id !== hit.id) };
    }

    case 'MODIFY_TRACK': {
      const hit = resolve(state.tracks, action.target);
      if (!hit) return state;
      return {
        ...state,
        tracks: state.tracks.map((t) =>
          t.id === hit.id
            ? {
                ...t,
                label: action.label?.slice(0, 24) ?? t.label,
                prompt: action.prompt ?? t.prompt,
              }
            : t,
        ),
      };
    }

    case 'SET_VOLUME': {
      const hit = resolve(state.tracks, action.target);
      if (!hit) return state;
      return {
        ...state,
        tracks: state.tracks.map((t) =>
          t.id === hit.id ? { ...t, volume: clamp01(action.volume) } : t,
        ),
      };
    }

    case 'SET_MUTED': {
      const hit = resolve(state.tracks, action.target);
      if (!hit) return state;
      return {
        ...state,
        tracks: state.tracks.map((t) =>
          t.id === hit.id ? { ...t, muted: action.muted } : t,
        ),
      };
    }

    case 'SET_CONFIG': {
      const c = action.config;
      return {
        ...state,
        config: {
          ...state.config,
          ...c,
          bpm: c.bpm != null ? Math.min(200, Math.max(60, Math.round(c.bpm))) : state.config.bpm,
          density: c.density != null ? clamp01(c.density) : state.config.density,
          brightness: c.brightness != null ? clamp01(c.brightness) : state.config.brightness,
          guidance:
            c.guidance != null
              ? Math.min(6, Math.max(0, c.guidance))
              : state.config.guidance,
        },
      };
    }

    case 'SET_BACKEND': {
      if (action.backend === state.backend) return state;
      // Backends cap prompts differently; keep the loudest that still fit.
      const cap = maxTracksFor(action.backend);
      const tracks =
        state.tracks.length <= cap
          ? state.tracks
          : [...state.tracks].sort((a, b) => b.volume - a.volume).slice(0, cap);
      return { ...state, backend: action.backend, tracks };
    }

    case 'CLEAR_TRACKS':
      return { ...state, tracks: [] };

    case 'RESET_CONTEXT':
      return { ...state, contextEpoch: state.contextEpoch + 1 };
  }
}

export const reduceAll = (state: SkuzicState, actions: Action[]): SkuzicState =>
  actions.reduce(reduce, state);
