import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Pause, Play, SettingsIcon, SlidersHorizontal, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import {
  BACKEND_LABELS,
  CAPABILITIES,
  type EngineEvents,
  type EngineStatus,
  type MusicEngine,
} from './audio/engine';
import { LyriaEngine } from './audio/lyria';
import { DEFAULT_BRIDGE_URL, MagentaEngine } from './audio/magenta';
import { reduce, reduceAll } from './core/reducer';
import { INITIAL_STATE, type Action, type Backend, type SkuzicState } from './core/types';
import { addRecord, countRecords, exportDataset, type AbRecord } from './lib/dataset';
import { KEYS, load, save } from './lib/persist';
import { logSession } from './lib/sessionlog';
import {
  DEFAULT_PLANNER_CONFIG,
  PLANNER_CONFIGS,
  PLANNER_CONFIG_LIST,
  type PlannerConfigId,
} from './llm/configs';
import {
  DEFAULT_PLANNER_MODEL,
  createPlanner,
  isPlannerModel,
  type Plan,
  type PlannerModel,
} from './llm/planner';
import {
  INTRO,
  eyesOwn,
  loadEyes,
  mixActions,
  nextMix,
  readPage,
  type Mix,
} from './vision/eyes';
import { inkConfig, inkOf, type Ink } from './vision/ink';
import { AbChoice } from './ui/AbChoice';
import { ActionLog, type LogEntry } from './ui/ActionLog';
import { ApiKeyField } from './ui/ApiKeyField';
import { DrawCanvas, type CanvasHandle } from './ui/DrawCanvas';
import { Equalizer } from './ui/Equalizer';
import { Landing, Wordmark } from './ui/Landing';
import { Mixer } from './ui/Mixer';
import { Settings, type Theme } from './ui/Settings';

const BRIDGE_URL =
  (import.meta.env.VITE_MAGENTA_BRIDGE_URL as string | undefined) || DEFAULT_BRIDGE_URL;

/** A stored backend from an older build may name one that no longer exists. */
function loadBackend(fallback: Backend): Backend {
  const saved = load<string>(KEYS.backend, fallback);
  return saved in BACKEND_LABELS ? (saved as Backend) : fallback;
}

type Planner = ReturnType<typeof createPlanner>;

/** Wide enough for the mixer to sit beside the paper instead of over it (Tailwind's lg). */
const wide = () => window.matchMedia('(min-width: 1024px)').matches;

/** One arm of a pending A/B choice, with its resulting mix precomputed. */
interface AbVariantPlan {
  configId: PlannerConfigId;
  model: PlannerModel;
  plan: Plan;
  /** reduceAll(base, plan.actions) — what auditioning this arm sounds like. */
  next: SkuzicState;
}

/** Two plans for the same event, waiting on the user's ear. */
interface PendingAb {
  event: string;
  image?: string;
  base: SkuzicState;
  /** Display order — [0] is A, [1] is B. Shuffled so A isn't always the same arm. */
  variants: AbVariantPlan[];
  /** Canvas encode ms and buffer seconds at plan time, for the log entry. */
  encode: number;
  buffer: number;
  shownAt: number;
}

const DOT: Record<EngineStatus, string> = {
  idle: 'bg-muted-foreground/50',
  connecting: 'bg-warn animate-pulse',
  ready: 'bg-muted-foreground',
  playing: 'bg-live',
  paused: 'bg-muted-foreground',
  error: 'bg-destructive',
};

