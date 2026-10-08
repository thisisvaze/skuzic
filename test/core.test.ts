import { Scale } from '@google/genai';
import { checkGeminiKey, toApiConfig } from '../src/audio/lyria';
import { NOTES, attend, frictionLevel, mayPlay, nextNote, phrase } from '../src/audio/touch';
import {
  DEFAULT_VIBE,
  chooseInstruments,
  figuresOf,
  introMix,
  isIntro,
  mixActions,
  nextMix,
  readFigure,
  readScene,
  titleOf,
  vibeById,
} from '../src/vision/eyes';
import { inkConfig } from '../src/vision/ink';
import { keepRefinement } from '../src/llm/planner';
import vectors from '../src/vision/palette-vectors.json';
import palette from '../src/vision/palette.json';
import { maxTracksFor, reduce, reduceAll } from '../src/core/reducer';
import { normalize } from '../src/core/schema';
import { INITIAL_STATE, type Action, type MixConfig, type SkuzicState } from '../src/core/types';

const MAX_TRACKS = maxTracksFor('lyria');

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}`, detail ?? '');
  }
}

const add = (label: string, prompt: string, volume: number): Action => ({
  type: 'ADD_TRACK',
  label,
  prompt,
  volume,
});

console.log('reducer');

// Adding tracks
let s: SkuzicState = reduceAll(INITIAL_STATE, [
  add('Bed', 'warm ambient pad', 0.6),
  add('Lead', 'bright marimba arpeggio', 0.9),
]);
check('adds tracks', s.tracks.length === 2, s.tracks.length);
check('assigns distinct ids', s.tracks[0].id !== s.tracks[1].id);

// Volume clamping
s = reduce(s, { type: 'SET_VOLUME', target: s.tracks[0].id, volume: 5 });
check('clamps volume to 1', s.tracks[0].volume === 1, s.tracks[0].volume);

// Label resolution — the model usually references a track by the name it chose
s = reduce(s, { type: 'SET_VOLUME', target: 'Lead', volume: 0.25 });
check('resolves target by label', s.tracks[1].volume === 0.25, s.tracks[1].volume);

// Fuzzy resolution
s = reduce(s, { type: 'SET_VOLUME', target: 'lead track', volume: 0.5 });
check('resolves fuzzy label', s.tracks[1].volume === 0.5, s.tracks[1].volume);

// Unresolvable target must be a no-op, not a crash
const before = s;
s = reduce(s, { type: 'SET_VOLUME', target: 'nonexistent', volume: 0.1 });
check('ignores unresolvable target', s === before);

// Modify
s = reduce(s, { type: 'MODIFY_TRACK', target: 'Bed', prompt: 'dark drone' });
check('modifies prompt', s.tracks[0].prompt === 'dark drone', s.tracks[0].prompt);

// Eviction at capacity
let big = INITIAL_STATE;
for (let i = 0; i < MAX_TRACKS; i++) {
  big = reduce(big, add(`T${i}`, `prompt ${i}`, i === 3 ? 0.05 : 0.8));
}
check('fills to capacity', big.tracks.length === MAX_TRACKS, big.tracks.length);
big = reduce(big, add('New', 'new prompt', 0.9));
check('stays at capacity', big.tracks.length === MAX_TRACKS, big.tracks.length);
check('evicts the quietest track', !big.tracks.some((t) => t.label === 'T3'));
check('keeps the new track', big.tracks.some((t) => t.label === 'New'));

// Remove + clear
s = reduce(s, { type: 'REMOVE_TRACK', target: 'Bed' });
check('removes by label', s.tracks.length === 1, s.tracks.length);
s = reduce(s, { type: 'CLEAR_TRACKS' });
check('clears all', s.tracks.length === 0);

// Config clamping
let c = reduce(INITIAL_STATE, { type: 'SET_CONFIG', config: { bpm: 400, density: -2 } });
check('holds bpm to the calm 100', c.config.bpm === 100, c.config.bpm);
check('clamps density to 0', c.config.density === 0, c.config.density);
c = reduce(c, { type: 'SET_CONFIG', config: { bpm: 10 } });
check('clamps bpm to 60', c.config.bpm === 60, c.config.bpm);
c = reduce(c, { type: 'SET_CONFIG', config: { guidance: 6 } });
check('holds guidance to the calm 5', c.config.guidance === 5, c.config.guidance);
const loud = toApiConfig({ ...INITIAL_STATE.config, density: 1, brightness: 1 });
const hushed = toApiConfig({ ...INITIAL_STATE.config, density: 0, brightness: 0 });
check(
  'the full dial reaches Lyria only as busy and bright as calm gets',
  Math.abs(loud.density! - 0.6) < 1e-9 && Math.abs(loud.brightness! - 0.8) < 1e-9 &&
    Math.abs(hushed.density! - 0.15) < 1e-9 && Math.abs(hushed.brightness! - 0.35) < 1e-9,
  [loud.density, loud.brightness, hushed.density, hushed.brightness],
);
check('leaves untouched config alone', c.config.brightness === INITIAL_STATE.config.brightness);

console.log('control locks');
const requested: MixConfig = {
  bpm: 72, density: 0.8, brightness: 0.2, guidance: 1,
  scale: Scale.C_MAJOR_A_MINOR, muteDrums: true, muteBass: true,
};
const fields = Object.keys(requested) as (keyof MixConfig)[];
const queuedChange: Action = { type: 'SET_CONFIG', config: requested };
const locked = reduceAll(INITIAL_STATE, fields.map((field) => ({ type: 'SET_CONFIG_LOCK', field, locked: true })));
const blocked = reduce(locked, queuedChange);
check('every locked control rejects an automatic or in-flight change', blocked === locked);
check('locking never changes the current values', locked.config === INITIAL_STATE.config);

const manual = reduce(locked, { ...queuedChange, source: 'user' });
check('direct controls can still adjust locked values', fields.every((field) => manual.config[field] === requested[field]));
check('manual adjustment keeps all locks engaged', fields.every((field) => manual.configLocks[field]));
check('a later automatic update cannot undo the manual adjustment',
  reduce(manual, { type: 'SET_CONFIG', config: INITIAL_STATE.config }) === manual);

const unlocked = reduce(locked, { type: 'SET_CONFIG_LOCK', field: 'brightness', locked: false });
const partial = reduce(unlocked, queuedChange);
check('unlocking allows only that control to follow again', partial.config.brightness === requested.brightness &&
  fields.filter((field) => field !== 'brightness').every((field) => partial.config[field] === INITIAL_STATE.config[field]));

const refined = keepRefinement([queuedChange], locked.tracks, locked.config);
check('drawing refinements respect the same locks', reduceAll(locked, refined.actions) === locked);
const modelReply = { type: 'SET_CONFIG', bpm: 72, source: 'user' };
check('model output cannot claim to be a direct user adjustment',
  reduceAll(locked, normalize([modelReply], 'slow down')) === locked);
check('locked values remain clamped when edited manually',
  reduce(locked, { type: 'SET_CONFIG', config: { bpm: 500 }, source: 'user' }).config.bpm === 100);

// Context epoch
const e = reduce(INITIAL_STATE, { type: 'RESET_CONTEXT' });
check('bumps context epoch', e.contextEpoch === INITIAL_STATE.contextEpoch + 1);

console.log('backend switching');

const lyriaCap = maxTracksFor('lyria');
const magentaCap = maxTracksFor('magenta');
check('magenta caps lower than lyria', magentaCap < lyriaCap, { lyriaCap, magentaCap });

// Fill past magenta's cap on lyria, then switch and confirm the loudest survive.
let sw = INITIAL_STATE;
for (let i = 0; i < lyriaCap; i++) {
  sw = reduce(sw, add(`S${i}`, `prompt ${i}`, (i + 1) / lyriaCap));
}
check('starts on lyria', sw.backend === 'lyria');
check('filled to lyria cap', sw.tracks.length === lyriaCap, sw.tracks.length);

sw = reduce(sw, { type: 'SET_BACKEND', backend: 'magenta' });
check('switches backend', sw.backend === 'magenta');
check('trims to magenta cap', sw.tracks.length === magentaCap, sw.tracks.length);
check(
  'keeps the loudest tracks',
  sw.tracks.every((t) => t.volume > (lyriaCap - magentaCap) / lyriaCap),
  sw.tracks.map((t) => t.volume),
);

// Adding past the cap on magenta must respect the lower limit.
sw = reduce(sw, add('Extra', 'extra prompt', 0.99));
check('respects magenta cap on add', sw.tracks.length === magentaCap, sw.tracks.length);

const same = reduce(sw, { type: 'SET_BACKEND', backend: 'magenta' });
check('same-backend switch is a no-op', same === sw);

console.log('schema.normalize');

const raw = [
  { type: 'ADD_TRACK', prompt: 'soft rain texture', label: 'Rain', volume: 0.4 },
  { type: 'ADD_TRACK', label: 'NoPrompt' }, // missing prompt -> dropped
  { type: 'SET_VOLUME', target: 'Rain' }, // missing volume -> dropped
  { type: 'SET_VOLUME', target: 'Rain', volume: 0.7 },
  { type: 'BOGUS_ACTION', target: 'Rain' }, // unknown -> dropped
  { type: 'SET_CONFIG', bpm: 92, scale: 'NOT_A_SCALE' },
  { type: 'SET_CONFIG' }, // empty patch -> dropped
  { type: 'RESET_CONTEXT' },
];

const actions = normalize(raw, 'test event');
check('drops malformed actions', actions.length === 4, actions.map((a) => a.type));
check('keeps valid ADD_TRACK', actions[0].type === 'ADD_TRACK');
check('keeps valid SET_VOLUME', actions[1].type === 'SET_VOLUME');
check(
  'drops invalid scale but keeps bpm',
  actions[2].type === 'SET_CONFIG' &&
    actions[2].config.bpm === 92 &&
    actions[2].config.scale === undefined,
  actions[2],
);

// A label is synthesized when the model omits one
const noLabel = normalize([{ type: 'ADD_TRACK', prompt: 'deep sub bass, slow' }], 'e');
check(
  'synthesizes a label from the prompt',
  noLabel[0].type === 'ADD_TRACK' && noLabel[0].label === 'deep sub bass',
  noLabel[0],
);

console.log('touch engine');

// F major / D minor pentatonic is F G A C D: pitch classes 5 7 9 0 2.
check('every pen note is in F major / D minor pentatonic', NOTES.every((m) => [5, 7, 9, 0, 2].includes(m % 12)), NOTES);

// A fixed sequence, so the melody checks are the same on every run.
let seed = 7;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const line: number[] = [];
let note: number | null = null;
for (let i = 0; i < 300; i++) line.push((note = nextNote(note, (i * 7) % NOTES.length, rand)));
check(
  'the melody moves by steps of at most two and stays in range',
  line.every((n, i) => n >= 0 && n < NOTES.length && (i === 0 || Math.abs(n - line[i - 1]) <= 2)),
);
note = 1;
for (let i = 0; i < 12; i++) note = nextNote(note, NOTES.length - 1, rand);
check('drawing high on the page pulls the melody up', note >= 7, note);

check(
  'a phrase always comes home to F, A or C',
  Array.from({ length: 200 }, (_, i) => nextNote(i % NOTES.length, (i * 3) % NOTES.length, rand, true)).every((n) => [5, 9, 0].includes(NOTES[n] % 12)),
);
check(
  'a settled pen plays shorter phrases and breathes longer',
  phrase(0.45, () => 0.5).notes < phrase(1, () => 0.5).notes && phrase(0.45, () => 0.5).breathMs > phrase(1, () => 0.5).breathMs,
);
check('attention settles during long drawing, never below its floor', attend(1, 120_000, true) < 0.6 && attend(1, 1e9, true) >= 0.45 - 1e-9);
check('attention comes back after a pause', attend(0.45, 30_000, false) > 0.9);
check('notes keep their distance, more so as attention settles', !mayPlay(1200, 1000, 1) && mayPlay(1400, 1000, 1) && !mayPlay(1400, 1000, 0.45));
check('a still pen is silent', frictionLevel(0, 1) === 0);
check('zero pressure never mutes a moving pen', frictionLevel(800, 0) > 0);
check('friction never exceeds full level', frictionLevel(1e6, 1) <= 1);

console.log('eyes');

type Table = Record<string, { tags: string[]; doodles?: string[]; vector: number[] } | undefined>;
const fresh = (entries: { id: string; tags: string[]; doodles?: string[] }[], table: Table) =>
  entries.every((e) =>
    e.tags.length
      ? JSON.stringify(table[e.id]?.tags) === JSON.stringify(e.tags) &&
        JSON.stringify(table[e.id]?.doodles) === JSON.stringify(e.doodles) &&
        table[e.id]?.vector.length === 768
      : !table[e.id],
  );
check(
  'palette vectors match the tags and doodles (re-run scripts/embed-palette.py after editing them)',
  fresh(palette.moods, vectors.moods) && fresh(palette.instruments, vectors.instruments),
);
check(
  'every mood plays its own prompt, since the mixer keys layers on prompt text',
  new Set(palette.moods.map((m) => m.prompt)).size === palette.moods.length,
);
check('a figure that reads exactly like rain picks rain', readFigure(vectors, vectors.moods.rainy.vector)[0].item.id === 'rainy');

const segment = (x0: number, y0: number, x1: number, y1: number) =>
  Array.from({ length: 30 }, (_, k) => [x0 + ((x1 - x0) * k) / 29, y0 + ((y1 - y0) * k) / 29]);
const mark = (id: number, color: string, points: number[][], erasing = false) => ({ id, color, points, erasing });
const sheet = { width: 1000, height: 800 };
const sun = [mark(0, 'gold', segment(800, 100, 900, 100)), mark(1, 'gold', segment(850, 50, 850, 150))];
check('strokes drawn together in one ink make one figure', figuresOf(sun, sheet).length === 1);
check('a new ink starts a new figure', figuresOf([...sun, mark(2, 'red', segment(860, 110, 880, 130))], sheet).length === 2);
check('a stroke far from the last figure starts another', figuresOf([...sun, mark(2, 'gold', segment(100, 600, 200, 600))], sheet).length === 2);
const rubbed = figuresOf([...sun, mark(3, 'paper', segment(840, 90, 860, 110), true)], sheet);
check(
  'an eraser across a figure changes its key, so it is read again',
  rubbed.length === 1 && rubbed[0].key !== figuresOf(sun, sheet)[0].key,
);

const mood = (id: string) => palette.moods.find((m) => m.id === id)!;
const figure = (key: string, size: number, reads: [string, number][], strokes = 5) => ({
  figure: { key, box: { x: 0, y: 0, width: size, height: size }, strokes },
  image: vectors.moods[reads[0][0] as keyof typeof vectors.moods].vector,
  moods: reads.map(([id, p]) => ({ item: mood(id), p })),
});
const scenery = [
  figure('m', 600, [['mountains', 0.95], ['volcano', 0.05]]),
  figure('s', 150, [['sunny', 1]]),
  figure('t', 300, [['trees', 0.9], ['xmas', 0.1]]),
];
const landscape = nextMix(readScene(vectors, scenery), null)!;
check('a landscape plays its things together, the biggest first', titleOf(landscape) === 'mountains, trees and sunshine', titleOf(landscape));
const biked = nextMix(readScene(vectors, [...scenery, figure('b', 250, [['bicycle', 0.97], ['car', 0.03]])]), landscape);
check(
  'a bike drawn into a finished landscape joins the music without taking it over',
  biked?.moods[0].item.id === 'mountains' && biked.moods.some((r) => r.item.id === 'bicycle'),
  biked && titleOf(biked),
);
check('the same reading twice changes nothing', nextMix(readScene(vectors, scenery), landscape) === null);
const unsure = [figure('x', 300, [['energy', 0.3], ['water', 0.25], ['spiral', 0.25], ['snake', 0.2]])];
check('an unsure first reading starts the intro', isIntro(nextMix(readScene(vectors, unsure), null)!));
check('the intro waits for something SigLIP is sure of', nextMix(readScene(vectors, unsure), introMix(DEFAULT_VIBE)) === null);
const opening = [figure('a', 300, [['energy', 0.9], ['water', 0.1]], 1)];
check(
  'a first stroke that reads only as squiggles keeps the intro',
  isIntro(nextMix(readScene(vectors, opening), null)!) && nextMix(readScene(vectors, opening), introMix(DEFAULT_VIBE)) === null,
);
check(
  'a figure that reads clearly as a thing counts from its first stroke',
  titleOf(nextMix(readScene(vectors, [figure('s', 300, [['sunny', 0.9], ['energy', 0.1]], 1)]), null)!) === 'sunshine',
);
const marked = nextMix(readScene(vectors, [figure('m', 300, [['mountains', 0.9], ['energy', 0.1]]), figure('q', 400, [['energy', 0.95], ['water', 0.05]], 1), figure('n', 300, [['energy', 0.8], ['snake', 0.2]], 1)]), null)!;
check('a finished scribble adds colour but the things lead', titleOf(marked) === 'mountains and squiggles', titleOf(marked));

const [i1, i2, i3] = palette.instruments;
const seats = (ids: string[]) => chooseInstruments(
  [{ item: i3, p: 0.5 }, { item: i1, p: 0.3 }, { item: i2, p: 0.2 }], ids).map((i) => i.id);
check('a fresh page seats the two likeliest instruments', JSON.stringify(seats([])) === JSON.stringify([i3.id, i1.id]));
check(
  'a clear challenger replaces only the weaker instrument',
  JSON.stringify(seats([i1.id, i2.id])) === JSON.stringify([i3.id, i1.id]),
);
check(
  'a narrow challenger changes nothing',
  JSON.stringify(chooseInstruments([{ item: i3, p: 0.35 }, { item: i1, p: 0.33 }, { item: i2, p: 0.32 }], [i1.id, i2.id]).map((i) => i.id)) ===
    JSON.stringify([i1.id, i2.id]),
);

const rain = [figure('r', 400, [['rainy', 1]])];
const rainy = nextMix(readScene(vectors, rain), null)!;
const layers = (mix: typeof rainy, backend: 'lyria' | 'magenta') =>
  mixActions(mix, backend, { density: 0.4, brightness: 0.4 }).filter((a) => a.type === 'ADD_TRACK');
check(
  'a mix is ground, up to three things and up to two instruments, never below 0.15',
  mixActions(landscape, 'lyria', {})[0].type === 'CLEAR_TRACKS' &&
    layers(landscape, 'lyria').length <= 6 &&
    layers(landscape, 'lyria').every((a) => a.type === 'ADD_TRACK' && a.volume >= 0.15),
);
check(
  'each engine gets its measured balance',
  layers(rainy, 'lyria')[0].type === 'ADD_TRACK' && layers(rainy, 'lyria')[0].prompt === DEFAULT_VIBE.ground.lyria &&
    layers(rainy, 'magenta')[0].type === 'ADD_TRACK' && layers(rainy, 'magenta')[0].prompt === DEFAULT_VIBE.ground.magenta &&
    layers(rainy, 'lyria')[1].type === 'ADD_TRACK' && layers(rainy, 'lyria')[1].volume === palette.moodWeight.lyria &&
    layers(rainy, 'magenta')[1].type === 'ADD_TRACK' && layers(rainy, 'magenta')[1].volume === palette.moodWeight.magenta,
);
check(
  'each thing is its own layer, named for it, the biggest loudest',
  layers(landscape, 'lyria')
    .slice(1, 4)
    .map((a) => (a.type === 'ADD_TRACK' ? `${a.label} ${a.volume}` : ''))
    .join(', ') === 'mountains 0.26, trees 0.15, sunshine 0.15',
  layers(landscape, 'lyria'),
);

const jazz = vibeById('jazz');
const piano = vibeById('piano');
check(
  'a vibe plays in its own style',
  mixActions(rainy, 'lyria', {}, jazz).some((a) => a.type === 'ADD_TRACK' && a.label === 'Style' && a.prompt === jazz.ground.lyria),
);
check(
  "only the vibe's own instruments compete for a seat",
  readScene(vectors, rain, jazz).instruments.every((r) => jazz.instruments.includes(r.item.id)),
);
check(
  'a vibe without instruments plays its style and the page alone',
  nextMix(readScene(vectors, rain, piano), null, piano)!.instruments.length === 0,
);
check(
  'every vibe names real instruments and a style for each engine',
  palette.vibes.every(
    (v) =>
      v.ground.lyria && v.ground.magenta &&
      [...v.start, ...v.instruments].every((id) => palette.instruments.some((i) => i.id === id)) &&
      v.start.every((id) => v.instruments.includes(id)),
  ),
);

console.log('gemini refine');

const live = [
  { id: 's', label: 'Style', prompt: 'dreamy lo-fi hip hop', volume: 1, muted: false, origin: 'eyes' },
  { id: 'w', label: 'water', prompt: 'flowing and serene', volume: 0.45, muted: false, origin: 'eyes' },
  { id: 'p', label: 'felt piano', prompt: 'soft felt piano melody', volume: 0.6, muted: false, origin: 'eyes' },
];
const kept = keepRefinement(
  [
    { type: 'MODIFY_TRACK', target: 'w', prompt: 'dusky, swirling and dreamlike' },
    { type: 'MODIFY_TRACK', target: 's', prompt: 'dark techno' },
    { type: 'MODIFY_TRACK', target: 'Felt Piano', prompt: 'felt piano, slow and rubato' },
    { type: 'ADD_TRACK', label: 'Choir', prompt: 'angelic choir', volume: 0.5 },
    { type: 'CLEAR_TRACKS' },
    { type: 'SET_CONFIG', config: { density: 0.95, bpm: 140 } },
  ],
  live,
  { density: 0.4, brightness: 0.6 },
);
check(
  'a refine rewrites only the layers\' words, by id or by label when the eyes rebuilt the tracks',
  JSON.stringify([...kept.words]) === JSON.stringify([['water', 'dusky, swirling and dreamlike'], ['felt piano', 'felt piano, slow and rubato']]),
  [...kept.words],
);
check('a refine never touches the style, adds, removes or clears', kept.actions.every((a) => a.type === 'MODIFY_TRACK' ? a.target !== 's' : a.type === 'SET_CONFIG'));
check(
  'a refine moves only the two live knobs, inside their gentle range',
  JSON.stringify(kept.knobs) === JSON.stringify({ density: 0.85, brightness: 0.6 }) &&
    kept.actions.some((a) => a.type === 'SET_CONFIG' && !('bpm' in a.config)),
  kept.knobs,
);

console.log('ink');

const base = { density: 0.4, brightness: 0.5 };
check('a fuller page plays busier', inkConfig(base, { coverage: 0.25, warmth: 0 }).density > inkConfig(base, { coverage: 0.02, warmth: 0 }).density);
check('warm colours play brighter, cool ones darker', inkConfig(base, { coverage: 0.1, warmth: 1 }).brightness > inkConfig(base, { coverage: 0.1, warmth: -1 }).brightness);
check('ink never pushes the knobs out of their gentle range', [0, 0.5, 1].every((c) => [-1, 1].every((w) => {
  const k = inkConfig({ density: 0.85, brightness: 0.9 }, { coverage: c, warmth: w });
  return k.density <= 0.85 && k.density >= 0.15 && k.brightness <= 0.9 && k.brightness >= 0.15;
})));

console.log('key check');

const google = (status: number) => async () => new Response(null, { status });
check('a key Google accepts connects', (await checkGeminiKey('k', google(200))) === null);
check('a rate-limited key still connects', (await checkGeminiKey('k', google(429))) === null);
check('a rejected key says so', /didn't accept/.test((await checkGeminiKey('k', google(400))) ?? ''));
check('a restricted key says so', /restricted/.test((await checkGeminiKey('k', google(403))) ?? ''));
check('no Lyria for the key says so', /Lyria/.test((await checkGeminiKey('k', google(404))) ?? ''));
check('no network says so', /reach Google/.test(
  (await checkGeminiKey('k', async () => { throw new TypeError('offline'); })) ?? '',
));

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
