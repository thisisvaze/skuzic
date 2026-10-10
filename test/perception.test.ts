import { INITIAL_CONFIG, type Track } from '../src/core/types';
import { evaluate, type SceneReading } from '../src/perception/evaluate';
import { GestureReader, type StrokeTool } from '../src/perception/gesture';
import { MODEL_FEEDS, targetsOf, type Inputs, type Targets } from '../src/perception/mapping';
import { changeOf, measureImage, measureStrokes, planesOf, type Pixels } from '../src/perception/measure';
import { calibrate, scoreProbes } from '../src/perception/probes';
import { COMPARISONS, SCENES } from '../src/perception/scenes';
import { Glide, Lane } from '../src/perception/state';
import { ORIGIN, layersOf, streamActions } from '../src/perception/stream';
import { seatTimbres, timbresFor } from '../src/perception/timbre';
import { vibeById } from '../src/vision/eyes';
import { euclid, rhythmOf } from '../src/perception/voice';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, detail ?? '');
  }
}

// ---- a tiny rasterizer: strokes glazed onto paper, as the app multiplies ----

const W = 400;
const H = 250;
type Stroke = { points: number[][]; width: number; color: number[]; soft?: number; alpha?: number };
function paint(strokes: Stroke[]): Pixels {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) data.set([252, 251, 248, 255], i * 4);
  for (const s of strokes) {
    const soft = s.soft ?? 0.5;
    const reach = s.width / 2 + soft + 1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let d = Infinity;
        for (let k = 1; k < s.points.length; k++) {
          const [ax, ay] = s.points[k - 1];
          const [bx, by] = s.points[k];
          const vx = bx - ax;
          const vy = by - ay;
          const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy || 1)));
          d = Math.min(d, Math.hypot(x - ax - t * vx, y - ay - t * vy));
        }
        if (d > reach) continue;
        const a = Math.max(0, Math.min(1, (s.width / 2 + soft - d) / (2 * soft))) * (s.alpha ?? 1);
        for (let c = 0; c < 3; c++) data[(y * W + x) * 4 + c] *= 1 - a + (a * s.color[c]) / 255;
      }
    }
  }
  return { data, width: W, height: H };
}
const line = (x0: number, y0: number, x1: number, y1: number) => Array.from({ length: 21 }, (_, i) => [x0 + ((x1 - x0) * i) / 20, y0 + ((y1 - y0) * i) / 20]);
const wave = (y: number) => Array.from({ length: 81 }, (_, i) => [30 + (i / 80) * 340, y + 22 * Math.sin((i / 80) * 6 * Math.PI)]);
const zig = (y: number) => Array.from({ length: 17 }, (_, i) => [30 + (i / 16) * 340, y + (i % 2 ? 20 : -20)]);
const circle = (cx: number, cy: number, r: number) => Array.from({ length: 61 }, (_, i) => [cx + r * Math.cos((i / 60) * 2 * Math.PI), cy + r * Math.sin((i / 60) * 2 * Math.PI)]);
const BLACK = [21, 19, 15];
const PALE = [205, 200, 192];
const BLUE = [45, 125, 210];
const measure = (strokes: Stroke[]) => measureImage(planesOf(paint(strokes)));
const strokesOf = (strokes: Stroke[]) => strokes.map((s, i) => ({ id: i, erasing: false, points: s.points }));
const pageSize = { width: W, height: H };

