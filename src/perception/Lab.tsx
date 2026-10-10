/**
 * The perception lab (dev builds only): what the new core sees, believes and
 * asks of the music, live, with recording, replay and the evaluation. It runs
 * beside the old object-reading eyes, so the two can be compared on the same
 * drawing: "Old eyes" keeps the app as it is, "Prototype" plays the local
 * voice from perception alone, "Lyria" has perception steer the stream.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Action, SkuzicState } from '../core/types';
import type { CanvasHandle } from '../ui/DrawCanvas';
import type { Vibe } from '../vision/eyes';
import { Perception, type Page, type Snapshot } from './controller';
import { evaluate, type Report, type SceneReading } from './evaluate';
import type { PageInput } from './gesture';
import { MODEL_FEEDS, type Targets } from './mapping';
import type { Rect } from './measure';
import { PROBES } from './probes';
import { SCENES, type Recording } from './scenes';
import { quantileOf, type Reading } from './state';
import { layersOf, streamActions } from './stream';
import { seatTimbres, timbresFor } from './timbre';
import { PerceptionVoice } from './voice';

export type Drive = 'off' | 'voice' | 'stream';

export interface LabHost {
  canvas: () => CanvasHandle | null;
  /** Plugs the lab into the page's inputs, or unplugs it with null. */
  listen: (sink: ((input: PageInput) => void) | null) => void;
  /** Who plays: the old eyes, the prototype voice (the stream paused), or the stream following perception. */
  drive: (mode: Drive) => void;
  /** Keeps the old eyes from reading while the lab replays its scenes. */
  hold: (on: boolean) => void;
  dispatch: (action: Action) => void;
  state: () => SkuzicState;
  /** The style picked: its idiom, and which instruments the timbre map may choose. */
  vibe: () => Vibe;
  /** What the old eyes make of the page, to compare. */
  oldReading: () => string | null;
  /** Seconds queued in the stream: nothing sent now is heard sooner. */
  buffered: () => number;
}

const recordings = import.meta.glob<Recording>('../../test/perception/recordings/*.json', { import: 'default' });

const OBSERVED = ['lightness', 'contrast', 'density', 'openness', 'weight', 'texture', 'softness', 'curvature', 'angularity', 'chroma', 'warmth', 'tint', 'spread', 'concentration', 'balance'];
const TARGETS: (keyof Targets)[] = ['register', 'fullness', 'articulation', 'phrasing', 'energy', 'tension', 'space', 'pan', 'presence'];

const pct = (v: number) => `${Math.round(v * 100)}%`;
/** An instrument plays at least this long before another can take its seat (ms): changes land as phrases, not flickers. */
const SEAT_HOLD = 8000;
const ms = (v: number) => `${Math.round(v)} ms`;
const sleep = (t: number) => new Promise((r) => setTimeout(r, t));

async function save(kind: 'recording' | 'report' | 'calibration', name: string, data: unknown): Promise<boolean> {
  try {
    const res = await fetch('/__perception', { method: 'POST', body: JSON.stringify({ kind, name, data }) });
    return res.ok;
  } catch {
    return false;
  }
}

/** A 0..1 bar: the value's fill, faint where its support is weak, and a tick where it is gliding to. */
function Bar({ value, target, support = 1, signed = false }: { value: number; target?: number; support?: number; signed?: boolean }) {
  const v = signed ? (value + 1) / 2 : value;
  return (
    <span className="relative block h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <span
        className="absolute inset-y-0 left-0 rounded-full bg-foreground"
        style={{ width: pct(Math.min(1, Math.max(0, v))), opacity: 0.25 + 0.65 * Math.min(1, Math.max(0, support)) }}
      />
      {target !== undefined && (
        <span className="absolute inset-y-0 w-0.5 bg-brand" style={{ left: `calc(${pct(Math.min(1, Math.max(0, target)))} - 1px)` }} />
      )}
    </span>
  );
}

function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="border-t border-border px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

type Picture = ImageData | { data: Uint8ClampedArray; width: number; height: number } | undefined | null;