export default function App() {
  // Engine settings survive a reload; tracks deliberately do not, since the
  // mix only means something alongside the drawing that produced it.
  const [state, dispatch] = useReducer(reduce, INITIAL_STATE, (initial) => ({
    ...initial,
    backend: loadBackend(initial.backend),
    config: load(KEYS.config, initial.config),
  }));
  const [status, setStatus] = useState<EngineStatus>('idle');
  const [statusDetail, setStatusDetail] = useState('');
  const [buffered, setBuffered] = useState(0);
  const [masterVolume, setMasterVolume] = useState(() => load(KEYS.masterVolume, 0.8));
  const [thinking, setThinking] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  /** First visit, or the wordmark: the landing. A saved key goes straight to drawing. */
  const [view, setView] = useState<'landing' | 'studio'>(() =>
    load(KEYS.apiKey, '') ? 'studio' : 'landing',
  );
  /** Docked beside the paper on wide screens, where it starts open; a sheet on phones, where it starts closed. */
  const [mixerOpen, setMixerOpen] = useState(() => wide() && load(KEYS.mixerOpen, true));
  const showMixer = (open: boolean) => {
    setMixerOpen(open);
    if (wide()) save(KEYS.mixerOpen, open);
  };
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** What the top bar says the band is hearing: a scene, or Gemini's take. */
  const [scene, setScene] = useState<string | null>(null);
  // index.html sets the class before first paint; this keeps it in sync with
  // the setting, and with the system while the setting says to follow it.
  const [theme, setTheme] = useState<Theme>(() => load<Theme>(KEYS.theme, 'system'));
  useEffect(() => {
    save(KEYS.theme, theme);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches);
      document.documentElement.classList.toggle('dark', dark);
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', dark ? '#131417' : '#eff0f3');
    };
    apply();
    if (theme !== 'system') return;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  const [autoInterpret, setAutoInterpret] = useState(() => load(KEYS.autoInterpret, true));
  const [abTest, setAbTest] = useState(() => load(KEYS.abTest, false));
  const [pendingAb, setPendingAb] = useState<PendingAb | null>(null);
  /** Which pending variant the engine is playing right now. */
  const [abAudition, setAbAudition] = useState(0);
  /**
   * The second stream that makes A/B switching instant. Needs its own Gemini
   * key (two Lyria sessions on one key contend), which we don't collect, so
   * this stays 'off' and switching cuts the single stream.
   */
  const [auditionMode, setAuditionMode] = useState<'off' | 'warming' | 'ready' | 'failed'>('off');
  const [datasetCount, setDatasetCount] = useState(0);
  const [plannerModel, setPlannerModel] = useState<PlannerModel>(() => {
    const saved = load(KEYS.plannerModel, DEFAULT_PLANNER_MODEL);
    return isPlannerModel(saved) ? saved : DEFAULT_PLANNER_MODEL;
  });
  const [plannerConfig, setPlannerConfig] = useState<PlannerConfigId>(() => {
    const saved = load(KEYS.plannerConfig, DEFAULT_PLANNER_CONFIG);
    return saved in PLANNER_CONFIGS ? (saved as PlannerConfigId) : DEFAULT_PLANNER_CONFIG;
  });
  const [apiKey, setApiKey] = useState(() => load(KEYS.apiKey, ''));
  const apiKeyRef = useRef(apiKey);
  apiKeyRef.current = apiKey;

  const commitKey = (value: string) => {
    const trimmed = value.trim();
    apiKeyRef.current = trimmed;
    setApiKey(trimmed);
    save(KEYS.apiKey, trimmed);
  };

  const engineRef = useRef<MusicEngine | null>(null);
  /** The muted second stream playing variant B during an A/B choice. */
  const auditionEngineRef = useRef<MusicEngine | null>(null);
  /** Buffer depth of the audition stream, reported through its own events. */
  const abBufferRef = useRef(0);
  const plannerRef = useRef<ReturnType<typeof createPlanner> | null>(null);
  /**
   * Arm B's planner, on the B key when there is one. Rate limits are per key,
   * and an A/B round is two simultaneous calls — splitting them across keys is
   * what keeps rounds from tripping 429s and collapsing to one plan.
   */
  const plannerBRef = useRef<ReturnType<typeof createPlanner> | null>(null);
  const canvasRef = useRef<CanvasHandle>(null);
  const logSeq = useRef(0);

  const inFlight = useRef(false);
  const queued = useRef<{ event: string; includeDrawing: boolean } | null>(null);
  /** Read inside runPlan, where the `buffered` state value would be a stale closure. */
  const bufferRef = useRef(0);

  // The planner needs the mix as of the moment the button was tapped, not as of
  // the render that created the handler.
  const stateRef = useRef<SkuzicState>(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Same reason: runPlan is a stable callback, so it would otherwise capture
  // whichever strategy was selected when it was created.
  const configRef = useRef<PlannerConfigId>(plannerConfig);
  useEffect(() => {
    configRef.current = plannerConfig;
  }, [plannerConfig]);

  const abTestRef = useRef(abTest);
  useEffect(() => {
    abTestRef.current = abTest;
  }, [abTest]);

  const plannerModelRef = useRef<PlannerModel>(plannerModel);
  useEffect(() => {
    plannerModelRef.current = plannerModel;
  }, [plannerModel]);

  // Written by hand alongside setPendingAb rather than synced in an effect —
  // runPlan gates on it, and a gate that lags a render is a gate with a hole.
  const pendingAbRef = useRef<PendingAb | null>(null);

  // Read inside stable callbacks (auditionAb, the watchdog, the volume
  // effect) where the state values would be stale closures.
  const abAuditionRef = useRef(0);
  useEffect(() => {
    abAuditionRef.current = abAudition;
  }, [abAudition]);
  const masterVolumeRef = useRef(masterVolume);
  useEffect(() => {
    masterVolumeRef.current = masterVolume;
  }, [masterVolume]);

  useEffect(() => {
    void countRecords().then(setDatasetCount);
  }, []);

  const pushLog = useCallback((entry: Omit<LogEntry, 'id'>) => {
    // Everything the log shows also lands in .logs/ on disk (dev only), so a
    // session can be replayed when iterating on the planner prompts.
    logSession('log', entry);
    setLog((prev) => [{ ...entry, id: ++logSeq.current }, ...prev].slice(0, 40));
  }, []);

  const caps = CAPABILITIES[state.backend];

  // ---- state -> engine sync ------------------------------------------------

  const hasPlayed = useRef(false);
  /** Set when the empty-mix branch below paused playback, so only that pause auto-resumes. */
  const autoPaused = useRef(false);
  /** Read inside the tracks effect, which must not re-run (and re-steer) on status changes. */
  const statusRef = useRef<EngineStatus>('idle');
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;

    const live = state.tracks.filter((t) => !t.muted && t.volume > 0);

    // Both backends reject an empty prompt list, so a mix that is all deleted,
    // muted, or zeroed cannot be expressed as prompts. Treat it as silence
    // rather than holding the last audible mix. Only a pause taken here is
    // undone here — the transport button's pause belongs to the user.
    if (!live.length) {
      if (statusRef.current === 'playing') {
        autoPaused.current = true;
        engine.pause();
      }
      return;
    }

    engine.setPrompts(live.map((t) => ({ text: t.prompt, weight: t.volume })));

    if (autoPaused.current) {
      autoPaused.current = false;
      engine.play();
      return;
    }

    // Never start audio on a blank pad — wait until there is ink and a mix.
    if (!hasPlayed.current && !canvasRef.current?.isEmpty()) {
      hasPlayed.current = true;
      engine.play();
    }
  }, [state.tracks]);

  const prevConfig = useRef(state.config);
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    void engine.setConfig(state.config);

    // Only Lyria restarts on tempo/key changes; MRT2 has neither control.
    const prev = prevConfig.current;
    const tempoChanged = engine.capabilities.bpm && prev.bpm !== state.config.bpm;
    const keyChanged = engine.capabilities.scale && prev.scale !== state.config.scale;
    if (tempoChanged || keyChanged) engine.resetContext();
    prevConfig.current = state.config;
  }, [state.config]);

  const firstEpoch = useRef(true);
  useEffect(() => {
    if (firstEpoch.current) {
      firstEpoch.current = false;
      return;
    }
    engineRef.current?.resetContext();
  }, [state.contextEpoch]);

  useEffect(() => {
    // During a dual-stream audition the slider belongs to whichever arm is
    // audible; the other stays hard-muted or the point of the mute is lost.
    const audition = auditionEngineRef.current;
    if (audition && abAuditionRef.current === 1) audition.setMasterVolume(masterVolume);
    else engineRef.current?.setMasterVolume(masterVolume);
    save(KEYS.masterVolume, masterVolume);
  }, [masterVolume]);

  // bpm, density, brightness, guidance, scale and the mutes, however they were
  // changed — by hand in the panel or by the planner.
  useEffect(() => {
    save(KEYS.config, state.config);
  }, [state.config]);

  // Swap the planner in place so the picker takes effect mid-session rather
  // than only on the next start. A plan already in flight finishes on the old
  // model — runPlan compares identity and discards it, which is the right call
  // since it was planned against a model the user just moved off.
  useEffect(() => {
    if (plannerRef.current) plannerRef.current = createPlanner(apiKeyRef.current, plannerModel);
    if (plannerBRef.current)
      plannerBRef.current = createPlanner(apiKeyRef.current, plannerModel);
  }, [plannerModel]);

  useEffect(
    () => () => {
      void engineRef.current?.close();
      void auditionEngineRef.current?.close();
    },
    [],
  );

  useEffect(() => {
    if (!mixerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      // Only the phone sheet covers the paper; the desktop column stays put.
      if (e.key === 'Escape' && !wide()) setMixerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mixerOpen]);

  /**
   * Point the engine at a candidate state without touching the reducer — how
   * an A/B arm is auditioned before either one is committed. Mirrors the
   * tracks effect above (including the empty-mix pause), plus config, which
   * the effect leaves to its own sync.
   */
  const steerEngine = useCallback((s: SkuzicState) => {
    const engine = engineRef.current;
    if (!engine) return;

    const live = s.tracks.filter((t) => !t.muted && t.volume > 0);
    if (!live.length) {
      if (statusRef.current === 'playing') {
        autoPaused.current = true;
        engine.pause();
      }
      return;
    }

    engine.setPrompts(live.map((t) => ({ text: t.prompt, weight: t.volume })));
    void engine.setConfig(s.config);

    if (autoPaused.current) {
      autoPaused.current = false;
      engine.play();
      return;
    }
    if (!hasPlayed.current && !canvasRef.current?.isEmpty()) {
      hasPlayed.current = true;
      engine.play();
    }
  }, []);

  /**
   * Events for any engine, main or audition. Only the engine currently in
   * engineRef drives the UI; everything else (the muted A/B arm, an engine
   * just retired by a keep-B swap or a racing stop) is routed to the side.
   * That routing is what lets chooseAb promote the audition engine to main by
   * swapping one ref.
   */
  const makeEvents = useCallback(
    (box: { engine: MusicEngine | null }): EngineEvents => ({
      onStatus: (s: EngineStatus, detail?: string) => {
        if (engineRef.current !== box.engine) {
          // A muted arm's health is not the app's health — only its failures
          // deserve a line.
          if (s === 'error' && detail) pushLog({ event: 'A/B stream error', error: detail });
          return;
        }
        setStatus(s);
        setStatusDetail(detail ?? '');
        if (s === 'error' && detail) pushLog({ event: 'engine error', error: detail });
      },
      // A filtered prompt matters in either arm — that arm no longer sounds
      // like the plan the user is judging.
      onFilteredPrompt: (text: string, reason: string) =>
        pushLog({ event: 'prompt filtered', error: `“${text}” — ${reason}` }),
      onBuffer: (seconds: number) => {
        if (engineRef.current !== box.engine) {
          abBufferRef.current = seconds;
          // First buffered chunk: switching is now a pure gain flip.
          if (seconds > 0) setAuditionMode((m) => (m === 'warming' ? 'ready' : m));
          return;
        }
        bufferRef.current = seconds;
        setBuffered(seconds);
      },
    }),
    [pushLog],
  );

  /**
   * Dual-stream A/B needs a second Gemini key (two Lyria sessions on one key
   * contend). We only collect one, so switching cuts the single stream.
   */
  const spawnAudition = useCallback(async (_next: SkuzicState) => {
    void _next;
  }, []);

  // ---- transport -----------------------------------------------------------

  const start = async (backend: Backend = stateRef.current.backend) => {
    const key = apiKeyRef.current;
    if (!key) return;

    // engineRef outlives the engine. A stream that closes or errors reports it
    // through the status callbacks rather than by throwing, so `catch` never
    // runs and the ref stays set while the status drops back to idle/error —
    // which is exactly when the start gate reappears. Bailing on the ref alone
    // therefore left the button inert until a page reload. Tear the dead engine
    // down instead, and only refuse when one is genuinely still connected.
    if (engineRef.current) {
      if (connected) return;
      await stop();
    }

    const box: { engine: MusicEngine | null } = { engine: null };
    const engine: MusicEngine =
      backend === 'lyria'
        ? new LyriaEngine(key, makeEvents(box))
        : new MagentaEngine(BRIDGE_URL, makeEvents(box));
    box.engine = engine;

    engineRef.current = engine;
    // The planner always runs on Gemini, whichever backend makes the audio.
    plannerRef.current = createPlanner(key, plannerModel);
    plannerBRef.current = createPlanner(key, plannerModel);
    if (autoInterpret) warmEyes();

    try {
      await engine.connect();
      // Switching backends mid-connect replaces engineRef while this await is
      // still pending. Without this guard the stale start goes on to configure
      // and play a closed engine, and its catch nulls the *new* engine's ref.
      if (engineRef.current !== engine) {
        void engine.close();
        return;
      }
      engine.setMasterVolume(masterVolume);

      await engine.setConfig(stateRef.current.config);

      // Both backends reject an empty prompt list, so playback waits until the
      // mix has something *and* the pad isn't blank — see the tracks effect.
      const live = stateRef.current.tracks.filter((t) => !t.muted && t.volume > 0);
      if (live.length && !canvasRef.current?.isEmpty()) {
        engine.setPrompts(live.map((t) => ({ text: t.prompt, weight: t.volume })));
        hasPlayed.current = true;
        engine.play();
      }
    } catch (error) {
      if (engineRef.current !== engine) return;
      const message = error instanceof Error ? error.message : String(error);
      pushLog({ event: 'connect failed', error: message });
      setStatus('error');
      setStatusDetail(message);
      engineRef.current = null;
    }
  };

  const stop = async () => {
    // Teardown must not be able to fail partway: an exception here would leave
    // engineRef set, which is the state that makes start() inert.
    try {
      await engineRef.current?.close();
    } catch {
      // Already gone; the refs still need clearing.
    }
    engineRef.current = null;
    plannerRef.current = null;
    plannerBRef.current = null;
    hasPlayed.current = false;
    autoPaused.current = false;
    // A pending A/B choice belongs to the session that produced it.
    try {
      await auditionEngineRef.current?.close();
    } catch {
      // Same as above: the refs still need clearing.
    }
    auditionEngineRef.current = null;
    pendingAbRef.current = null;
    setPendingAb(null);
    setAbAudition(0);
    setAuditionMode('off');
    setStatus('idle');
    setBuffered(0);
    // The next session reads the page fresh rather than assuming the old scene.
    mixRef.current = null;
    setScene(null);
  };

  /**
   * Switching mid-session swaps the engine under the same mix; the reducer
   * trims tracks past the new backend's cap. Passing the backend explicitly
   * matters: stateRef only sees the dispatch after the next render.
   *
   * Deliberately allowed *during* a connect. A backend whose server isn't
   * there — the local Magenta bridge, usually — sits in 'connecting' forever,
   * and locking the picker while it does is what traps you on it.
   */
  const switchBackend = async (next: Backend) => {
    if (next === stateRef.current.backend) return;
    dispatch({ type: 'SET_BACKEND', backend: next });
    // The engines want different balances of the same mix, so re-weight it,
    // unless Gemini or the user has rewritten the tracks since the eyes chose.
    const mix = mixRef.current;
    if (mix && eyesOwn(stateRef.current.tracks, mix)) {
      const { density, brightness } = stateRef.current.config;
      mixActions(mix, next, { density, brightness }).forEach((action) => dispatch(action));
    }
    save(KEYS.backend, next);
    if (!engineRef.current) return;
    await stop();
    await start(next);
  };

  // Same as iOS: connect as soon as the page loads so drawing later does not
  // need another Start tap. Playback still waits for ink + a live mix.
  useEffect(() => {
    if (!apiKeyRef.current) return;
    void start();
    // Intentionally once on mount — start() is re-entered via the overlay after stop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connected = status !== 'idle' && status !== 'error';
  const playing = status === 'playing';
  // `playing` flips the instant we send the command, but Lyria still has to
  // generate and stream a first chunk before there is anything to hear. Gate
  // the equalizer on audio actually being queued instead, or it bounces over
  // several seconds of silence.
  const audible = playing && buffered > 0;

  /** Stable identity so the equalizer's rAF loop isn't torn down each render. */
  const getLevels = useCallback((bands: number) => {
    // The meter should show what's audible — arm B when it's the one playing.
    const audition = auditionEngineRef.current;
    if (audition && abAuditionRef.current === 1) return audition.getLevels(bands) ?? null;
    return engineRef.current?.getLevels(bands) ?? null;
  }, []);

  // ---- the loop: event -> plan -> actions -> state --------------------------

  /**
   * One plan at a time, and at most one waiting behind it. Anything that
   * arrives mid-flight overwrites that slot instead of queueing, so a burst of
   * short strokes costs one follow-up call rather than one call per stroke —
   * and the follow-up reads the pad as it looks when the turn actually starts,
   * which is the newest state by definition.
   */
  const runPlan = useCallback(
    async (event: string, includeDrawing: boolean) => {
      if (!plannerRef.current || !event.trim()) return;
      // A choice on the table blocks new plans — a second pair arriving while
      // the first is being auditioned would pull the mix out from under it.
      if (pendingAbRef.current) return;

      if (inFlight.current) {
        queued.current = { event, includeDrawing };
        return;
      }

      inFlight.current = true;
      setThinking(true);
      let job: { event: string; includeDrawing: boolean } | null = { event, includeDrawing };

      try {
        while (job) {
          // Annotated because the null-check above plus the loop makes TS's
          // control-flow narrowing of the ref circular.
          const planner: Planner | null = plannerRef.current;
          if (!planner) break;

          // Captured because `job` is reassigned at the bottom of the loop,
          // which stops TS narrowing it inside closures and the catch below.
          const jobEvent = job.event;

          try {
            const encodeStart = performance.now();
            // Always send what's on the pad. Every event is judged against the
            // drawing, not just the explicit "interpret" tap — a typed event or
            // a preset should still see what the user has in front of them.
            const image = canvasRef.current?.isEmpty()
              ? undefined
              : canvasRef.current?.toDataURL();
            const encode = performance.now() - encodeStart;

            if (abTestRef.current) {
              // A/B: the same event planned twice — once by the selected
              // strategy, once by a random rival — then judged by ear.
              const base = stateRef.current;
              const model = plannerModelRef.current;
              const mine = configRef.current;
              const others = PLANNER_CONFIG_LIST.filter((c) => c.id !== mine);
              const rival = others[Math.floor(Math.random() * others.length)].id;
              // Shuffled so A is not reliably the user's own strategy — the
              // choice stays blind until it lands in the log.
              const pair: PlannerConfigId[] =
                Math.random() < 0.5 ? [mine, rival] : [rival, mine];

              // One arm per key: two calls on one key is a 429 magnet.
              const plannerB = plannerBRef.current ?? planner;
              const settled = await Promise.allSettled(
                pair.map((id, i) => (i === 0 ? planner : plannerB)(jobEvent, base, image, id)),
              );

              if (plannerRef.current === planner) {
                const failed = settled.findIndex((s) => s.status === 'rejected');
                const plans = settled.map((s) =>
                  s.status === 'fulfilled' ? s.value : null,
                );

                if (plans[0] && plans[1]) {
                  const variants = pair.map((configId, i) => {
                    const plan = plans[i] as Plan;
                    return { configId, model, plan, next: reduceAll(base, plan.actions) };
                  });
                  const pending: PendingAb = {
                    event: jobEvent,
                    image,
                    base,
                    variants,
                    encode,
                    buffer: bufferRef.current,
                    shownAt: Date.now(),
                  };
                  pendingAbRef.current = pending;
                  setPendingAb(pending);
                  setAbAudition(0);
                  // A starts playing immediately; the reset drops audio queued
                  // under the old mix so A is heard in ~a second, as a cut.
                  // B spins up muted on its own key so switching is instant.
                  steerEngine(variants[0].next);
                  engineRef.current?.resetContext();
                  // The pair exists because the user acted, so arm A must be
                  // audible even when the pad was cleared while the plans were
                  // in flight — steerEngine's blank-pad gate must not win here.
                  if (statusRef.current !== 'playing') {
                    hasPlayed.current = true;
                    engineRef.current?.play();
                  }
                  void spawnAudition(variants[1].next);
                  // A burst of strokes queued behind this pair is void now —
                  // planning is blocked until the user picks anyway.
                  queued.current = null;
                } else {
                  const survivor = plans[0] ?? plans[1];
                  const reason = (settled[failed] as PromiseRejectedResult).reason;
                  if (!survivor) throw reason instanceof Error ? reason : new Error(String(reason));
                  // Half an A/B is no test, but it is still a good steer:
                  // apply the surviving plan as if the mode were off. Name the
                  // failed arm's actual error — "fell back" alone hides
                  // whether this is rate limits or something new.
                  survivor.actions.forEach((action: Action) => dispatch(action));
                  pushLog({
                    event: `${jobEvent} — A/B arm failed`,
                    error: reason instanceof Error ? reason.message : String(reason),
                  });
                  pushLog({
                    event: `${jobEvent} — A/B fell back to one plan`,
                    reasoning: survivor.reasoning,
                    actions: survivor.actions,
                    timings: { ...survivor.timings, encode, buffer: bufferRef.current },
                  });
                }
              }
              job = queued.current;
              queued.current = null;
              continue;
            }

            const plan = await planner(
              jobEvent,
              stateRef.current,
              image,
              configRef.current,
            );
            // A reply that outlives its session is stale: stop() nulls the
            // planner and start() installs a new one.
            if (plannerRef.current === planner) {
              plan.actions.forEach((action: Action) => dispatch(action));
              setScene('your page, reimagined');
              canvasRef.current?.cue();
              pushLog({
                event: jobEvent,
                reasoning: plan.reasoning,
                actions: plan.actions,
                timings: {
                  ...plan.timings,
                  encode,
                  // Queue depth at the moment we steer. Nothing sent now is
                  // audible until this much already-scheduled audio has played,
                  // so it is the real floor on how fast a change is heard.
                  buffer: bufferRef.current,
                },
              });
            }
          } catch (error) {
            pushLog({
              event: jobEvent,
              error: error instanceof Error ? error.message : String(error),
            });
          }

          job = queued.current;
          queued.current = null;
        }
      } finally {
        inFlight.current = false;
        setThinking(false);
      }
    },
    [pushLog, steerEngine, spawnAudition],
  );

  /** Explicit user action: Gemini reads the page, or a typed event. */
  const trigger = useCallback(
    (event: string, includeDrawing = false) => void runPlan(event, includeDrawing),
    [runPlan],
  );

  // ---- the eyes: SigLIP reads the page on pen-up ---------------------------

  /** The mix the eyes last put on, so a reading that agrees changes nothing. */
  const mixRef = useRef<Mix | null>(null);
  const reading = useRef(false);
  const readAgain = useRef(false);

  /**
   * Pen-up, undo, redo and clear all land here. One reading at a time; strokes
   * that land mid-read collapse into one more read of the newest page. Only a
   * change of scene touches the mix, so a Gemini arrangement survives until the
   * drawing turns into something else.
   */
  const readDrawing = useCallback(async () => {
    if (reading.current) {
      readAgain.current = true;
      return;
    }
    reading.current = true;
    try {
      do {
        readAgain.current = false;
        const canvas = canvasRef.current;
        // A choice on the table owns the mix until the user picks.
        if (!engineRef.current || pendingAbRef.current || !canvas) return;

        const startedAt = performance.now();
        const playing = mixRef.current;
        let next: Mix | null = playing === INTRO ? null : INTRO;
        let ink: Ink = { coverage: 0, warmth: 0 };
        let reasoning = 'the page is empty';
        if (!canvas.isEmpty()) {
          const url = canvas.toDataURL();
          const [vector, page] = await Promise.all([(await loadEyes()).read(url), inkOf(url)]);
          const reading = readPage(vector);
          ink = page;
          reasoning = [...reading.moods.slice(0, 2), ...reading.instruments.slice(0, 2)]
            .map((r) => `${r.item.label} ${Math.round(r.p * 100)}%`)
            .join(' · ');
          next = nextMix(reading, playing);
        }
        const mix = next ?? playing;
        if (!mix) continue;
        // How much ink and how warm it is move the two live knobs on every
        // reading, so the music grows as the page fills even within one mix.
        const config = inkConfig(mix.mood, ink);

        if (!next) {
          // Gemini's own knob settings stand until the drawing reads as something new.
          const now = stateRef.current.config;
          if (
            eyesOwn(stateRef.current.tracks, mix) &&
            (Math.abs(now.density - config.density) >= 0.05 ||
              Math.abs(now.brightness - config.brightness) >= 0.05)
          ) {
            dispatch({ type: 'SET_CONFIG', config });
          }
          continue;
        }

        mixRef.current = next;
        setScene(next.mood.label);
        // The pen answers a new mood now; the band takes a few seconds to follow.
        if (next !== INTRO && next.mood !== playing?.mood) {
          canvasRef.current?.cue(next.mood.brightness >= 0.5);
        }
        const actions = mixActions(next, stateRef.current.backend, config);
        actions.forEach((action) => dispatch(action));
        pushLog({
          event: `Feels like ${next.mood.label}: ${next.instruments.map((i) => i.label).join(' and ')}`,
          reasoning: `${reasoning} · read in ${Math.round(performance.now() - startedAt)} ms`,
          actions,
        });
      } while (readAgain.current);
    } catch (error) {
      pushLog({
        event: "Couldn't read the drawing",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      reading.current = false;
    }
  }, [pushLog]);

  /** Fetches SigLIP while the band connects, so the first stroke is read at once. */
  const warmEyes = useCallback(() => {
    const startedAt = performance.now();
    loadEyes().then(
      (eyes) =>
        pushLog({
          event: `Ready to read your drawing (SigLIP 2 on ${eyes.device === 'webgpu' ? 'the GPU' : 'the CPU'}, ${(
            (performance.now() - startedAt) / 1000
          ).toFixed(1)} s)`,
        }),
      (error) =>
        pushLog({
          event: "Couldn't load the drawing reader",
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  }, [pushLog]);

  // ---- A/B choice ----------------------------------------------------------

  const auditionAb = useCallback(
    (index: number) => {
      const pending = pendingAbRef.current;
      if (!pending) return;

      const audition = auditionEngineRef.current;
      if (audition) {
        // Both arms are streaming; switching is a pure gain flip — instant.
        // play() on the newly audible arm is belt-and-braces: an arm that was
        // steered while the pad was blank never started generating, and play
        // is harmless on one that did (unmute honours the arm's own volume).
        const audible = masterVolumeRef.current;
        if (index === 1) {
          engineRef.current?.setMasterVolume(0);
          audition.setMasterVolume(audible);
          audition.play();
        } else {
          audition.setMasterVolume(0);
          engineRef.current?.setMasterVolume(audible);
          if (statusRef.current !== 'playing') {
            hasPlayed.current = true;
            engineRef.current?.play();
          }
        }
      } else {
        // No second stream (no B key, Magenta, or it failed): re-steer the
        // single stream, and drop audio queued under the other arm so the
        // switch lands as a ducked cut in ~a second, not a slow morph.
        steerEngine(pending.variants[index].next);
        engineRef.current?.resetContext();
      }
      setAbAudition(index);
    },
    [steerEngine],
  );

  const chooseAb = useCallback(
    (index: number) => {
      const pending = pendingAbRef.current;
      if (!pending) return;
      const variant = pending.variants[index];

      const audition = auditionEngineRef.current;
      auditionEngineRef.current = null;
      setAuditionMode('off');

      if (index === 1 && audition) {
        // The audition stream is already playing the winner — promote it to
        // main and retire the old engine, so the choice lands without a seam.
        const old = engineRef.current;
        engineRef.current = audition;
        audition.setMasterVolume(masterVolumeRef.current);
        bufferRef.current = abBufferRef.current;
        setBuffered(abBufferRef.current);
        setStatus('playing');
        if (old) void old.close();
      } else {
        if (audition) void audition.close();
        // The main stream may be muted (B was audible) or on the loser's mix;
        // restore volume and steer it to the winner, cutting if it was on the
        // loser. The tracks effect re-sends the same prompts after the
        // dispatches land — harmless.
        engineRef.current?.setMasterVolume(masterVolumeRef.current);
        steerEngine(variant.next);
        if (abAuditionRef.current !== index) engineRef.current?.resetContext();
        // Same blank-pad escape hatch as arrival: the winner must be heard.
        if (statusRef.current !== 'playing') {
          hasPlayed.current = true;
          engineRef.current?.play();
        }
      }
      variant.plan.actions.forEach((action: Action) => dispatch(action));

      pushLog({
        event: `${pending.event} — kept ${index === 0 ? 'A' : 'B'} · ${
          PLANNER_CONFIGS[variant.configId].label
        }`,
        reasoning: variant.plan.reasoning,
        actions: variant.plan.actions,
        timings: { ...variant.plan.timings, encode: pending.encode, buffer: pending.buffer },
      });

      const record: AbRecord = {
        id: crypto.randomUUID(),
        ts: Date.now(),
        event: pending.event,
        image: pending.image ?? null,
        backend: pending.base.backend,
        base: { tracks: pending.base.tracks, config: pending.base.config },
        variants: pending.variants.map((v) => ({
          configId: v.configId,
          model: v.model,
          reasoning: v.plan.reasoning,
          actions: v.plan.actions,
          tracks: v.next.tracks,
          config: v.next.config,
        })),
        chosen: index,
        decisionMs: Date.now() - pending.shownAt,
      };
      void addRecord(record).then((ok) => {
        if (ok) setDatasetCount((n) => n + 1);
      });
      // The full choice minus the image (that lives in the dataset export) —
      // both arms on disk is what makes losing prompts inspectable later.
      logSession('ab_choice', {
        event: pending.event,
        chosen: index,
        decisionMs: record.decisionMs,
        variants: record.variants.map((v) => ({
          configId: v.configId,
          reasoning: v.reasoning,
          actions: v.actions,
          tracks: v.tracks.map((t) => ({ label: t.label, prompt: t.prompt, volume: t.volume })),
        })),
      });

      pendingAbRef.current = null;
      setPendingAb(null);
      setAbAudition(0);
    },
    [steerEngine, pushLog],
  );

  /** No preference recorded — put the engine back on the mix as it stands. */
  const dismissAb = useCallback(() => {
    if (!pendingAbRef.current) return;
    logSession('ab_dismiss', { event: pendingAbRef.current.event });
    const audition = auditionEngineRef.current;
    auditionEngineRef.current = null;
    setAuditionMode('off');
    if (audition) void audition.close();
    engineRef.current?.setMasterVolume(masterVolumeRef.current);
    steerEngine(stateRef.current);
    pendingAbRef.current = null;
    setPendingAb(null);
    setAbAudition(0);
  }, [steerEngine]);

  // If the audible arm stops producing audio during a dual-stream audition —
  // a starved or dropped stream, the failure mode that is otherwise pure
  // silence with no error anywhere — bail out: retire the audition engine and
  // cut the main stream to whichever arm the user was hearing.
  useEffect(() => {
    if (!pendingAb || auditionMode === 'off' || auditionMode === 'failed') return;
    let dry = 0;
    const timer = setInterval(() => {
      const onB = abAuditionRef.current === 1;
      const audible = onB ? auditionEngineRef.current : engineRef.current;
      if (!audible || statusRef.current !== 'playing') {
        dry = 0;
        return;
      }
      dry = audible.getBufferedSeconds() <= 0 ? dry + 1 : 0;
      if (dry < 4) return;

      const audition = auditionEngineRef.current;
      auditionEngineRef.current = null;
      if (audition) void audition.close();
      setAuditionMode('failed');
      const pending = pendingAbRef.current;
      if (pending) {
        engineRef.current?.setMasterVolume(masterVolumeRef.current);
        steerEngine(pending.variants[abAuditionRef.current].next);
        engineRef.current?.resetContext();
      }
      pushLog({
        event: 'A/B stream starved — reverted to single stream',
        error: 'no audio for 4s; switching now cuts instead of flipping',
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [pendingAb, auditionMode, pushLog, steerEngine]);

  // ---- render --------------------------------------------------------------

  /** One line that says what the instrument is doing right now. */
  const hearing =
    status === 'connecting'
      ? 'Starting the band…'
      : status === 'error'
        ? 'The band dropped out'
        : !connected
          ? 'Not playing'
          : thinking
            ? 'Reimagining…'
            : status === 'paused'
              ? 'Paused'
              : (scene ?? 'Draw anything');

  const togglePlay = () => {
    // Either way the user now owns playback state; an earlier
    // empty-mix auto-pause must not resume over their head.
    autoPaused.current = false;
    // Both arms of a dual-stream audition pause and resume
    // together — play() on the muted arm cannot unmute it, since
    // the scheduler returns to its own (zero) volume.
    if (playing) {
      engineRef.current?.pause();
      auditionEngineRef.current?.pause();
    } else if (!canvasRef.current?.isEmpty()) {
      engineRef.current?.play();
      auditionEngineRef.current?.play();
    }
  };

  /** The landing's button is also the gesture that lets the browser start audio. */
  const enterStudio = () => {
    commitKey(apiKey);
    setView('studio');
    void start();
  };

  return (
    <>
      {/* Stays mounted under the landing, so going back to it never loses the drawing. */}
      <div className="flex h-dvh flex-col overflow-hidden" inert={view === 'landing'}>
        <header className="flex h-14 shrink-0 items-center gap-2 px-3 sm:px-5">
          <button
            type="button"
            title="About skuzic"
            onClick={() => setView('landing')}
            className="shrink-0 rounded-full px-2 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <Wordmark compact />
          </button>

          {/* The mixer at its smallest: always here, whatever is open. */}
          <div className="flex min-w-0 flex-1 justify-center">
            <div
              role="status"
              title={statusDetail || undefined}
              className="flex h-10 min-w-0 items-center gap-2.5 rounded-full bg-glass pr-4 pl-1 shadow-sm ring-1 ring-border backdrop-blur-xl"
            >
              {connected ? (
                <button
                  type="button"
                  aria-label={playing ? 'Pause' : 'Play'}
                  title={playing ? 'Pause' : 'Play'}
                  onClick={togglePlay}
                  className={cn(
                    'grid size-8 shrink-0 place-items-center rounded-full outline-none transition-colors',
                    'focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-4 [&_svg]:fill-current',
                    playing
                      ? 'bg-brand text-white'
                      : 'bg-primary text-primary-foreground hover:bg-primary/85',
                  )}
                >
                  {playing ? <Pause /> : <Play className="translate-x-px" />}
                </button>
              ) : (
                <span className="grid size-8 shrink-0 place-items-center">
                  <span className={cn('size-2 rounded-full', DOT[status])} />
                </span>
              )}
              {audible && <Equalizer animated getLevels={getLevels} />}
              <span className="truncate text-[13px] first-letter:uppercase">{hearing}</span>
              {status === 'error' && (
                <button
                  type="button"
                  onClick={() => void start()}
                  className="shrink-0 text-[13px] font-medium underline underline-offset-2"
                >
                  Retry
                </button>
              )}
              {connected && (
                <Slider
                  className="ml-1 hidden w-20 md:flex"
                  value={[masterVolume * 100]}
                  max={100}
                  step={1}
                  aria-label="Volume"
                  title={`Volume ${Math.round(masterVolume * 100)}`}
                  onValueChange={([v]) => setMasterVolume(v / 100)}
                />
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              title="Gemini rewrites the music from your drawing"
              disabled={!connected || thinking || !!pendingAb}
              className="[&_svg]:text-brand-3"
              onClick={() => trigger('Recognized Input Update', true)}
            >
              <Sparkles />
              <span className="hidden sm:inline">Reimagine</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Mixer"
              aria-pressed={mixerOpen}
              title={mixerOpen ? 'Hide the mixer' : 'Show the mixer'}
              className={cn('max-sm:size-8 max-sm:px-0', mixerOpen && 'bg-secondary text-foreground')}
              onClick={() => showMixer(!mixerOpen)}
            >
              <SlidersHorizontal />
              <span className="hidden sm:inline">Mixer</span>
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Settings"
              title="Settings"
              onClick={() => setSettingsOpen(true)}
            >
              <SettingsIcon />
            </Button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 gap-3 px-3 pb-3 sm:px-5 sm:pb-4">
          <main className="min-h-0 min-w-0 flex-1">
            <DrawCanvas
              ref={canvasRef}
              autoInterpret={autoInterpret}
              playing={audible}
              getLevels={getLevels}
              interpretDisabled={!connected || !!pendingAb}
              showStart={!connected}
              onStart={() => {
                commitKey(apiKey);
                void start();
              }}
              startDisabled={!apiKey.trim() || status === 'connecting'}
              startTitle={
                !apiKey.trim()
                  ? 'Paste a Gemini API key to start the band'
                  : status === 'connecting'
                    ? 'Starting the band…'
                    : status === 'error'
                      ? statusDetail || 'Something went wrong. Try again.'
                      : 'Start the band, then draw'
              }
              startExtras={
                !apiKey.trim() && (
                  <ApiKeyField
                    className="w-72 max-w-full text-left [&_a]:text-muted-foreground"
                    value={apiKey}
                    onChange={setApiKey}
                  />
                )
              }
              onAutoInterpret={() => void readDrawing()}
              onClearInterpret={() => void readDrawing()}
            />
          </main>

          <Mixer
            open={mixerOpen}
            onClose={() => showMixer(false)}
            title={
              pendingAb
                ? `version ${abAudition === 0 ? 'A' : 'B'}`
                : (scene ?? (connected ? 'nothing yet' : 'not playing'))
            }
            // While a choice is pending the mixer mirrors the arm being
            // auditioned, read-only: the committed mix is on hold and showing
            // it here would only mislead.
            tracks={pendingAb ? pendingAb.variants[abAudition].next.tracks : state.tracks}
            readOnly={!!pendingAb}
            dispatch={dispatch}
            config={state.config}
            capabilities={caps}
            follow={autoInterpret}
            onFollowChange={(on) => {
              setAutoInterpret(on);
              save(KEYS.autoInterpret, on);
              // Turning it on should be heard now, not at the next pen-up.
              if (on) void readDrawing();
            }}
            canAsk={connected && !thinking && !pendingAb}
            thinking={thinking}
            onAsk={(text) => trigger(text)}
            log={log}
          />
        </div>

        {pendingAb && (
          <div className="fixed inset-x-3 bottom-24 z-30 mx-auto max-w-3xl rounded-[1.6rem] bg-popover/95 p-4 text-popover-foreground shadow-2xl ring-1 ring-border backdrop-blur-xl sm:inset-x-6">
            <AbChoice
              variants={pendingAb.variants.map((v) => ({
                reasoning: v.plan.reasoning,
                tracks: v.next.tracks,
                config: v.next.config,
              }))}
              baseConfig={pendingAb.base.config}
              audition={abAudition}
              warming={auditionMode === 'warming'}
              onAudition={auditionAb}
              onChoose={chooseAb}
              onDismiss={dismissAb}
            />
          </div>
        )}
      </div>

      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        backend={state.backend}
        onBackendChange={(b) => void switchBackend(b)}
        apiKey={apiKey}
        onApiKeyChange={setApiKey}
        onApiKeyCommit={(key) => {
          const trimmed = key.trim();
          if (trimmed === load(KEYS.apiKey, '')) return;
          commitKey(trimmed);
          if (engineRef.current) {
            void stop().then(() => {
              if (trimmed) void start();
            });
          }
        }}
        plannerConfig={plannerConfig}
        onPlannerConfigChange={(c) => {
          setPlannerConfig(c);
          save(KEYS.plannerConfig, c);
        }}
        plannerModel={plannerModel}
        onPlannerModelChange={(m) => {
          setPlannerModel(m);
          save(KEYS.plannerModel, m);
        }}
        abTest={abTest}
        onAbTestChange={(on) => {
          setAbTest(on);
          save(KEYS.abTest, on);
        }}
        datasetCount={datasetCount}
        onExportDataset={() => void exportDataset()}
        theme={theme}
        onThemeChange={setTheme}
        connected={connected}
        onDisconnect={() => {
          setSettingsOpen(false);
          void stop();
        }}
      />

      {view === 'landing' && (
        <Landing
          apiKey={apiKey}
          onApiKeyChange={setApiKey}
          onStart={enterStudio}
          returning={connected}
        />
      )}
    </>
  );
}