console.log('measurements');
{
  const lines = (color: number[]) => [line(40, 50, 360, 70), line(50, 130, 350, 150), line(60, 200, 340, 210)].map((points) => ({ points, width: 3, color }));
  const dark = measure(lines(BLACK));
  const pale = measure(lines(PALE));
  check('pale marks read lighter than dark ones', pale.lightness > dark.lightness + 0.4, { pale: pale.lightness, dark: dark.lightness });
  check('...with less contrast', pale.contrast < dark.contrast - 0.4);
  check('...while density, openness and edges stay put', Math.abs(pale.density - dark.density) < 0.15 && Math.abs(pale.openness - dark.openness) < 0.15 && Math.abs(pale.softness - dark.softness) < 0.15);

  const hatching = measure(Array.from({ length: 45 }, (_, i) => ({ points: line(20 + i * 8, 20, i * 8, 230), width: 2.5, color: BLACK })));
  check('hatching reads denser and busier than three lines', hatching.density > dark.density + 0.5 && hatching.texture > dark.texture + 0.3, hatching);
  check('three lines leave the page mostly blank; hatching covers most of it', dark.openness > 0.7 && hatching.openness < 0.3, { lines: dark.openness, hatching: hatching.openness });

  const crisp = measure([wave(80), wave(170)].map((points) => ({ points, width: 9, color: BLUE })));
  const soft = measure([wave(80), wave(170)].map((points) => ({ points, width: 9, color: BLUE, soft: 6, alpha: 0.8 })));
  check('soft edges read softer than crisp ones', soft.softness > crisp.softness + 0.5, { soft: soft.softness, crisp: crisp.softness });

  const wash = measure([{ points: wave(125), width: 60, color: BLUE, soft: 10, alpha: 0.35 }]);
  const hueOf = (color: number[]) => measure([{ points: wave(125), width: 9, color }]);
  const [blue, violet, amber, red, black] = [[45, 125, 210], [124, 58, 237], [240, 162, 2], [209, 73, 91], [21, 19, 15]].map(hueOf);
  check(
    'tint tells blue from violet and amber from red; black has next to no colour',
    violet.tint < blue.tint - 0.2 && amber.tint > red.tint + 0.5 && Math.hypot(black.warmth, black.tint) < 0.3,
    { blue: [blue.warmth, blue.tint], violet: [violet.warmth, violet.tint], amber: [amber.warmth, amber.tint], red: [red.warmth, red.tint], black: [black.warmth, black.tint] },
  );
  check('a broad wash reads heavier and less busy than hatching', wash.weight > hatching.weight && wash.texture < hatching.texture);

  const empty = measure([]);
  check('an empty page has no ink, density or contrast, and is all open', empty.ink === 0 && empty.density === 0 && empty.contrast === 0 && empty.openness === 1);

  const round = [circle(110, 125, 70), circle(290, 125, 60)];
  const jagged = [zig(80), zig(170)];
  const visible = () => 1;
  const r = measureStrokes(strokesOf(round.map((points) => ({ points, width: 3, color: BLACK }))), pageSize, visible);
  const j = measureStrokes(strokesOf(jagged.map((points) => ({ points, width: 3, color: BLACK }))), pageSize, visible);
  check('zigzags read angular, circles round', j.angularity > 0.7 && r.angularity < 0.2, { round: r.angularity, jagged: j.angularity });
  const straight = measureStrokes(strokesOf([{ points: line(20, 20, 380, 230), width: 3, color: BLACK }]), pageSize, visible);
  check('a straight line has no curvature to speak of', straight.curvature < 0.05 && straight.turning < 0.3, straight);
  const erased = measureStrokes(strokesOf(jagged.map((points) => ({ points, width: 3, color: BLACK }))), pageSize, () => 0);
  check('erased strokes count for nothing', erased.length === 0 && erased.turning === 0);

  const before = planesOf(paint([{ points: circle(200, 125, 60), width: 4, color: BLACK }]));
  const more = planesOf(paint([{ points: circle(200, 125, 60), width: 4, color: BLACK }, { points: line(40, 30, 360, 40), width: 4, color: BLACK }]));
  const recolored = planesOf(paint([{ points: circle(200, 125, 60), width: 4, color: [209, 73, 91] }]));
  const added = changeOf(before, more);
  check('adding a stroke reads as ink added where it went', added.added > 0 && added.removed === 0 && !!added.box && added.box.y < 60, added);
  check('taking it away reads as ink removed', changeOf(more, before).removed > 0 && changeOf(more, before).added === 0);
  check('a new colour over a form reads as recoloured, not new ink', changeOf(before, recolored).recolored > 0 && changeOf(before, recolored).added < changeOf(before, recolored).recolored);
}

