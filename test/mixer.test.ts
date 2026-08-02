import { PromptMixer } from '../src/audio/mixer';
import type { PromptWeight } from '../src/audio/engine';

let failures = 0;

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}`, detail ?? '');
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Weight of `text` in each frame the mixer emitted. */
const seriesFor = (frames: PromptWeight[][], text: string) =>
  frames.map((f) => f.find((p) => p.text === text)?.weight ?? 0);

const isMonotonicUp = (xs: number[]) => xs.every((x, i) => i === 0 || x >= xs[i - 1] - 1e-9);
const isMonotonicDown = (xs: number[]) => xs.every((x, i) => i === 0 || x <= xs[i - 1] + 1e-9);

console.log('PromptMixer — fade in');

{
  const frames: PromptWeight[][] = [];
  const mixer = new PromptMixer((p) => frames.push(p.map((x) => ({ ...x }))));

  mixer.setTarget([{ text: 'bed', weight: 0.6 }]);
  await sleep(1400);

  const bed = seriesFor(frames, 'bed');
  check('emits multiple frames', frames.length >= 3, frames.length);
  // Every send makes the model re-condition; a 100ms burst of them can stall
  // the stream. The ramp must land in a handful of sends, not one per tick.
  check('throttles the send burst', frames.length <= 5, frames.length);
  check('starts quiet', bed[0] < 0.2, bed[0]);
  check('rises monotonically', isMonotonicUp(bed), bed.map((n) => n.toFixed(2)));
  check('reaches the target exactly', Math.abs(bed.at(-1)! - 0.6) < 1e-6, bed.at(-1));
  mixer.reset();
}

console.log('PromptMixer — adding a track crossfades, it does not cut');

{
  const frames: PromptWeight[][] = [];
  const mixer = new PromptMixer((p) => frames.push(p.map((x) => ({ ...x }))));

  mixer.setTarget([{ text: 'bed', weight: 0.6 }]);
  await sleep(1400);
  const beforeCount = frames.length;

  // What a planner ADD_TRACK looks like: existing track kept, new one appears.
  mixer.setTarget([
    { text: 'bed', weight: 0.6 },
    { text: 'lead', weight: 0.9 },
  ]);
  await sleep(1400);

  const added = frames.slice(beforeCount);
  const lead = seriesFor(added, 'lead');
  const bed = seriesFor(added, 'bed');

  check('new track fades in over several frames', lead.length >= 3, lead.length);
  check('new track starts near silence', lead[0] < 0.2, lead[0]);
  check('new track rises monotonically', isMonotonicUp(lead), lead.map((n) => n.toFixed(2)));
  check('new track reaches target', Math.abs(lead.at(-1)! - 0.9) < 1e-6, lead.at(-1));
  check('existing track is undisturbed', bed.every((w) => Math.abs(w - 0.6) < 1e-6), bed);
  mixer.reset();
}

console.log('PromptMixer — removing a track fades out');

{
  const frames: PromptWeight[][] = [];
  const mixer = new PromptMixer((p) => frames.push(p.map((x) => ({ ...x }))));

  mixer.setTarget([
    { text: 'bed', weight: 0.6 },
    { text: 'lead', weight: 0.9 },
  ]);
  await sleep(1400);
  const beforeCount = frames.length;

  mixer.setTarget([{ text: 'bed', weight: 0.6 }]);
  await sleep(1400);

  const removed = frames.slice(beforeCount);
  const lead = seriesFor(removed, 'lead');
  check('removed track falls monotonically', isMonotonicDown(lead), lead.map((n) => n.toFixed(2)));
  check('removed track ends silent', lead.at(-1) === 0, lead.at(-1));
  check(
    'never emits a zero weight (backends reject it)',
    frames.every((f) => f.every((p) => p.weight > 0)),
  );
  check('never emits an empty list', frames.every((f) => f.length > 0));
  mixer.reset();
}

console.log('PromptMixer — respects the backend prompt cap');

{
  const frames: PromptWeight[][] = [];
  const mixer = new PromptMixer((p) => frames.push(p.map((x) => ({ ...x }))), 2);

  mixer.setTarget([
    { text: 'quiet', weight: 0.1 },
    { text: 'mid', weight: 0.5 },
    { text: 'loud', weight: 0.9 },
  ]);
  await sleep(1400);

  const last = frames.at(-1)!;
  check('caps concurrent prompts', last.length <= 2, last.length);
  check('keeps the loudest', last.some((p) => p.text === 'loud'));
  check('drops the quietest', !last.some((p) => p.text === 'quiet'));
  mixer.reset();
}

console.log('full replacement crossfades (the realvibe arranger swaps every track at once)');

{
  const frames: PromptWeight[][] = [];
  const mixer = new PromptMixer((p) => frames.push(p.map((x) => ({ ...x }))));

  mixer.setTarget([
    { text: 'sun bed', weight: 0.5 },
    { text: 'bird chimes', weight: 0.7 },
  ]);
  await sleep(1400);
  const beforeCount = frames.length;

  // CLEAR_TRACKS + ADD_TRACK lands as one state update: nothing in common.
  mixer.setTarget([
    { text: 'rain bed', weight: 0.6 },
    { text: 'thunder pulse', weight: 0.8 },
  ]);
  await sleep(1400);

  const swap = frames.slice(beforeCount);
  const oldTrack = seriesFor(swap, 'sun bed');
  const newTrack = seriesFor(swap, 'rain bed');

  check('old and new overlap during the swap', swap.some((f) => f.length > 2), swap.map((f) => f.length));
  check('outgoing track fades down', isMonotonicDown(oldTrack), oldTrack.map((n) => n.toFixed(2)));
  check('incoming track fades up', isMonotonicUp(newTrack), newTrack.map((n) => n.toFixed(2)));
  check('swap takes several frames, not one', swap.length >= 3, swap.length);
  check('never silent mid-swap', swap.every((f) => f.length > 0));
  check('lands on the new mix', Math.abs(newTrack.at(-1)! - 0.6) < 1e-6, newTrack.at(-1));
  check('old mix fully gone', oldTrack.at(-1) === 0, oldTrack.at(-1));
  mixer.reset();
}

console.log('coalescing delivery — a slow backend must still get the final weights');

{
  // Mirrors LyriaEngine.flush: sends overlap because each round-trip (400ms)
  // outlasts the mixer's send cadence (~300ms).
  const delivered: PromptWeight[][] = [];
  let inFlight = false;
  let pending: PromptWeight[] | undefined;

  async function send(prompts: PromptWeight[]) {
    pending = prompts;
    if (inFlight) return;
    inFlight = true;
    try {
      while (pending) {
        const next = pending;
        pending = undefined;
        await sleep(400);
        delivered.push(next);
      }
    } finally {
      inFlight = false;
    }
  }

  const mixer = new PromptMixer((p) => void send(p.map((x) => ({ ...x }))));
  mixer.setTarget([{ text: 'lead', weight: 0.9 }]);
  await sleep(2600);

  const lead = seriesFor(delivered, 'lead');
  check('drops stale intermediate frames', delivered.length < 10, delivered.length);
  check(
    'still delivers the final target weight',
    Math.abs(lead.at(-1)! - 0.9) < 1e-6,
    lead.map((n) => n.toFixed(2)),
  );
  mixer.reset();
}

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
