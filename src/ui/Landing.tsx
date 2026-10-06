import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const GITHUB = 'https://github.com/thisisvaze/skuzic';

/** A pencil line that is also a sound wave: the whole idea in one stroke. */
/** `compact` drops the name on phones, where the top bar needs the room. */
export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <svg viewBox="0 0 30 16" className="h-4 w-7.5" aria-hidden="true">
        <defs>
          <linearGradient id="skuzic-ink" x1="0" x2="1">
            <stop offset="0" stopColor="#e2711d" />
            <stop offset="0.5" stopColor="#e26d9e" />
            <stop offset="1" stopColor="#7c3aed" />
          </linearGradient>
        </defs>
        <path
          d="M2 8c2.4-6 4.8-6 7 0s4.6 6 7 0 4.6-6 7 0 3.4 4.5 5 2"
          fill="none"
          stroke="url(#skuzic-ink)"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
      <span className={cn('font-display text-[1.15rem] font-bold tracking-[-0.02em]', compact && 'hidden sm:inline')}>
        skuzic
      </span>
    </span>
  );
}

const FEATURES = [
  {
    ink: '#e2711d',
    title: 'Every stroke sings',
    body: 'You hear the paper under every stroke, and a soft piano answers in short phrases, always in key. It gives the band room as you settle in.',
  },
  {
    ink: '#2d7dd2',
    title: 'It sees your page',
    body: 'Lift the pen and SigLIP 2 reads the drawing right in your browser. A sun, rain, a house, a heart: each one moves the band.',
  },
  {
    ink: '#7c3aed',
    title: 'One song, never stopping',
    body: 'Lyria RealTime streams a single piece that bends toward your page. No restarts, no loops.',
  },
];

const FLOW = ['your pen', 'SigLIP 2, in your browser', 'a mood and instruments', 'Lyria RealTime'];

/** The product in five seconds: a sheet that draws itself while the band names what it hears. */
function DemoSheet() {
  return (
    <div className="relative mx-auto w-full max-w-[34rem]">
      <div
        aria-hidden="true"
        className="absolute -inset-8 rounded-[3rem] bg-[radial-gradient(circle_at_20%_30%,#e2711d,transparent_55%),radial-gradient(circle_at_80%_25%,#e26d9e,transparent_55%),radial-gradient(circle_at_50%_90%,#2d7dd2,transparent_60%)] opacity-30 blur-3xl"
      />
      <div className="relative rotate-[-2deg] rounded-[1.75rem] bg-paper p-2 shadow-2xl ring-1 ring-black/5">
        <svg
          viewBox="0 0 480 300"
          className="w-full"
          role="img"
          aria-label="A sun, then waves, then a heart, drawing themselves on paper"
          fill="none"
          strokeWidth="5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <g className="doodle doodle-sun" stroke="#e2711d">
            <path pathLength={1} d="M86 100a34 34 0 1 0 68 0a34 34 0 1 0 -68 0" />
            <path
              pathLength={1}
              d="M166 100h16M152.5 132.5l11.3 11.3M120 146v16M87.5 132.5l-11.3 11.3M74 100h-16M87.5 67.5l-11.3-11.3M120 54v-16M152.5 67.5l11.3-11.3"
            />
          </g>
          <g className="doodle doodle-water" stroke="#2d7dd2">
            <path pathLength={1} d="M40 205q12.5-12 25 0t25 0t25 0t25 0t25 0t25 0t25 0t25 0t25 0t25 0t25 0t25 0t25 0t25 0t25 0t25 0" />
            <path pathLength={1} d="M70 235q12.5-12 25 0t25 0t25 0t25 0t25 0t25 0t25 0t25 0t25 0t25 0t25 0t25 0t25 0t25 0" />
          </g>
          <g className="doodle doodle-love" stroke="#e26d9e">
            <path
              pathLength={1}
              d="M370 132C345 114 332 98 336 82C340 66 360 64 370 80C380 64 400 66 404 82C408 98 395 114 370 132Z"
            />
          </g>
        </svg>
        <div className="on-paper absolute bottom-5 left-5 flex items-center gap-2 rounded-full bg-white/90 px-3 py-1.5 text-[13px] shadow-sm ring-1 ring-black/5">
          <span className="flex h-3.5 items-center gap-[2.5px] text-pencil" aria-hidden="true">
            {[0, 180, 90, 270].map((delay) => (
              <span
                key={delay}
                className="h-full w-[2.5px] origin-center animate-eq rounded-full bg-current"
                style={{ animationDelay: `${delay}ms` }}
              />
            ))}
          </span>
          <span className="relative h-5 w-[7.5rem]">
            <span className="hearing-sun absolute inset-0 opacity-0">hearing sunshine</span>
            <span className="hearing-water absolute inset-0 opacity-0">hearing water</span>
            <span className="hearing-love absolute inset-0 opacity-0">hearing love</span>
          </span>
        </div>
      </div>
    </div>
  );
}