/**
 * Pixels on a canvas element, with the region outlined if given (in the
 * picture's own px). The pixels come through a getter: React's dev build logs
 * every changed prop, and walking a picture's array cost 100 ms a render.
 */
function View({ image: get, box, label }: { image: () => Picture; box?: Rect | null; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const image = get();
    if (!c || !image) return;
    c.width = image.width;
    c.height = image.height;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(image instanceof ImageData ? image : new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
    if (box) {
      ctx.strokeStyle = '#7c3aed';
      ctx.lineWidth = 2;
      ctx.strokeRect(box.x, box.y, box.width, box.height);
    }
  });
  return (
    <figure className="min-w-0 flex-1">
      <canvas ref={ref} className="block w-full rounded-md bg-white ring-1 ring-border" />
      <figcaption className="mt-0.5 text-[10px] text-muted-foreground">{label}</figcaption>
    </figure>
  );
}

const row = (k: string, r: Reading | undefined, glide: number | undefined, local: Reading | undefined) => (
  <div key={k} className="grid grid-cols-[84px_1fr_38px_38px_44px] items-center gap-1.5" title={r ? `${r.kind}, from ${r.source}, page v${r.version}` : 'no reading yet'}>
    <span className="truncate">{k}</span>
    {r ? <Bar value={glide ?? r.value} target={r.value} support={r.support} /> : <span className="h-1.5 rounded-full bg-muted/50" />}
    <span className="text-right tabular-nums">{r ? r.value.toFixed(2) : '–'}</span>
    <span className="text-right text-muted-foreground tabular-nums">{r ? r.support.toFixed(1) : ''}</span>
    <span className="text-right text-muted-foreground tabular-nums">{local ? local.value.toFixed(2) : ''}</span>
  </div>
);