console.log('versioned perception jobs');
await (async () => {
  type Job = { version: number; input: number };
  let page = 0;
  let version = 0;
  const pending: ((v: number) => void)[] = [];
  const applied: number[] = [];
  const failed: string[] = [];
  const lane = new Lane<number, number>(
    (): Job => ({ version, input: page }),
    (input) => new Promise<number>((resolve) => pending.push(() => resolve(input))),
    (out) => applied.push(out),
    (e) => failed.push(e.message),
  );
  const finish = async () => {
    pending.shift()?.(0);
    await new Promise((r) => setTimeout(r, 0));
  };
  page = 1;
  version = 1;
  lane.request(true);
  page = 2;
  version = 2;
  lane.request();
  page = 3;
  version = 3;
  lane.request(true);
  check('one job in flight; the rest wait', pending.length === 1);
  await finish();
  check('the first result lands', applied.join() === '1', applied);
  check('waiting requests collapse into one read of the newest page', pending.length === 1);
  await finish();
  check('...which lands next', applied.join() === '1,3', applied);

  // A read is under way when the page is cleared: its result must never land.
  page = 4;
  version = 4;
  lane.request(true);
  version = 5;
  page = 0;
  lane.invalidate(5);
  lane.request(true);
  await finish();
  check('a read of a page since cleared is dropped', !applied.includes(4), applied);
  await finish();
  check('the cleared page lands instead', applied.at(-1) === 0, applied);

  const bad = new Lane<number, number>(
    () => ({ version: ++version, input: 0 }),
    async () => {
      throw new Error('model unavailable');
    },
    () => applied.push(-1),
    (e) => failed.push(e.message),
  );
  bad.request(true);
  await new Promise((r) => setTimeout(r, 0));
  check('a failed read reports and lands nothing', failed.includes('model unavailable') && !applied.includes(-1));
  bad.request(true);
  await new Promise((r) => setTimeout(r, 0));
  check('...and the next request still runs', failed.length === 2, failed);
})();

console.log('glides');
{
  const g = new Glide(0, 100);
  g.set(1, 0);
  check('glides toward its target', g.at(100) > 0.6 && g.at(100) < 0.7 && g.at(1000) > 0.999);
  g.set(0, 1000);
  check('a new target starts from where it is', Math.abs(g.at(1000) - 1) < 1e-3);
  g.reset(0.3, 2000);
  check('reset jumps', g.at(2000) === 0.3);
}

console.log('gesture');
{
  const tool: StrokeTool = { medium: 'pencil', color: '#15130f', size: 3, alpha: 1, erasing: false, simulate: true };
  const page = { width: 1000, height: 700 };
  const g = new GestureReader();
  g.down(100, 100, 0.5, 0, tool, page);
  for (let i = 1; i <= 50; i++) g.move(100 + i * 12, 100, 0.5, i * 8);
  const fast = g.features(400);
  check('quick drawing reads lively', fast.speed > 0.7 && fast.energy > 0.4, fast);
  check('...and never past the cap', fast.energy <= 0.85);
  check('a straight sweep has no jolt', fast.jolt < 0.05, fast.jolt);
  g.up(410);
  check('the hand settles after the pen lifts', g.features(4000).energy < 0.1 && g.features(4000).energy < fast.energy);

  const z = new GestureReader();
  z.down(100, 300, 0.5, 0, tool, page);
  let t = 0;
  for (let leg = 0; leg < 6; leg++) {
    for (let i = 1; i <= 8; i++) z.move(100 + leg * 60 + i * 7.5, 300 + (leg % 2 ? -1 : 1) * i * 7.5, 0.5, (t += 8));
  }
  check('corners jolt', z.features(t).jolt > 0.5, z.features(t));
}

