import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Pause, Play, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import {
  BACKEND_LABELS,
  CAPABILITIES,
  type EngineStatus,
  type MusicEngine,
} from './audio/engine';
import { LyriaEngine } from './audio/lyria';
import { DEFAULT_BRIDGE_URL, MagentaEngine } from './audio/magenta';
import { reduce, reduceAll } from './core/reducer';
import { INITIAL_STATE, type Action, type Backend, type SkuzicState } from './core/types';
import { addRecord, countRecords, exportDataset, type AbRecord } from './lib/dataset';
import { KEYS, load, save } from './lib/persist';
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
import { AbChoice } from './ui/AbChoice';
import { ActionLog, type LogEntry } from './ui/ActionLog';
import { ConfigPanel } from './ui/ConfigPanel';
import { DrawCanvas, type CanvasHandle } from './ui/DrawCanvas';
import { TrackRack } from './ui/TrackRack';

const BRIDGE_URL =
  (import.meta.env.VITE_MAGENTA_BRIDGE_URL as string | undefined) || DEFAULT_BRIDGE_URL;

const API_KEY = (import.meta.env.VITE_GEMINI_API_KEY as string | undefined) || '';

/**
 * How long the pad must sit still before auto-interpret spends a call. Long
 * enough to cover the gap between strokes of one drawing, short enough that a
 * finished sketch still reacts promptly.
 */
const AUTO_INTERPRET_DEBOUNCE_MS = 900;

