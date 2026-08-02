import type { Backend, MixConfig } from '../core/types';

export type { Backend };

export type EngineStatus = 'idle' | 'connecting' | 'ready' | 'playing' | 'paused' | 'error';

export interface PromptWeight {
  text: string;
  weight: number;
}

/**
 * The two backends expose genuinely different control surfaces. Lyria takes
 * musical parameters (bpm, scale, density); MRT2 conditions on blended style
 * embeddings and has no notion of tempo or key at all. The UI and the planner
 * both read this so they never offer a knob that does nothing.
 */
export interface EngineCapabilities {
  bpm: boolean;
  scale: boolean;
  density: boolean;
  brightness: boolean;
  guidance: boolean;
  muteBass: boolean;
  muteDrums: boolean;
  maxPrompts: number;
}

export interface EngineEvents {
  onStatus?: (status: EngineStatus, detail?: string) => void;
  onFilteredPrompt?: (text: string, reason: string) => void;
  onBuffer?: (seconds: number) => void;
}

export interface MusicEngine {
  readonly capabilities: EngineCapabilities;
  connect(): Promise<void>;
  setPrompts(prompts: PromptWeight[]): void;
  setConfig(config: MixConfig): Promise<void>;
  play(): void;
  pause(): void;
  stop(): void;
  resetContext(): void;
  setMasterVolume(volume: number): void;
  /** Band energies 0..1 for a meter, or null before audio is running. */
  getLevels(bands: number): number[] | null;
  close(): Promise<void>;
}

export const CAPABILITIES: Record<Backend, EngineCapabilities> = {
  lyria: {
    bpm: true,
    scale: true,
    density: true,
    brightness: true,
    guidance: true,
    muteBass: true,
    muteDrums: true,
    maxPrompts: 8,
  },
  // MRT2 conditions on MusicCoCa style embeddings. Guidance maps to
  // cfg_musiccoca and drums to the binary drums channel; there is no tempo,
  // key, density, brightness, or bass control. kMaxPrompts is 6 in the engine.
  magenta: {
    bpm: false,
    scale: false,
    density: false,
    brightness: false,
    guidance: true,
    muteBass: false,
    muteDrums: true,
    maxPrompts: 6,
  },
};

export const BACKEND_LABELS: Record<Backend, string> = {
  lyria: 'Lyria RealTime',
  magenta: 'Magenta RT2 (local)',
};