console.log('mapping');
{
  const of = (values: Record<string, number>, support = 1): Inputs =>
    Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v, support }]));
  const base = { ink: 0.05, lightness: 0.5, density: 0.3, texture: 0.3, softness: 0.3, contrast: 0.5, angularity: 0.3, openness: 0.4 };
  const light = targetsOf(of({ ...base, lightness: 0.9 })).targets;
  const dark = targetsOf(of({ ...base, lightness: 0.15 })).targets;
  check('lighter marks play higher', light.register > dark.register + 0.3, { light: light.register, dark: dark.register });
  check('...and lightness moves nothing else much', Math.abs(light.fullness - dark.fullness) < 0.01 && Math.abs(light.phrasing - dark.phrasing) < 0.01);
  const full = targetsOf(of({ ...base, density: 0.9 })).targets;
  check('a fuller page plays fuller', full.fullness > targetsOf(of(base)).targets.fullness + 0.2);
  const unsure = targetsOf(of({ ...base, lightness: 0.95 }, 0)).targets;
  check('unsupported readings sit at neutral', Math.abs(unsure.register - 0.5) < 1e-9, unsure.register);
  const without = targetsOf(of(base)).targets;
  const flowing = targetsOf({ ...of(base), 'model.flowing': { value: 0.95, support: 0.8 } }).targets;
  check('a model probe not retained changes nothing', MODEL_FEEDS['model.flowing'] === 0 && flowing.phrasing === without.phrasing);
  const soft = targetsOf({ ...of(base), 'model.soft': { value: 0.95, support: 0.8 } }).targets;
  check('a retained probe leans its target, within its share', MODEL_FEEDS['model.soft'] > 0 && soft.articulation < without.articulation && without.articulation - soft.articulation < 0.15);
  const empty = targetsOf({}).targets;
  check('no readings at all still gives a full set of targets', Object.values(empty).every((v) => Number.isFinite(v)) && empty.presence === 0, empty);
  check('every target stays in bounds', [light, dark, full, unsure].every((t) => t.tension <= 0.6 && t.energy <= 0.85 && t.fullness <= 0.9));
}

console.log('the stream follows');
{
  const targets = (over: Partial<Targets>): Targets => ({
    register: 0.5, fullness: 0.5, articulation: 0.5, phrasing: 0.5, energy: 0.3, tension: 0.2, space: 0.5, pan: 0, presence: 1, ...over,
  });
  const base = [{ label: 'Rhodes', prompt: 'warm Rhodes chords', volume: 0.6 }];
  const first = streamActions(targets({ phrasing: 0.9 }), [], INITIAL_CONFIG, base);
  check('starts with the vibe instruments and the leaning axes only', first.filter((a) => a.type === 'ADD_TRACK').map((a) => a.type === 'ADD_TRACK' && a.label).join() === 'Rhodes,Phrasing', first);
  const tracks: Track[] = [
    { id: 'a', label: 'Rhodes', prompt: 'warm Rhodes chords', volume: 0.6, muted: false, origin: ORIGIN },
    { id: 'b', label: 'Phrasing', prompt: layersOf(targets({ phrasing: 0.9 }))[0].prompt, volume: layersOf(targets({ phrasing: 0.9 }))[0].weight, muted: false, origin: ORIGIN },
  ];
  const config = { ...INITIAL_CONFIG, density: 0.5, brightness: 0.5 };
  const softer = streamActions(targets({ phrasing: 0.7 }), tracks, config, base);
  check('a smaller lean turns the layer down without new words', softer.length === 1 && softer[0].type === 'SET_VOLUME', softer);
  const flip = streamActions(targets({ phrasing: 0.1 }), tracks, config, base);
  check('words flip only once the old ones are silent', flip.length === 1 && flip[0].type === 'SET_VOLUME' && flip[0].volume === 0, flip);
  const silent = tracks.map((t) => (t.id === 'b' ? { ...t, volume: 0 } : t));
  const flipped = streamActions(targets({ phrasing: 0.1 }), silent, config, base);
  check('...then change', flipped.some((a) => a.type === 'MODIFY_TRACK') && flipped.some((a) => a.type === 'SET_VOLUME' && a.volume > 0), flipped);
  check('a change too small to hear sends nothing', streamActions(targets({ phrasing: 0.9 }), tracks, config, base).length === 0);
  const knobs = streamActions(targets({ phrasing: 0.9, fullness: 0.8 }), tracks, config, base);
  check('fullness moves the density knob while the words stay', knobs.length === 1 && knobs[0].type === 'SET_CONFIG' && knobs[0].config.density === 0.8, knobs);
  check('an empty page sends nothing', streamActions(targets({ presence: 0 }), [], config, base).length === 0);
  const swapped = streamActions(targets({ phrasing: 0.9 }), tracks, config, [{ label: 'flute', prompt: 'airy wooden flute', volume: 0.6 }]);
  check(
    'a new instrument comes in and the old one goes, the axes untouched',
    swapped.length === 2 && swapped.some((a) => a.type === 'REMOVE_TRACK' && a.target === 'a') && swapped.some((a) => a.type === 'ADD_TRACK' && a.label === 'flute'),
    swapped,
  );
}