export default function Lab({ host, onClose }: { host: LabHost; onClose: () => void }) {
  const [perception] = useState(() => {
    const page: Page = {
      snapshot: (edge) => host.canvas()?.snapshot(edge) ?? null,
      square: (box, edge) => host.canvas()?.square(box, edge) ?? null,
      marks: (live) => host.canvas()?.marks(live) ?? [],
      size: () => host.canvas()?.size() ?? { width: 1, height: 1 },
      changed: () => host.canvas()?.changed() ?? null,
      isEmpty: () => host.canvas()?.isEmpty() ?? true,
    };
    const p = new Perception(page);
    p.view = true;
    return p;
  });
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [page, setPage] = useState<ImageData | null>(null);
  const [mode, setMode] = useState<Drive>('off');
  const [model, setModel] = useState(true);
  const voice = useRef<PerceptionVoice | null>(null);
  const replaying = useRef(false);
  const recording = useRef<Recording | null>(null);
  const recordStart = useRef(0);
  const [isRecording, setIsRecording] = useState(false);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [pick, setPick] = useState('');
  const [names, setNames] = useState<string[]>([]);
  const [run, setRun] = useState<{ done: number; total: number } | null>(null);
  const [report, setReport] = useState<(Report & { region: string; at: string }) | null>(null);
  /** Folded to its header, the lab stops redrawing, so it costs the page nothing while you listen. */
  const [folded, setFolded] = useState(false);
  const cancel = useRef(false);

  useEffect(() => {
    setNames(Object.keys(recordings).map((p) => p.split('/').pop()!.replace(/\.json$/, '')));
  }, []);

  // For scripted checks from devtools or a test browser.
  useEffect(() => {
    const w = window as Window & { __lab?: unknown };
    w.__lab = {
      perception,
      voice: () => voice.current,
      scenes: SCENES,
      play: (name: string, fast = true, fresh = true) => play(SCENES[name](), fast, fresh),
    };
    return () => void delete w.__lab;
  });

  // The page's inputs feed perception, the voice's expression and the recorder.
  useEffect(() => {
    host.listen((input) => {
      perception.input(input);
      const live = !replaying.current;
      voice.current?.express(live ? input.t : 0);
      const rec = recording.current;
      if (rec && live) {
        const at = (t: number) => Math.round((t - recordStart.current) * 10) / 10;
        const r1 = (v: number) => Math.round(v * 10) / 10;
        rec.events.push(
          input.type === 'move'
            ? { ...input, t: at(input.t), points: input.points.map(([x, y, p, t]) => [r1(x), r1(y), Math.round(p * 100) / 100, at(t)]) }
            : input.type === 'down'
              ? { ...input, t: at(input.t), x: r1(input.x), y: r1(input.y) }
              : { ...input, t: at(input.t) },
        );
      }
    });
    return () => {
      host.listen(null);
      host.drive('off');
      host.hold(false);
      voice.current?.close();
      perception.dispose();
    };
  }, [host, perception]);

  // Redrawn a few times a second, and only between strokes' frames: reading the
  // page back stalls the GPU, so the page view refreshes less often still.
  useEffect(() => {
    if (folded) return;
    let tick = 0;
    const timer = setInterval(() => {
      const s = perception.snapshot();
      setSnap(s);
      if (tick++ % 3 === 0 || !s.drawing) setPage(host.canvas()?.snapshot(240) ?? null);
    }, 250);
    return () => clearInterval(timer);
  }, [host, perception, folded]);

  // Lyria hears changes seconds later in 2 s chunks: steering it faster only churns.
  useEffect(() => {
    if (mode !== 'stream') return;
    const seated = { ids: [] as string[], at: -Infinity };
    const steer = () => {
      const now = performance.now();
      const { targets, inputs } = perception.targetsAt(now);
      const state = host.state();
      const ranked = timbresFor(targets, inputs, host.vibe());
      if (now - seated.at >= SEAT_HOLD) {
        const ids = seatTimbres(ranked, seated.ids).map((t) => t.id);
        if (ids.join() !== seated.ids.join()) Object.assign(seated, { ids, at: now });
      }
      const base = seated.ids.flatMap((id, k) => {
        const t = ranked.find((r) => r.timbre.id === id)?.timbre;
        return t ? [{ label: t.label, prompt: t.prompt, volume: k ? 0.4 : 0.6 }] : [];
      });
      for (const action of streamActions(targets, state.tracks, state.config, base)) host.dispatch(action);
    };
    steer();
    const timer = setInterval(steer, 2000);
    return () => clearInterval(timer);
  }, [mode, host, perception]);

  const choose = (next: Drive) => {
    if (next === mode) return;
    voice.current?.close();
    voice.current = null;
    if (next === 'voice') {
      // Made inside the click, so the browser lets it play.
      voice.current = new PerceptionVoice((t) => perception.targetsAt(t).targets, (t) => perception.gestureAt(t));
      voice.current.resume();
    }
    host.drive(next);
    setMode(next);
  };

  const play = async (rec: Recording, fast: boolean, fresh = true) => {
    const canvas = host.canvas();
    if (!canvas) return;
    cancel.current = false;
    replaying.current = true;
    if (fresh) {
      voice.current?.restart();
      canvas.play({ type: 'clear', t: 0 }, rec.page);
    }
    const start = performance.now();
    for (const [i, input] of rec.events.entries()) {
      if (!fast) {
        const wait = input.t - (performance.now() - start);
        if (wait > 0) await sleep(wait);
      } else if (i % 60 === 59) {
        // Instant, but the page keeps breathing.
        await sleep(0);
      }
      if (cancel.current) break;
      canvas.play(input, rec.page);
    }
    replaying.current = false;
  };

  const replay = async (fast: boolean) => {
    const builtIn = SCENES[pick];
    const file = Object.entries(recordings).find(([p]) => p.endsWith(`/${pick}.json`));
    const rec = builtIn ? builtIn() : file ? await file[1]() : null;
    if (rec) await play(rec, fast);
  };

  const record = () => {
    const canvas = host.canvas();
    if (!canvas) return;
    if (isRecording) {
      const rec = recording.current;
      recording.current = null;
      setIsRecording(false);
      const slug = (name.trim() || `drawing-${new Date().toISOString().slice(0, 16)}`).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
      if (rec && rec.events.length)
        void save('recording', slug, { ...rec, name: slug }).then((ok) => {
          setNote(ok ? `Saved test/perception/recordings/${slug}.json` : "Couldn't save the recording (dev server only)");
          if (ok) setNames((n) => [...new Set([...n, slug])]);
        });
      return;
    }
    canvas.play({ type: 'clear', t: 0 }, canvas.size());
    recordStart.current = performance.now();
    recording.current = { name: '', page: canvas.size(), events: [] };
    setIsRecording(true);
    setNote('Recording from a clear page…');
  };

  const runEval = async () => {
    const canvas = host.canvas();
    if (!canvas || run) return;
    host.hold(true);
    const scenes = Object.keys(SCENES);
    const readings: Record<string, SceneReading> = {};
    let region = 'not checked';
    cancel.current = false;
    for (const [i, scene] of scenes.entries()) {
      if (cancel.current) break;
      setRun({ done: i, total: scenes.length });
      const rec = SCENES[scene]();
      const began = performance.now();
      await play(rec, true);
      const drawn = performance.now();
      // The first scene may wait for the model to download.
      const deadline = drawn + (i ? 10_000 : 90_000);
      while (!perception.settled() && performance.now() < deadline) await sleep(40);
      const s = perception.snapshot();
      console.info(`[lab] ${scene}: drawn in ${Math.round(drawn - began)} ms, read ${Math.round(performance.now() - drawn)} ms${perception.settled() ? '' : ' (gave up waiting)'}${s.modelError ? `, model: ${s.modelError}` : ''}`);
      const values: Record<string, number> = {};
      const raw: Record<string, number> = {};
      for (const [k, r] of Object.entries(s.whole)) values[k] = r.value;
      for (const [k, r] of Object.entries(s.model)) {
        if (k.startsWith('local.')) continue;
        values[k] = r.value;
        if (r.raw !== undefined) raw[k.slice('model.'.length)] = r.raw;
      }
      readings[scene] = { values, raw };
      if (scene === 'recolor-form' && s.region) {
        // The red stroke's region should take in the black circle it crosses (drawn at 600,400, r 160 on a 1200x800 page).
        const size = canvas.size();
        const k = Math.min(size.width / rec.page.width, size.height / rec.page.height);
        const ox = (size.width - rec.page.width * k) / 2;
        const oy = (size.height - rec.page.height * k) / 2;
        const form = { x: ox + 440 * k, y: oy + 240 * k, width: 320 * k, height: 320 * k };
        const ix = Math.max(0, Math.min(form.x + form.width, s.region.x + s.region.width) - Math.max(form.x, s.region.x));
        const iy = Math.max(0, Math.min(form.y + form.height, s.region.y + s.region.height) - Math.max(form.y, s.region.y));
        const share = (ix * iy) / (form.width * form.height);
        region = `${pct(share)} of the circle inside the red stroke's region ${share >= 0.8 ? '(ok)' : '(too little context)'}`;
      }
    }
    host.hold(false);
    setRun(null);
    const result = { ...evaluate(readings), region, at: new Date().toISOString() };
    setReport(result);
    const saved = await save('report', '', { ...result, device: perception.snapshot().device, readings });
    setNote(saved ? 'Report saved to .logs/' : 'Report not saved (dev server only)');
  };

  const t = snap?.timing;
  const lat = voice.current?.latencies ?? [];
  const audio = voice.current?.ctx;
  const changeBox = snap?.region && page && host.canvas() ? scaleBox(snap.region, host.canvas()!.size(), page) : null;

  return (
    <div className="fixed bottom-3 left-3 z-40 flex max-h-[82vh] w-[400px] flex-col overflow-hidden rounded-2xl bg-popover/95 text-[11.5px] text-popover-foreground shadow-2xl ring-1 ring-border backdrop-blur-xl">
      <header className="flex items-center gap-2 px-3 py-2">
        <strong className="text-[12.5px]">Perception lab</strong>
        <span className="text-muted-foreground tabular-nums">v{snap?.version ?? 0}</span>
        <span className="text-muted-foreground">{snap?.device ? `SigLIP on ${snap.device}` : model ? 'SigLIP loading' : 'model off'}</span>
        <button type="button" onClick={() => setFolded((f) => !f)} className="ml-auto rounded px-1.5 text-muted-foreground hover:bg-secondary">
          {folded ? 'Open' : 'Fold'}
        </button>
        <button type="button" onClick={onClose} className="rounded px-1.5 text-muted-foreground hover:bg-secondary">
          Close
        </button>
      </header>
      <div className="flex gap-1 px-3 pb-2" role="group" aria-label="Who plays">
        {(
          [
            ['off', 'Old eyes'],
            ['voice', 'Prototype'],
            ['stream', 'Lyria'],
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => choose(m)}
            className={`flex-1 rounded-full px-2 py-1 ring-1 ring-border ${mode === m ? 'bg-foreground text-background' : 'hover:bg-secondary'}`}
          >
            {label}
          </button>
        ))}
        <label className="flex items-center gap-1 pl-1 text-muted-foreground">
          <input
            type="checkbox"
            checked={model}
            onChange={(e) => {
              perception.model = e.target.checked;
              setModel(e.target.checked);
            }}
          />
          model
        </label>
      </div>

      <div className={folded ? 'hidden' : 'min-h-0 overflow-y-auto'}>
        <Section title="What it reads">
          <div className="flex gap-2">
            <View image={() => page} box={changeBox} label="page · region" />
            <View image={() => snap?.views.ink} label="ink as measured" />
            <View image={() => snap?.views.region} label="region (model)" />
          </div>
          {snap?.change && (
            <p className="mt-1 text-muted-foreground tabular-nums">
              last change: +{(snap.change.added * 100).toFixed(2)}% ink, −{(snap.change.removed * 100).toFixed(2)}%, recoloured {(snap.change.recolored * 100).toFixed(2)}%
            </p>
          )}
          <p className="mt-0.5 text-muted-foreground">old eyes: {host.oldReading() ?? '–'}</p>
        </Section>

        <Section
          title="Observed"
          right={snap?.measureError ? <span className="text-destructive">{snap.measureError}</span> : <span className="text-[10px] text-muted-foreground">value · support · local</span>}
        >
          <div className="space-y-0.5">{OBSERVED.map((k) => row(k, snap?.whole[k], snap?.inputs[k]?.value, snap?.local[k]))}</div>
        </Section>

        <Section
          title="Interpreted (SigLIP probes)"
          right={snap?.modelError ? <span className="text-destructive">{snap.modelError}</span> : <span className="text-[10px] text-muted-foreground">feeds music</span>}
        >
          <div className="space-y-0.5">
            {PROBES.map((p) => {
              const k = `model.${p.id}`;
              const r = snap?.model[k];
              return (
                <div key={k} className="grid grid-cols-[84px_1fr_38px_38px_44px] items-center gap-1.5" title={`${p.pos[0]}  vs  ${p.neg[0]}`}>
                  <span className="truncate">{p.id}</span>
                  {r ? <Bar value={snap?.inputs[k]?.value ?? r.value} target={r.value} support={r.support} /> : <span className="h-1.5 rounded-full bg-muted/50" />}
                  <span className="text-right tabular-nums">{r ? r.value.toFixed(2) : '–'}</span>
                  <span className="text-right text-muted-foreground tabular-nums">{r?.raw !== undefined ? (r.raw * 100).toFixed(1) : ''}</span>
                  <span className="text-right text-muted-foreground">{MODEL_FEEDS[k] ? 'yes' : 'no'}</span>
                </div>
              );
            })}
          </div>
        </Section>

        <Section title="Music targets" right={<span className="text-[10px] text-muted-foreground">hover for why</span>}>
          <div className="space-y-0.5">
            {TARGETS.map((k) => {
              const v = snap?.targets[k] ?? 0;
              const why = snap?.why[k];
              return (
                <div
                  key={k}
                  className="grid grid-cols-[84px_1fr_38px] items-center gap-1.5"
                  title={why?.map((w) => `${w.input} ×${w.weight.toFixed(2)} = ${w.value.toFixed(2)} (support ${w.support.toFixed(1)})`).join('\n')}
                >
                  <span>{k}</span>
                  <Bar value={v} signed={k === 'pan'} />
                  <span className="text-right tabular-nums">{v.toFixed(2)}</span>
                </div>
              );
            })}
          </div>
          {snap && (
            <p className="mt-1 text-muted-foreground">
              instruments:{' '}
              {timbresFor(snap.targets, snap.inputs, host.vibe())
                .slice(0, 4)
                .map((r) => (
                  <span
                    key={r.timbre.id}
                    title={`colour ${r.why.colour.toFixed(2)} · attack ${r.why.attack.toFixed(2)} · register ${r.why.register.toFixed(2)}`}
                  >
                    {r.timbre.label} {pct(r.p)}{' '}
                  </span>
                ))}
            </p>
          )}
          {mode === 'stream' && snap && (
            <p className="mt-1 text-muted-foreground">
              to Lyria: {layersOf(snap.targets).filter((l) => l.weight > 0).map((l) => `${l.prompt} ${l.weight}`).join(' · ') || 'neutral'}
            </p>
          )}
        </Section>

        <Section title="Gesture">
          {snap && (
            <div className="grid grid-cols-5 gap-2 tabular-nums">
              {(['speed', 'turning', 'jolt', 'pressure', 'energy'] as const).map((k) => (
                <div key={k}>
                  <div className="text-[10px] text-muted-foreground">{k}</div>
                  <Bar value={snap.gesture[k]} />
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="Timing">
          {t && (
            <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 tabular-nums">
              <dt className="text-muted-foreground">read-back p50/p95</dt>
              <dd>{ms(t.capture[0])} / {ms(t.capture[1])}</dd>
              <dt className="text-muted-foreground">measure p50/p95</dt>
              <dd>{ms(t.measure[0])} / {ms(t.measure[1])}</dd>
              <dt className="text-muted-foreground">model p50/p95</dt>
              <dd>{ms(t.model[0])} / {ms(t.model[1])}</dd>
              <dt className="text-muted-foreground">input → voice p50/p95</dt>
              <dd>{lat.length ? `${ms(quantileOf(lat, 0.5))} / ${ms(quantileOf(lat, 0.95))}` : 'prototype off'}</dd>
              <dt className="text-muted-foreground">audio out (base + output)</dt>
              <dd>{audio ? ms(1000 * (audio.baseLatency + (audio.outputLatency || 0))) : '–'}</dd>
              <dt className="text-muted-foreground">stream queue</dt>
              <dd>{host.buffered().toFixed(1)} s, then a 2 s chunk</dd>
            </dl>
          )}
        </Section>

        <Section title="Record and replay">
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="name, e.g. pale-washes"
              className="min-w-0 flex-1 rounded-md bg-background px-2 py-1 ring-1 ring-border"
            />
            <button type="button" onClick={record} className="rounded-full px-2.5 py-1 ring-1 ring-border hover:bg-secondary">
              {isRecording ? '■ Save' : '● Record'}
            </button>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <select value={pick} onChange={(e) => setPick(e.target.value)} className="min-w-0 flex-1 rounded-md bg-background px-1.5 py-1 ring-1 ring-border">
              <option value="">Choose a drawing…</option>
              <optgroup label="Recorded">
                {names.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Scenes">
                {Object.keys(SCENES).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </optgroup>
            </select>
            <button type="button" disabled={!pick} onClick={() => void replay(false)} className="rounded-full px-2.5 py-1 ring-1 ring-border hover:bg-secondary disabled:opacity-40">
              ▶ Replay
            </button>
            <button type="button" disabled={!pick} onClick={() => void replay(true)} className="rounded-full px-2.5 py-1 ring-1 ring-border hover:bg-secondary disabled:opacity-40">
              Instant
            </button>
            <button type="button" onClick={() => (cancel.current = true)} className="rounded-full px-2.5 py-1 ring-1 ring-border hover:bg-secondary">
              Stop
            </button>
          </div>
          {note && <p className="mt-1 text-muted-foreground">{note}</p>}
        </Section>

        <Section
          title="Evaluation"
          right={
            <button type="button" disabled={!!run} onClick={() => void runEval()} className="rounded-full px-2.5 py-0.5 ring-1 ring-border hover:bg-secondary disabled:opacity-40">
              {run ? `${run.done}/${run.total}…` : 'Run scenes'}
            </button>
          }
        >
          {report ? <ReportView report={report} /> : <p className="text-muted-foreground">Replays every scene, then scores measured qualities and SigLIP probes on the same designed pairs.</p>}
        </Section>
      </div>
    </div>
  );
}

/** The region box (page px) on the page view (its own px). */
function scaleBox(box: Rect, size: { width: number; height: number }, view: { width: number; height: number }): Rect {
  const k = view.width / (size.width || 1);
  return { x: box.x * k, y: box.y * k, width: box.width * k, height: box.height * k };
}

function ReportView({ report }: { report: Report & { region: string } }) {
  const share = ([a, n]: [number, number]) => (n ? `${a}/${n} (${pct(a / n)})` : '–');
  const [saved, setSaved] = useState('');
  return (
    <div className="space-y-1.5">
      <p>
        Measured agrees on <strong>{share(report.measured)}</strong> of designed pairs; the model on <strong>{share(report.model)}</strong>.
      </p>
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 tabular-nums">
        <span className="text-muted-foreground">quality</span>
        <span className="text-muted-foreground">measured</span>
        <span className="text-muted-foreground">model</span>
        {Object.entries(report.agreement).map(([dim, r]) => (
          <div key={dim} className="contents">
            <span>{dim}</span>
            <span>{share(r.measured)}</span>
            <span>{share(r.model)}</span>
          </div>
        ))}
      </div>
      {report.comparisons
        .filter((c) => c.agrees === false || c.probe?.agrees === false)
        .map((c) => (
          <p key={`${c.a}${c.b}${c.dim}`} className="text-muted-foreground">
            ✗ {c.a} → {c.b} on {c.dim}: {c.agrees === false ? `measured ${c.delta?.toFixed(2)}` : ''} {c.probe?.agrees === false ? `model ${c.probe.delta.toFixed(2)}` : ''}
          </p>
        ))}
      {report.drifts.map((d) => (
        <p key={d.pair + d.dim} className="text-muted-foreground">
          ↔ {d.pair}: {d.dim} also moved {d.delta.toFixed(2)}
        </p>
      ))}
      {report.same.map((s) => (
        <p key={s.scenes.join()}>
          {s.ok ? '✓' : '✗'} {s.scenes.join(' = ')}: widest gap {s.delta.toFixed(3)} ({s.worst})
        </p>
      ))}
      {report.progressions.map((p) => (
        <p key={p.scenes.join()}>
          {p.ok ? '✓' : '✗'} {p.scenes.join(' → ')}: density {p.density.map((d) => d.toFixed(2)).join(' → ')}
        </p>
      ))}
      <p>{report.region}</p>
      {report.missing.length > 0 && <p className="text-destructive">missing: {report.missing.slice(0, 6).join(', ')}</p>}
      <button
        type="button"
        onClick={() => void save('calibration', '', report.calibration).then((ok) => setSaved(ok ? 'Calibration saved; reload to use it.' : "Couldn't save"))}
        className="rounded-full px-2.5 py-0.5 ring-1 ring-border hover:bg-secondary"
      >
        Save probe calibration
      </button>
      {saved && <span className="pl-2 text-muted-foreground">{saved}</span>}
    </div>
  );
}
