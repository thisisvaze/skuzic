import {
  GoogleGenAI,
  Scale,
  type LiveMusicGenerationConfig,
  type LiveMusicServerMessage,
  type LiveMusicSession,
} from '@google/genai';
import { CALM, inCalm, type MixConfig } from '../core/types';
import { geminiAuth, relayPass } from '../lib/relay';
import {
  CAPABILITIES,
  type EngineCapabilities,
  type EngineEvents,
  type EngineStatus,
  type Lead,
  type MusicEngine,
  type PromptWeight,
} from './engine';
import { PromptMixer } from './mixer';
import { PcmScheduler } from './scheduler';

export const MUSIC_MODEL = 'models/lyria-realtime-exp';

/**
 * Asks Google whether a pasted key can open Lyria, before anything is saved:
 * one free read of the music model's details, so a typo, a restricted key or
 * a country without Lyria shows up here instead of as a band that won't start.
 * Resolves to null when the key works, or to what to tell the artist.
 */
export async function checkGeminiKey(key: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  let res: Response;
  try {
    res = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/${MUSIC_MODEL}`, {
      headers: { 'x-goog-api-key': key },
    });
  } catch {
    return "Couldn't reach Google. Check your connection and try again.";
  }
  // Rate limited still means Google knows the key.
  if (res.ok || res.status === 429) return null;
  if (res.status === 400 || res.status === 401) {
    return "Google didn't accept this key. Copy it again from AI Studio and paste the whole thing.";
  }
  if (res.status === 403) {
    return 'This key is restricted, or the Gemini API is off for its project. A new key from AI Studio works.';
  }
  if (res.status === 404) {
    return "This key works, but Google doesn't offer Lyria RealTime to it yet, likely because of your country.";
  }
  return `Google couldn't check the key just now (error ${res.status}). Try again in a moment.`;
}

export function toApiConfig(config: MixConfig): LiveMusicGenerationConfig {
  return {
    bpm: config.bpm,
    density: inCalm(CALM.density, config.density),
    brightness: inCalm(CALM.brightness, config.brightness),
    guidance: config.guidance,
    muteBass: config.muteBass,
    muteDrums: config.muteDrums,
    ...(config.scale !== Scale.SCALE_UNSPECIFIED ? { scale: config.scale } : {}),
  };
}

function sameTempoAndKey(a: LiveMusicGenerationConfig, b: LiveMusicGenerationConfig): boolean {
  return a.bpm === b.bpm && a.scale === b.scale;
}

export class LyriaEngine implements MusicEngine {
  readonly capabilities: EngineCapabilities = CAPABILITIES.lyria;

  private ai: GoogleGenAI;
  private session?: LiveMusicSession;
  private scheduler?: PcmScheduler;
  private ready?: Promise<void>;
  private mixer: PromptMixer;
  private flushing = false;
  private pending?: PromptWeight[];
  private status: EngineStatus = 'idle';
  private masterVolume = 0.8;
  /** Set by close(), so a socket closing after it isn't mistaken for a drop. */
  private closing = false;
  private openedAt = 0;
  private failSetup?: (error: Error) => void;
  /** What the band was last told, to tell a reopened session the same. */
  private lastConfig?: MixConfig;
  private lastPrompts?: PromptWeight[];
  /**
   * The tempo and key of the last chunk to arrive. Lyria tags every chunk with
   * the config that made it, and a chunk already in flight at a reset is still
   * the old tempo, so the tag is what says where the new one starts.
   */
  private heard?: LiveMusicGenerationConfig;

  /** An empty key plays through the hosted demo's relay (src/lib/relay.ts). */
  constructor(
    private apiKey: string,
    private events: EngineEvents = {},
  ) {
    // Lyria RealTime is experimental and only exposed on the v1alpha surface.
    this.ai = new GoogleGenAI({ ...geminiAuth(apiKey), apiVersion: 'v1alpha' });
    this.mixer = new PromptMixer(
      (prompts) => void this.flush(prompts),
      this.capabilities.maxPrompts,
    );
  }

  private setStatus(status: EngineStatus, detail?: string) {
    this.status = status;
    this.events.onStatus?.(status, detail);
  }

  async connect(): Promise<void> {
    if (this.session) return;
    this.closing = false;
    this.setStatus('connecting');

    this.scheduler = new PcmScheduler(this.masterVolume);
    this.scheduler.resume();
    await this.open();
  }

  /** Opens a session and waits for setupComplete; rejects if it closes first. */
  private async open(): Promise<LiveMusicSession> {
    if (!this.apiKey) await relayPass();
    let markReady: () => void;
    this.ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      this.failSetup = reject;
    });
    this.openedAt = Date.now();

    this.session = await this.ai.live.music.connect({
      model: MUSIC_MODEL,
      callbacks: {
        onmessage: (message: LiveMusicServerMessage) => {
          // The server requires setupComplete before it accepts client messages.
          if (message.setupComplete) {
            // A reopened session leaves a playing band's status alone.
            if (this.status === 'connecting') this.setStatus('ready');
            this.failSetup = undefined;
            markReady();
          }

          if (message.filteredPrompt) {
            this.events.onFilteredPrompt?.(
              message.filteredPrompt.text ?? '',
              message.filteredPrompt.filteredReason ?? 'filtered',
            );
          }

          for (const chunk of message.serverContent?.audioChunks ?? []) {
            const made = chunk.sourceMetadata?.musicGenerationConfig;
            const swap = !!made && !!this.heard && !sameTempoAndKey(made, this.heard);
            if (made) this.heard = made;
            if (chunk.data) this.scheduler?.enqueue(chunk.data, chunk.mimeType, swap);
          }
          if (this.scheduler) this.events.onBuffer?.(this.scheduler.bufferedSeconds);
        },
        onerror: (error: unknown) => {
          this.setStatus('error', error instanceof Error ? error.message : String(error));
        },
        onclose: (event: CloseEvent) => void this.closed(event.reason),
      },
    });

    const session = this.session;
    await this.ready;
    return session;
  }

  /**
   * Google ends a Lyria session after about ten minutes, and the hosted demo's
   * relay after five (Vercel Hobby's function limit). A session that ran a
   * while and then closed is reopened with the same mix, so the band carries
   * on after a dip of a second or two. One that dies young is a real failure,
   * like a bad key or a used-up quota, and reconnecting would only loop.
   * ponytail: a dip per reopen; open the next session before the cap and
   * crossfade if it's ever noticeable.
   */
  private async closed(reason: string) {
    this.session = undefined;
    if (this.closing) return;
    const why = reason || 'The music stream closed.';
    if (this.failSetup || Date.now() - this.openedAt < 30_000) {
      this.failSetup?.(new Error(why));
      this.setStatus('error', why);
      return;
    }
    try {
      const session = await this.open();
      if (this.lastConfig) await session.setMusicGenerationConfig({ musicGenerationConfig: toApiConfig(this.lastConfig) });
      if (this.lastPrompts) await session.setWeightedPrompts({ weightedPrompts: this.lastPrompts });
      if (this.status === 'playing') session.play();
    } catch (error) {
      this.setStatus('error', error instanceof Error ? error.message : String(error));
    }
  }

  setPrompts(prompts: PromptWeight[]): void {
    this.mixer.setTarget(prompts);
  }

  /**
   * The mixer sends every few hundred ms, which can still outpace a slow
   * round-trip to the API. Coalesce rather than drop: stale intermediate
   * frames of a ramp are safe to skip, but the final frame carries the target
   * weights — dropping it leaves the mix permanently short of what the user
   * asked for.
   */
  private async flush(weightedPrompts: PromptWeight[]): Promise<void> {
    if (!this.session) return;
    this.pending = weightedPrompts;
    if (this.flushing) return;

    this.flushing = true;
    try {
      while (this.pending) {
        const next = this.pending;
        this.pending = undefined;
        this.lastPrompts = next;
        await this.session.setWeightedPrompts({ weightedPrompts: next });
      }
    } catch (error) {
      this.setStatus('error', error instanceof Error ? error.message : String(error));
    } finally {
      this.flushing = false;
    }
  }

  async setConfig(config: MixConfig): Promise<void> {
    this.lastConfig = config;
    if (!this.session) return;
    await this.ready;
    await this.session.setMusicGenerationConfig({
      musicGenerationConfig: toApiConfig(config),
    });
  }

  private pauseTimer: ReturnType<typeof setTimeout> | null = null;

  play(): void {
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    // connect() resumes too, but it runs on page load where the browser will
    // not allow it. play() is only ever reached from a user gesture, so this is
    // the call that actually makes a suspended context audible.
    this.scheduler?.resume();
    this.scheduler?.unmute();
    this.session?.play();
    this.setStatus('playing');
  }

  pause(fadeSeconds?: number): void {
    // Duck first: the model keeps streaming for a moment after pause(), and the
    // queue already holds seconds of audio. Without this the sound would run on
    // past the button press.
    this.scheduler?.mute(fadeSeconds);
    this.setStatus('paused');
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    if (!fadeSeconds) {
      this.session?.pause();
      return;
    }
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null;
      this.session?.pause();
    }, fadeSeconds * 1000);
  }

  stop(): void {
    this.session?.stop();
    this.scheduler?.flush();
    this.setStatus('ready');
  }

  /**
   * Required after a bpm or scale change. The model restarts at once; what is
   * already queued plays out and fades into the new music. A new tempo or key
   * swaps on the chunk tagged with it, so only other resets guess.
   */
  resetContext(): void {
    const tagged = this.lastConfig && this.heard && !sameTempoAndKey(toApiConfig(this.lastConfig), this.heard);
    if (!this.scheduler || tagged) {
      this.session?.resetContext();
      return;
    }
    this.scheduler.reset(() => this.session?.resetContext());
  }

  setMasterVolume(volume: number): void {
    this.masterVolume = volume;
    this.scheduler?.setVolume(volume);
  }

  lead(lead: Lead): void {
    this.scheduler?.lead(lead);
  }

  getLevels(bands: number): number[] | null {
    return this.scheduler?.getLevels(bands) ?? null;
  }

  getBufferedSeconds(): number {
    return this.scheduler?.bufferedSeconds ?? 0;
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  async close(): Promise<void> {
    this.closing = true;
    this.mixer.reset();
    this.session?.stop();
    // Hang up too: on the demo, an open socket is relay time and bandwidth.
    this.session?.close();
    this.session = undefined;
    await this.scheduler?.close();
    this.scheduler = undefined;
    this.setStatus('idle');
  }
}