type Planner = ReturnType<typeof createPlanner>;

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
    config: load(KEYS.config, initial.config),
  }));
  const [status, setStatus] = useState<EngineStatus>('idle');
  const [statusDetail, setStatusDetail] = useState('');
  const [buffered, setBuffered] = useState(0);
  const [masterVolume, setMasterVolume] = useState(() => load(KEYS.masterVolume, 0.8));
  const [thinking, setThinking] = useState(false);
  const [eventText, setEventText] = useState('');
  const [log, setLog] = useState<LogEntry[]>([]);
  const [engineMenuOpen, setEngineMenuOpen] = useState(false);
  const [autoInterpret, setAutoInterpret] = useState(
    () => load(KEYS.autoInterpret, false),
  );
  const [abTest, setAbTest] = useState(() => load(KEYS.abTest, false));
  const [pendingAb, setPendingAb] = useState<PendingAb | null>(null);
  /** Which pending variant the engine is playing right now. */
  const [abAudition, setAbAudition] = useState(0);
  const [datasetCount, setDatasetCount] = useState(0);
  const [plannerModel, setPlannerModel] = useState<PlannerModel>(() => {
    const saved = load(KEYS.plannerModel, DEFAULT_PLANNER_MODEL);
    return isPlannerModel(saved) ? saved : DEFAULT_PLANNER_MODEL;
  });
  const [plannerConfig, setPlannerConfig] = useState<PlannerConfigId>(() => {
    const saved = load(KEYS.plannerConfig, DEFAULT_PLANNER_CONFIG);
    return saved in PLANNER_CONFIGS ? (saved as PlannerConfigId) : DEFAULT_PLANNER_CONFIG;
  });

  const engineRef = useRef<MusicEngine | null>(null);
  const plannerRef = useRef<ReturnType<typeof createPlanner> | null>(null);
  const canvasRef = useRef<CanvasHandle>(null);
  const logSeq = useRef(0);

  const inFlight = useRef(false);
  const queued = useRef<{ event: string; includeDrawing: boolean } | null>(null);
  /** Read inside runPlan, where the `buffered` state value would be a stale closure. */
  const bufferRef = useRef(0);
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const engineMenuRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    void countRecords().then(setDatasetCount);
  }, []);

  const pushLog = useCallback((entry: Omit<LogEntry, 'id'>) => {
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
    engineRef.current?.setMasterVolume(masterVolume);
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
    if (plannerRef.current) plannerRef.current = createPlanner(API_KEY, plannerModel);
  }, [plannerModel]);

  useEffect(() => () => void engineRef.current?.close(), []);

  // Close Engine on outside click (scale select portals outside the menu).
  useEffect(() => {
    if (!engineMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (engineMenuRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[data-slot="select-content"]')) return;
      setEngineMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [engineMenuOpen]);

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

  // ---- transport -----------------------------------------------------------

  const start = async () => {
    if (!API_KEY) return;

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

    const events = {
      onStatus: (s: EngineStatus, detail?: string) => {
        setStatus(s);
        setStatusDetail(detail ?? '');
        if (s === 'error' && detail) pushLog({ event: 'engine error', error: detail });
      },
      onFilteredPrompt: (text: string, reason: string) =>
        pushLog({ event: 'prompt filtered', error: `“${text}” — ${reason}` }),
      onBuffer: (seconds: number) => {
        bufferRef.current = seconds;
        setBuffered(seconds);
      },
    };

    const engine: MusicEngine =
      stateRef.current.backend === 'lyria'
        ? new LyriaEngine(API_KEY, events)
        : new MagentaEngine(BRIDGE_URL, events);

    engineRef.current = engine;
    // The planner always runs on Gemini, whichever backend makes the audio.
    plannerRef.current = createPlanner(API_KEY, plannerModel);

    try {
      await engine.connect();
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
    hasPlayed.current = false;
    autoPaused.current = false;
    // A pending A/B choice belongs to the session that produced it.
    pendingAbRef.current = null;
    setPendingAb(null);
    setAbAudition(0);
    setStatus('idle');
    setBuffered(0);
  };

  // Same as iOS: connect as soon as the page loads so drawing later does not
  // need another Start tap. Playback still waits for ink + a live mix.
  useEffect(() => {
    if (!API_KEY) return;
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
  const getLevels = useCallback(
    (bands: number) => engineRef.current?.getLevels(bands) ?? null,
    [],
  );

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

              const settled = await Promise.allSettled(
                pair.map((id) => planner(jobEvent, base, image, id)),
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
                  // A starts playing immediately, so the music never stalls
                  // waiting on the choice.
                  steerEngine(variants[0].next);
                  // A burst of strokes queued behind this pair is void now —
                  // planning is blocked until the user picks anyway.
                  queued.current = null;
                } else {
                  const survivor = plans[0] ?? plans[1];
                  const reason = (settled[failed] as PromiseRejectedResult).reason;
                  if (!survivor) throw reason instanceof Error ? reason : new Error(String(reason));
                  // Half an A/B is no test, but it is still a good steer:
                  // apply the surviving plan as if the mode were off.
                  survivor.actions.forEach((action: Action) => dispatch(action));
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
    [pushLog, steerEngine],
  );

  /** Auto-interpret: wait for the user to stop drawing before spending a call. */
  const queueAutoPlan = useCallback(
    (event: string, includeDrawing: boolean) => {
      if (autoTimer.current) clearTimeout(autoTimer.current);
      autoTimer.current = setTimeout(() => {
        autoTimer.current = null;
        void runPlan(event, includeDrawing);
      }, AUTO_INTERPRET_DEBOUNCE_MS);
    },
    [runPlan],
  );

  /** Explicit user action — pre-empts any pending auto-interpret. */
  const trigger = useCallback(
    (event: string, includeDrawing = false) => {
      if (autoTimer.current) {
        clearTimeout(autoTimer.current);
        autoTimer.current = null;
      }
      void runPlan(event, includeDrawing);
    },
    [runPlan],
  );

  useEffect(
    () => () => {
      if (autoTimer.current) clearTimeout(autoTimer.current);
    },
    [],
  );

  // ---- A/B choice ----------------------------------------------------------

  const auditionAb = useCallback(
    (index: number) => {
      const pending = pendingAbRef.current;
      if (!pending) return;
      steerEngine(pending.variants[index].next);
      setAbAudition(index);
    },
    [steerEngine],
  );

  const chooseAb = useCallback(
    (index: number) => {
      const pending = pendingAbRef.current;
      if (!pending) return;
      const variant = pending.variants[index];

      // The engine may be playing the *other* arm; steer it to the winner
      // first, then commit. The tracks effect re-sends the same prompts after
      // the dispatches land, which is harmless, and the explicit steer is what
      // restores config if the loser's density/brightness were auditioned last.
      steerEngine(variant.next);
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

      pendingAbRef.current = null;
      setPendingAb(null);
      setAbAudition(0);
    },
    [steerEngine, pushLog],
  );

  /** No preference recorded — put the engine back on the mix as it stands. */
  const dismissAb = useCallback(() => {
    if (!pendingAbRef.current) return;
    steerEngine(stateRef.current);
    pendingAbRef.current = null;
    setPendingAb(null);
    setAbAudition(0);
  }, [steerEngine]);

  // ---- render --------------------------------------------------------------

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-7 px-5 pt-5 pb-12">
      <header className="flex flex-wrap items-center gap-3">
        <span className="font-semibold tracking-tight">skuzic</span>

        {connected && (
          <>
            <span className="text-[13px] text-muted-foreground">{BACKEND_LABELS[state.backend]}</span>

            <div className="relative" ref={engineMenuRef}>
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={engineMenuOpen}
                aria-haspopup="true"
                className={cn(engineMenuOpen && 'bg-secondary text-foreground')}
                onClick={() => setEngineMenuOpen((open) => !open)}
              >
                Engine
              </Button>
              {engineMenuOpen && (
                <div className="absolute left-0 top-full z-50 pt-2">
                  <div className="w-[18rem] rounded-2xl bg-popover p-4 text-popover-foreground shadow-lg">
                    <p className="mb-3 text-[12px] text-muted-foreground/70">
                      {caps.bpm
                        ? 'bpm and scale changes restart generation'
                        : 'blended style embeddings · no tempo or key control'}
                    </p>
                    <ConfigPanel
                      config={state.config}
                      capabilities={caps}
                      dispatch={dispatch}
                      autoInterpret={autoInterpret}
                      onAutoInterpretChange={(on) => {
                        setAutoInterpret(on);
                        save(KEYS.autoInterpret, on);
                      }}
                      abTest={abTest}
                      onAbTestChange={(on) => {
                        setAbTest(on);
                        save(KEYS.abTest, on);
                      }}
                      datasetCount={datasetCount}
                      onExportDataset={() => void exportDataset()}
                      plannerModel={plannerModel}
                      onPlannerModelChange={(m) => {
                        setPlannerModel(m);
                        save(KEYS.plannerModel, m);
                      }}
                      plannerConfig={plannerConfig}
                      onPlannerConfigChange={(c) => {
                        setPlannerConfig(c);
                        save(KEYS.plannerConfig, c);
                      }}
                    />
                  </div>
                </div>
              )}
            </div>

            <span
              className={cn('size-1.5 shrink-0 rounded-full', DOT[status])}
              title={
                `${status} · ${buffered.toFixed(1)}s${statusDetail ? ` — ${statusDetail}` : ''}`
              }
              aria-label={`${status} · ${buffered.toFixed(1)}s`}
            />

            <div className="flex-1" />

            <Slider
              className="w-24"
              value={[masterVolume * 100]}
              max={100}
              step={1}
              aria-label="master volume"
              title={`volume ${Math.round(masterVolume * 100)}`}
              onValueChange={([v]) => setMasterVolume(v / 100)}
            />
            <Button
              size="icon"
              aria-label={playing ? 'pause' : 'play'}
              title={playing ? 'pause' : 'play'}
              onClick={() => {
                // Either way the user now owns playback state; an earlier
                // empty-mix auto-pause must not resume over their head.
                autoPaused.current = false;
                if (playing) {
                  engineRef.current?.pause();
                } else if (!canvasRef.current?.isEmpty()) {
                  engineRef.current?.play();
                }
              }}
            >
              {playing ? <Pause /> : <Play />}
            </Button>
            <Button size="icon" variant="ghost" aria-label="stop" title="stop" onClick={stop}>
              <Square />
            </Button>
          </>
        )}
      </header>

      <main className="flex flex-col gap-7">
        <section>
          <DrawCanvas
            ref={canvasRef}
            autoInterpret={autoInterpret}
            interpreting={thinking}
            playing={audible}
            getLevels={getLevels}
            interpretDisabled={!connected || !!pendingAb}
            showStart={!connected}
            onStart={start}
            startDisabled={!API_KEY || status === 'connecting'}
            startTitle={
              !API_KEY
                ? 'Set VITE_GEMINI_API_KEY in .env'
                : status === 'connecting'
                  ? 'connecting…'
                  : status === 'error'
                    ? statusDetail || 'retry'
                    : 'start'
            }
            startExtras={
              <Select
                value={state.backend}
                onValueChange={(v) => dispatch({ type: 'SET_BACKEND', backend: v as Backend })}
              >
                <SelectTrigger
                  aria-label="music model"
                  title="Choose a music model"
                  className="w-[190px] bg-[#15130f]/80 text-[#f4f1ea] shadow-md backdrop-blur-sm"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(BACKEND_LABELS) as Backend[]).map((b) => (
                    <SelectItem key={b} value={b}>
                      {BACKEND_LABELS[b]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
            onInterpret={() => trigger('Recognized Input Update', true)}
            onAutoInterpret={() => queueAutoPlan('Recognized Input Update', true)}
            onClearInterpret={() => queueAutoPlan('user cleared the drawing', false)}
          />

          {connected && (
            <form
              className="mt-2.5 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void trigger(eventText);
                setEventText('');
              }}
            >
              <Input
                placeholder="describe an event…"
                value={eventText}
                onChange={(e) => setEventText(e.target.value)}
              />
              <Button variant="ghost" disabled={thinking || !!pendingAb || !eventText.trim()}>
                fire
              </Button>
            </form>
          )}
        </section>

        {pendingAb && (
          <AbChoice
            variants={pendingAb.variants.map((v) => ({
              reasoning: v.plan.reasoning,
              tracks: v.next.tracks,
              config: v.next.config,
            }))}
            baseConfig={pendingAb.base.config}
            audition={abAudition}
            onAudition={auditionAb}
            onChoose={chooseAb}
            onDismiss={dismissAb}
          />
        )}

        {connected && (
          <div className="grid grid-cols-1 items-start gap-x-6 gap-y-7 md:grid-cols-2">
            <section className="min-w-0">
              <h2 className="mb-2.5 flex items-baseline gap-2 text-[13px] text-muted-foreground">
                Mix
                <span className="text-muted-foreground/60">
                  {state.tracks.length} / {caps.maxPrompts} tracks
                </span>
              </h2>
              <TrackRack tracks={state.tracks} dispatch={dispatch} />
            </section>

            <section className="min-w-0">
              <h2 className="mb-2.5 text-[13px] text-muted-foreground">Actions</h2>
              <ActionLog entries={log} />
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