export function Landing({
  onStart,
  returning,
  demo,
}: {
  /** Asks for a key first if there isn't one yet. */
  onStart: () => void;
  /** The shared demo key plays, so nobody needs one of their own. */
  demo: boolean;
  /** A session is already open behind this page. */
  returning: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex min-h-full max-w-6xl flex-col px-5 sm:px-8">
        <nav className="flex items-center justify-between py-5">
          <span className="flex items-center gap-3">
            <Wordmark />
            <span className="rounded-full bg-secondary px-2.5 py-0.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              experiment
            </span>
          </span>
          <a
            href={GITHUB}
            target="_blank"
            rel="noreferrer"
            className="rounded-full px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            GitHub
          </a>
        </nav>

        <section className="grid items-center gap-14 py-8 lg:grid-cols-[1.3fr_1fr] lg:py-14">
          <div className="min-w-0">
            <h1 className="font-display text-[clamp(2.75rem,6.2vw,4.9rem)] leading-[0.95] font-semibold tracking-[-0.04em] text-balance">
              Draw something. Hear it turn into{' '}
              <span className="bg-[linear-gradient(90deg,#e2711d,#e26d9e_55%,#7c3aed)] bg-clip-text text-transparent">
                music.
              </span>
            </h1>
            <p className="mt-6 max-w-[34rem] text-lg leading-relaxed text-muted-foreground">
              Every stroke rings in key. Lift the pen and skuzic reads your page, and the band
              follows: rain turns the room hazy, a sun opens it up. The song never stops. It bends.
            </p>

            <Button
              type="button"
              variant="default"
              className="mt-8 h-12 w-fit px-6 text-base [&_svg]:size-5"
              onClick={onStart}
            >
              {returning ? 'Back to drawing' : 'Start drawing'}
              <ArrowRight />
            </Button>
            <p className="mt-4 text-sm text-muted-foreground/80">
              {demo
                ? 'Best with headphones. Free, no sign-up.'
                : "Best with headphones. You'll connect a free Gemini key next. It stays in this browser."}
            </p>
          </div>

          <DemoSheet />
        </section>

        <section className="grid gap-3 py-10 sm:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-[1.6rem] bg-popover p-6 ring-1 ring-border">
              <span className="block size-3 rounded-full" style={{ backgroundColor: f.ink }} />
              <h2 className="mt-5 font-display text-xl font-semibold tracking-[-0.02em]">{f.title}</h2>
              <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </section>

        <section className="py-8">
          <h2 className="font-display text-xl font-semibold tracking-[-0.02em]">Under the hood</h2>
          <ol className="mt-4 flex flex-wrap items-center gap-2 text-sm">
            {FLOW.map((step, i) => (
              <li key={step} className="flex items-center gap-2">
                <span className="rounded-full bg-popover px-3.5 py-1.5 ring-1 ring-border">{step}</span>
                {i < FLOW.length - 1 && <ArrowRight className="size-4 text-muted-foreground" />}
              </li>
            ))}
          </ol>
          <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">
            The pen's own sound is made on your device, so it answers instantly. Want a deeper take?
            Tap Reimagine and Gemini rewrites the arrangement from your drawing.
          </p>
        </section>

        <footer className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-border py-6 text-sm text-muted-foreground">
          <p>
            An experiment by Aaditya Vaze. Your drawing only leaves this browser when you ask
            Gemini for help.
          </p>
          <span className="flex gap-4">
            <a href={GITHUB} target="_blank" rel="noreferrer" className="hover:text-foreground">
              Source
            </a>
            <a href={`${GITHUB}/blob/main/LICENSE.md`} target="_blank" rel="noreferrer" className="hover:text-foreground">
              MIT license
            </a>
          </span>
        </footer>
      </div>
    </div>
  );
}
