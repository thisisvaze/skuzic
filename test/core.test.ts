import { NOTES, attend, frictionLevel, mayPlay, nextNote, phrase } from '../src/audio/touch';
import { INTRO, chooseInstruments, chooseMood, mixActions, nextMix, readPage } from '../src/vision/eyes';
import { inkConfig } from '../src/vision/ink';
import vectors from '../src/vision/palette-vectors.json';
import palette from '../src/vision/palette.json';
import { maxTracksFor, reduce, reduceAll } from '../src/core/reducer';
import { normalize } from '../src/core/schema';
import { INITIAL_STATE, type Action, type SkuzicState } from '../src/core/types';

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
check('clamps bpm to 200', c.config.bpm === 200, c.config.bpm);
check('clamps density to 0', c.config.density === 0, c.config.density);
c = reduce(c, { type: 'SET_CONFIG', config: { bpm: 10 } });
check('clamps bpm to 60', c.config.bpm === 60, c.config.bpm);
check('leaves untouched config alone', c.config.brightness === INITIAL_STATE.config.brightness);

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

type Table = Record<string, { tags: string[]; vector: number[] } | undefined>;
const fresh = (entries: { id: string; tags: string[] }[], table: Table) =>
  entries.every((e) =>
    e.tags.length
      ? JSON.stringify(table[e.id]?.tags) === JSON.stringify(e.tags) && table[e.id]?.vector.length === 768
      : !table[e.id],
  );
check(
  'palette vectors match the tags (re-run scripts/embed-palette.py after editing them)',
  fresh(palette.moods, vectors.moods) && fresh(palette.instruments, vectors.instruments),
);

const rainy = readPage(vectors.moods.rainy.vector);
check('a page that reads exactly like rain picks the rain mood', rainy.moods[0].item.id === 'rainy');
const [m1, m2] = rainy.moods.map((r) => r.item);
check('an ambiguous page keeps the playing mood', chooseMood([{ item: m1, p: 0.3 }, { item: m2, p: 0.25 }], null) === null);
check('a narrow lead keeps the playing mood', chooseMood([{ item: m1, p: 0.5 }, { item: m2, p: 0.4 }], m2.id) === null);
check('a clear, confident reading switches mood', chooseMood([{ item: m1, p: 0.8 }, { item: m2, p: 0.1 }], m2.id) === m1);

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
check('an unsure first reading starts the intro', nextMix({ moods: [{ item: m1, p: 0.3 }], instruments: rainy.instruments }, null) === INTRO);
check('the same reading twice changes nothing', nextMix(rainy, nextMix(rainy, null)) === null);

const mixed = (backend: 'lyria' | 'magenta') => mixActions(nextMix(rainy, null)!, backend, { density: 0.4, brightness: 0.4 });
const layers = (backend: 'lyria' | 'magenta') => mixed(backend).filter((a) => a.type === 'ADD_TRACK');
check(
  'a mix is ground, mood and up to two instruments, never below 0.15',
  mixed('lyria')[0].type === 'CLEAR_TRACKS' && layers('lyria').length <= 4 && layers('lyria').every((a) => a.type === 'ADD_TRACK' && a.volume >= 0.15),
);
check(
  'each engine gets its measured balance',
  layers('lyria')[0].type === 'ADD_TRACK' && layers('lyria')[0].prompt === palette.ground.lyria &&
    layers('magenta')[0].type === 'ADD_TRACK' && layers('magenta')[0].prompt === palette.ground.magenta &&
    layers('lyria')[1].type === 'ADD_TRACK' && layers('lyria')[1].volume === palette.moodWeight.lyria &&
    layers('magenta')[1].type === 'ADD_TRACK' && layers('magenta')[1].volume === palette.moodWeight.magenta,
);

console.log('ink');

const base = { density: 0.4, brightness: 0.5 };
check('a fuller page plays busier', inkConfig(base, { coverage: 0.25, warmth: 0 }).density > inkConfig(base, { coverage: 0.02, warmth: 0 }).density);
check('warm colours play brighter, cool ones darker', inkConfig(base, { coverage: 0.1, warmth: 1 }).brightness > inkConfig(base, { coverage: 0.1, warmth: -1 }).brightness);
check('ink never pushes the knobs out of their gentle range', [0, 0.5, 1].every((c) => [-1, 1].every((w) => {
  const k = inkConfig({ density: 0.85, brightness: 0.9 }, { coverage: c, warmth: w });
  return k.density <= 0.85 && k.density >= 0.15 && k.brightness <= 0.9 && k.brightness >= 0.15;
})));

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
