import type { MixConfig } from '../core/types';
import {
  CAPABILITIES,
  type EngineCapabilities,
  type EngineEvents,
  type EngineStatus,
  type MusicEngine,
  type PromptWeight,
} from './engine';
import { PromptMixer } from './mixer';
import { PcmScheduler } from './scheduler';

export const DEFAULT_BRIDGE_URL = 'ws://localhost:8765';

/** MRT2 emits 48kHz stereo; the bridge sends raw interleaved int16. */
const SAMPLE_RATE = 48000;

/**
 * Talks to the local Python bridge in `server/magenta_bridge.py`, which wraps
 * MagentaRT2System. Control messages are JSON; audio comes back as binary
 * frames so we skip base64 entirely.
 *
 * MRT2 has no tempo or key conditioning, so bpm/scale/density/brightness in
 * MixConfig are deliberately dropped here — see CAPABILITIES.magenta.
 */
export class MagentaEngine implements MusicEngine {
  readonly capabilities: EngineCapabilities = CAPABILITIES.magenta;

  private socket?: WebSocket;
  private scheduler?: PcmScheduler;
  private mixer: PromptMixer;
  private status: EngineStatus = 'idle';
  private masterVolume = 0.8;

  constructor(
    private url: string = DEFAULT_BRIDGE_URL,
    private events: EngineEvents = {},
  ) {
    this.mixer = new PromptMixer(
      (prompts) => this.send({ type: 'prompts', prompts }),
      this.capabilities.maxPrompts,
    );
  }

  private setStatus(status: EngineStatus, detail?: string) {
    this.status = status;
    this.events.onStatus?.(status, detail);
  }

  private send(message: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  async connect(): Promise<void> {
    if (this.socket) return;
    this.setStatus('connecting');

    this.scheduler = new PcmScheduler(this.masterVolume);
    await this.scheduler.resume();

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;

      // Model load plus warmup is slow on a cold start; fail loudly rather
      // than hanging the UI forever.
      const timeout = setTimeout(() => {
        socket.close();
        reject(
          new Error(
            `Magenta bridge did not respond at ${this.url}. Is server/magenta_bridge.py running?`,
          ),
        );
      }, 120_000);

      socket.onopen = () => {
        clearTimeout(timeout);
        this.setStatus('ready');
        resolve();
      };

      socket.onerror = () => {
        clearTimeout(timeout);
        const detail = `Cannot reach Magenta bridge at ${this.url}`;
        this.setStatus('error', detail);
        reject(new Error(detail));
      };

      socket.onclose = () => {
        this.socket = undefined;
        this.setStatus('idle', 'bridge disconnected');
      };

      socket.onmessage = (event: MessageEvent) => {
        if (event.data instanceof ArrayBuffer) {
          this.scheduler?.enqueueBytes(new Uint8Array(event.data), SAMPLE_RATE);
          if (this.scheduler) this.events.onBuffer?.(this.scheduler.bufferedSeconds);
          return;
        }

        try {
          const message = JSON.parse(event.data as string) as {
            type?: string;
            state?: EngineStatus;
            detail?: string;
          };
          if (message.type === 'status' && message.state) {
            this.setStatus(message.state, message.detail);
          } else if (message.type === 'error') {
            this.setStatus('error', message.detail ?? 'bridge error');
          }
        } catch {
          // Non-JSON text frame; ignore.
        }
      };
    });
  }

  setPrompts(prompts: PromptWeight[]): void {
    this.mixer.setTarget(prompts);
  }

  async setConfig(config: MixConfig): Promise<void> {
    // Only the parameters MRT2 actually conditions on. guidance maps onto
    // cfg_musiccoca; the bridge rescales it.
    this.send({
      type: 'config',
      guidance: config.guidance,
      muteDrums: config.muteDrums,
    });
  }

  play(): void {
    // Same as the Lyria path: connect() runs on page load, where the browser
    // refuses to start a context, so the gesture that reaches play() is the
    // first moment audio can actually be unblocked.
    void this.scheduler?.resume();
    this.scheduler?.unmute();
    this.send({ type: 'play' });
    this.setStatus('playing');
  }

  pause(): void {
    // Duck first — the bridge keeps streaming briefly and the queue already
    // holds seconds of audio, so silence has to come from this end.
    this.scheduler?.mute();
    this.send({ type: 'pause' });
    this.setStatus('paused');
  }

  stop(): void {
    this.send({ type: 'stop' });
    this.scheduler?.flush();
    this.setStatus('ready');
  }

  resetContext(): void {
    if (!this.scheduler) {
      this.send({ type: 'reset' });
      return;
    }
    // Duck first so the bridge's regeneration gap lands inside our silence.
    this.scheduler.reset(() => this.send({ type: 'reset' }));
  }

  setMasterVolume(volume: number): void {
    this.masterVolume = volume;
    this.scheduler?.setVolume(volume);
  }

  getLevels(bands: number): number[] | null {
    return this.scheduler?.getLevels(bands) ?? null;
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  async close(): Promise<void> {
    this.mixer.reset();
    this.socket?.close();
    this.socket = undefined;
    await this.scheduler?.close();
    this.scheduler = undefined;
    this.setStatus('idle');
  }
}