console.log('timbre: what the art is made of picks the instruments');
{
  const targets = (over: Partial<Targets>): Targets => ({
    register: 0.5, fullness: 0.5, articulation: 0.5, phrasing: 0.5, energy: 0.3, tension: 0.2, space: 0.5, pan: 0, presence: 1, ...over,
  });
  // A Lab hue in degrees, as measured warmth and tint; no hue is graphite.
  const colour = (hue?: number): Inputs => {
    if (hue === undefined) return {};
    const a = ((hue - 55) * Math.PI) / 180;
    return { warmth: { value: 0.5 + Math.cos(a) / 2, support: 1 }, tint: { value: 0.5 + Math.sin(a) / 2, support: 1 } };
  };
  const blank = vibeById('blank');
  const soft = { articulation: 0.2, phrasing: 0.25 };
  const crisp = { articulation: 0.85, phrasing: 0.7 };
  const lead = (over: Partial<Targets>, hue?: number, vibe = blank) => timbresFor(targets(over), colour(hue), vibe)[0]?.timbre.id;
  const top2 = (over: Partial<Targets>, hue?: number) => timbresFor(targets(over), colour(hue), blank).slice(0, 2).map((r) => r.timbre.id);
  check('a pale blue wash plays flute (Kandinsky: light blue)', lead({ ...soft, register: 0.75 }, 250) === 'flute', lead({ ...soft, register: 0.75 }, 250));
  check('a deep blue wash plays cello', lead({ ...soft, register: 0.25 }, 280) === 'cello', lead({ ...soft, register: 0.25 }, 280));
  check('green plays the violins', lead({ ...soft, register: 0.55 }, 131) === 'strings', lead({ ...soft, register: 0.55 }, 131));
  check('violet plays the reeds', lead({ ...soft, register: 0.45 }, 309) === 'clarinet', lead({ ...soft, register: 0.45 }, 309));
  check('warm red plays the horn', lead({ ...soft, register: 0.4 }, 19) === 'horn', lead({ ...soft, register: 0.4 }, 19));
  check('crisp yellow marks ring as bells', top2({ ...crisp, register: 0.7 }, 76).includes('glockenspiel'), top2({ ...crisp, register: 0.7 }, 76));
  check('crisp black lines are plucked', ['guitar', 'harp', 'kalimba'].includes(lead({ ...crisp, register: 0.3 })!), lead({ ...crisp, register: 0.3 }));
  check('soft black lines are struck gently or held', ['piano', 'rhodes', 'pads'].includes(lead({ articulation: 0.45, phrasing: 0.4, register: 0.3 })!), lead({ articulation: 0.45, phrasing: 0.4, register: 0.3 }));
  check('the same blue drawn crisp is played, not bowed', lead({ ...crisp, register: 0.4 }, 277) !== lead({ ...soft, register: 0.4 }, 277));
  const jazz = vibeById('jazz');
  check("only the vibe's instruments are offered", timbresFor(targets({}), colour(19), jazz).every((r) => jazz.instruments.includes(r.timbre.id) || r.timbre.id === 'clarinet'));
  check('solo piano offers none', timbresFor(targets({}), {}, vibeById('piano')).length === 0);
  const ranked = timbresFor(targets({ ...soft, register: 0.75 }), colour(250), blank);
  const ids = (t: { id: string }[]) => t.map((x) => x.id).join();
  check('a fresh page seats the two likeliest', ids(seatTimbres(ranked, [])) === ids(ranked.slice(0, 2).map((r) => r.timbre)));
  const [first, second] = ranked;
  const narrow = ranked.map((r) => (r === first ? { ...r, p: 0.3 } : r === second ? { ...r, p: 0.29 } : { ...r, p: 0.28 }));
  const others = ranked.slice(2, 4).map((r) => r.timbre.id);
  check('a narrow challenger changes nothing', ids(seatTimbres(narrow, others)) === others.join(), ids(seatTimbres(narrow, others)));
  const swapped = seatTimbres(ranked, [ranked.at(-1)!.timbre.id, ranked.at(-2)!.timbre.id]);
  check('a clear challenger takes only one seat', swapped.length === 2 && swapped.some((t) => t.id === first.timbre.id) && swapped.some((t) => t.id === ranked.at(-2)!.timbre.id), ids(swapped));
}

