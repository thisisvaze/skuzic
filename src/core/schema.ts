import { Scale, Type, type Schema } from '@google/genai';
import type { Action, MixConfig } from './types';

export const ACTION_TYPES = [
  'ADD_TRACK',
  'REMOVE_TRACK',
  'MODIFY_TRACK',
  'SET_VOLUME',
  'SET_MUTED',
  'SET_CONFIG',
  'CLEAR_TRACKS',
  'RESET_CONTEXT',
] as const;

const SCALE_NAMES: Scale[] = Object.values(Scale).filter(
  (s) => s !== Scale.SCALE_UNSPECIFIED,
);

/**
 * A flat action shape rather than a discriminated union — `anyOf` in
 * responseSchema is fragile, and a flat object with a `type` enum round-trips
 * reliably. `normalize()` narrows it back into the real Action union.
 */
export const PLAN_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    reasoning: {
      type: Type.STRING,
      description: 'One short sentence on the musical intent behind these actions.',
    },
    actions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          type: { type: Type.STRING, enum: [...ACTION_TYPES] },
          target: {
            type: Type.STRING,
            description: 'Existing track id or label. Required for track-scoped actions.',
          },
          label: { type: Type.STRING, description: 'Short track name, max 24 chars.' },
          prompt: {
            type: Type.STRING,
            description: 'Musical description sent to the music model.',
          },
          volume: { type: Type.NUMBER, description: 'Relative prominence, 0.0 to 1.0.' },
          muted: { type: Type.BOOLEAN },
          bpm: { type: Type.INTEGER, description: '60-200. Forces an audible restart.' },
          density: { type: Type.NUMBER, description: '0.0 sparse to 1.0 busy.' },
          brightness: { type: Type.NUMBER, description: '0.0 dark to 1.0 bright.' },
          guidance: { type: Type.NUMBER, description: '0.0 to 6.0 prompt adherence.' },
          scale: { type: Type.STRING, enum: SCALE_NAMES, description: 'Forces an audible restart.' },
          muteBass: { type: Type.BOOLEAN },
          muteDrums: { type: Type.BOOLEAN },
        },
        required: ['type'],
      },
    },
  },
  required: ['reasoning', 'actions'],
};

interface RawAction {
  type: string;
  target?: string;
  label?: string;
  prompt?: string;
  volume?: number;
  muted?: boolean;
  bpm?: number;
  density?: number;
  brightness?: number;
  guidance?: number;
  scale?: string;
  muteBass?: boolean;
  muteDrums?: boolean;
}

/** Drops anything malformed rather than letting a bad action corrupt the mix. */
export function normalize(raw: RawAction[], origin: string): Action[] {
  const out: Action[] = [];

  for (const r of raw ?? []) {
    switch (r.type) {
      case 'ADD_TRACK':
        if (!r.prompt) break;
        out.push({
          type: 'ADD_TRACK',
          label: r.label || r.prompt.split(/[,.]/)[0].slice(0, 24),
          prompt: r.prompt,
          volume: r.volume ?? 0.8,
          origin,
        });
        break;

      case 'REMOVE_TRACK':
        if (r.target) out.push({ type: 'REMOVE_TRACK', target: r.target });
        break;

      case 'MODIFY_TRACK':
        if (r.target && (r.prompt || r.label))
          out.push({ type: 'MODIFY_TRACK', target: r.target, label: r.label, prompt: r.prompt });
        break;

      case 'SET_VOLUME':
        if (r.target && r.volume != null)
          out.push({ type: 'SET_VOLUME', target: r.target, volume: r.volume });
        break;

      case 'SET_MUTED':
        if (r.target && r.muted != null)
          out.push({ type: 'SET_MUTED', target: r.target, muted: r.muted });
        break;

      case 'SET_CONFIG': {
        const config: Partial<MixConfig> = {};
        if (r.bpm != null) config.bpm = r.bpm;
        if (r.density != null) config.density = r.density;
        if (r.brightness != null) config.brightness = r.brightness;
        if (r.guidance != null) config.guidance = r.guidance;
        if (r.muteBass != null) config.muteBass = r.muteBass;
        if (r.muteDrums != null) config.muteDrums = r.muteDrums;
        if (r.scale && SCALE_NAMES.includes(r.scale as Scale)) config.scale = r.scale as Scale;
        if (Object.keys(config).length) out.push({ type: 'SET_CONFIG', config });
        break;
      }

      case 'CLEAR_TRACKS':
        out.push({ type: 'CLEAR_TRACKS' });
        break;

      case 'RESET_CONTEXT':
        out.push({ type: 'RESET_CONTEXT' });
        break;
    }
  }

  return out;
}
