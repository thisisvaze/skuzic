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

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