console.log('the prototype voice');
{
  check('euclid spreads onsets evenly', euclid(3, 8).map(Number).join('') === '10010010', euclid(3, 8));
  const t = (over: Partial<Targets>): Targets => ({
    register: 0.5, fullness: 0.5, articulation: 0.5, phrasing: 0.5, energy: 0.5, tension: 0.2, space: 0.5, pan: 0, presence: 1, ...over,
  });
  const most = Math.max(...[0, 0.5, 1].flatMap((f) => [0, 0.5, 1].flatMap((e) => [0, 1].map((bar) => rhythmOf(t({ fullness: f, energy: e }), bar).filter(Boolean).length))));
  check('never more than six notes in a bar, however busy', most <= 6, most);
  check('a sparse page still plays something', rhythmOf(t({ fullness: 0, energy: 0 }), 0).filter(Boolean).length >= 1);
  const smoothEnd = rhythmOf(t({ fullness: 1, energy: 1, phrasing: 0.2 }), 1);
  check('smooth phrasing breathes at the end of a phrase', !smoothEnd[6] && !smoothEnd[7], smoothEnd);
  check('punctuated phrasing falls off the beat', !rhythmOf(t({ phrasing: 0.9, fullness: 0.3, energy: 0.3 }), 0)[0] || rhythmOf(t({ phrasing: 0.9, fullness: 0.3, energy: 0.3 }), 1)[0] === false);
}

console.log('probes and evaluation');
{
  const v = { vectors: { light: [1, 0], dense: [0, 1] }, calibration: { light: { mu: 0.5, sigma: 0.1 } } };
  const s = scoreProbes([0.5, 0.5], v);
  check('a calibrated probe at its centre reads 0.5', Math.abs(s.light.value - 0.5) < 1e-9 && s.dense.value > 0.5, s);
  check('probes without vectors are skipped', !('soft' in s));
  check('calibration centres and scales', JSON.stringify(calibrate([1, 3])) === JSON.stringify({ mu: 2, sigma: 1 }));

  // Readings that agree with every designed comparison, by construction.
  const readings: Record<string, SceneReading> = Object.fromEntries(Object.keys(SCENES).map((n) => [n, { values: {}, raw: {} }]));
  for (const c of COMPARISONS) {
    readings[c.a].values[c.dim] ??= 0.3;
    readings[c.b].values[c.dim] = (readings[c.a].values[c.dim] ?? 0.3) + 0.2;
  }
  const report = evaluate(readings);
  check('scoring counts agreeing pairs', report.measured[0] > 0 && report.comparisons.every((c) => c.agrees !== false || readings[c.b].values[c.dim] <= readings[c.a].values[c.dim]));
  check('scenes are built from inputs a hand could make', Object.values(SCENES).every((make) => {
    const rec = make();
    return rec.events.length > 0 && rec.events[0].type === 'down' && rec.events.every((e, i) => i === 0 || e.t >= rec.events[i - 1].t);
  }));
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nall passed');
