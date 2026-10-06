import { useId, type ReactNode } from 'react';

import { cn } from '@/lib/utils';
import type { Vibe } from '../vision/eyes';

/**
 * Each vibe's little picture: a soft gradient and a few strokes in the same
 * hand as the pen. Plain SVG, so it's crisp at any size and themes nothing.
 */
const ART: Record<string, { from: string; to: string; draw: ReactNode }> = {
  blank: {
    from: '#fbfaf6',
    to: '#ebe8df',
    draw: (
      <path
        d="M22 40c6-14 12-14 18 0s12 14 18 0 12-14 18 0 12 14 18 0"
        stroke="#3a3934"
        strokeWidth="3.2"
      />
    ),
  },
  lofi: {
    from: '#fae6cc',
    to: '#efcdab',
    draw: (
      <>
        <circle cx="94" cy="17" r="6" fill="#fff6e3" />
        <path
          d="M44 30h28v14a12 12 0 0 1-12 12h-4a12 12 0 0 1-12-12z"
          fill="#fffaf2"
          stroke="#7a4b2a"
          strokeWidth="3"
        />
        <path d="M72 34h3a6 6 0 0 1 0 12h-3" stroke="#7a4b2a" strokeWidth="3" />
        <path
          d="M52 23c-3-4 3-6 0-10M60 23c-3-4 3-6 0-10M68 23c-3-4 3-6 0-10"
          stroke="#b07d55"
          strokeWidth="2.4"
        />
        <path d="M38 61h40" stroke="#7a4b2a" strokeWidth="3" />
      </>
    ),
  },
  ambient: {
    from: '#e9e5fb',
    to: '#d3eaf8',
    draw: (
      <>
        <circle cx="50" cy="38" r="17" fill="#a78bfa" opacity="0.45" />
        <circle cx="68" cy="31" r="19" fill="#7dd3fc" opacity="0.5" />
        <circle cx="77" cy="46" r="14" fill="#f9a8d4" opacity="0.45" />
        {[
          [20, 15],
          [30, 26],
          [101, 16],
          [94, 60],
          [16, 56],
        ].map(([x, y]) => (
          <circle key={x} cx={x} cy={y} r="1.6" fill="#ffffff" />
        ))}
      </>
    ),
  },
  piano: {
    from: '#f7f4ed',
    to: '#e6e2d8',
    draw: (
      <>
        <rect x="22" y="19" width="76" height="35" rx="5" fill="#fffdf8" stroke="#2b2a27" strokeWidth="2.6" />
        <path d="M34.7 19v35M47.3 19v35M60 19v35M72.7 19v35M85.3 19v35" stroke="#2b2a27" strokeWidth="1.5" />
        {[34.7, 47.3, 72.7, 85.3].map((x) => (
          <rect key={x} x={x - 3.6} y="19" width="7.2" height="20" rx="1.6" fill="#2b2a27" />
        ))}
      </>
    ),
  },
  folk: {
    from: '#e8f1dc',
    to: '#f9e6ca',
    draw: (
      <>
        <circle cx="88" cy="21" r="8" fill="#f2b33d" />
        <path d="M0 55c18-15 36-15 54-4s36 9 66-8v29H0z" fill="#a9cf95" />
        <path d="M0 63c24-10 44-10 64-2s38 5 56-4v15H0z" fill="#6a994e" />
        <path d="M30 51v-9" stroke="#6b4423" strokeWidth="2.6" />
        <circle cx="30" cy="37" r="6.5" fill="#4f7d3a" />
      </>
    ),
  },
  bossa: {
    from: '#fdf0cc',
    to: '#d3efe9',
    draw: (
      <>
        <circle cx="86" cy="47" r="12" fill="#f6b73c" />
        <rect x="0" y="47" width="120" height="25" fill="#93d8cc" />
        <path
          d="M6 56q6-4 12 0t12 0t12 0t12 0t12 0t12 0t12 0t12 0t12 0"
          stroke="#1b998b"
          strokeWidth="2.2"
        />
        <path d="M38 62c2-12 1-23-4-34" stroke="#8b5a2b" strokeWidth="3" />
        <path
          d="M34 28c-9-5-17-3-21 3M34 28c9-6 18-4 22 2M34 28c-5-8-12-10-18-8M34 28c5-8 12-10 18-8"
          stroke="#2f9e6e"
          strokeWidth="3"
        />
      </>
    ),
  },
  jazz: {
    from: '#2c2956',
    to: '#4b3a6c',
    draw: (
      <>
        <circle cx="92" cy="17" r="7" fill="#f6d77a" />
        {[
          [20, 12],
          [44, 20],
          [70, 10],
          [108, 30],
        ].map(([x, y]) => (
          <circle key={x} cx={x} cy={y} r="1.3" fill="#f6d77a" opacity="0.8" />
        ))}
        <path
          d="M8 72V44h12v-8h12v36zM34 72V40h14v32zM50 72V48h12v24zM64 72V34h16v38zM82 72V46h12v26zM96 72V40h16v32z"
          fill="#1b1838"
        />
        {[
          [12, 50],
          [26, 42],
          [40, 46],
          [68, 40],
          [74, 52],
          [100, 46],
          [86, 54],
        ].map(([x, y]) => (
          <rect key={`${x}-${y}`} x={x} y={y} width="3" height="3.4" rx="0.6" fill="#f6d77a" opacity="0.85" />
        ))}
      </>
    ),
  },
  strings: {
    from: '#f9e4e7',
    to: '#ecdbf1',
    draw: (
      <>
        {[0, 1, 2, 3].map((i) => (
          <path
            key={i}
            d={`M10 ${46 + i * 5}C40 ${24 + i * 5} 76 ${22 + i * 5} 110 ${36 + i * 5}`}
            stroke="#9d2f4a"
            strokeWidth="1.8"
            opacity="0.8"
          />
        ))}
        <path d="M24 16l72 38" stroke="#6b3a2a" strokeWidth="2.6" />
        <path d="M24 16l-1.5 6" stroke="#6b3a2a" strokeWidth="2.6" />
      </>
    ),
  },
};

/** For a vibe someone adds to palette.json before drawing it a picture. */
const FALLBACK = ART.blank;

function Card({ vibe, on, onPick }: { vibe: Vibe; on: boolean; onPick: (vibe: Vibe) => void }) {
  const art = ART[vibe.id] ?? FALLBACK;
  // Two pickers can be on screen at once, so gradient ids must be unique.
  const id = `vibe-${useId().replace(/[^\w-]/g, '')}`;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      title={vibe.blurb}
      onClick={() => onPick(vibe)}
      className={cn(
        'group flex min-w-0 flex-col overflow-hidden rounded-xl bg-popover text-left text-foreground shadow-sm outline-none',
        'transition-shadow duration-200 focus-visible:ring-2 focus-visible:ring-ring/60',
        // Quiet on purpose: a hover darkens the edge, the chosen one gets a thin
        // violet edge and a dot. No lift, which the scrolling strip would clip.
        on ? 'ring-[1.5px] ring-brand-3/60' : 'ring-1 ring-border hover:ring-foreground/20',
      )}
    >
      <svg
        viewBox="0 0 120 72"
        preserveAspectRatio="xMidYMid slice"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="aspect-[2/1] w-full"
      >
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={art.from} />
            <stop offset="1" stopColor={art.to} />
          </linearGradient>
        </defs>
        <rect width="120" height="72" fill={`url(#${id})`} />
        {art.draw}
      </svg>
      <span className="flex items-center gap-1.5 truncate px-2.5 py-1.5 text-[12px] font-medium">
        {vibe.name}
        {on && <span aria-hidden="true" className="ml-auto size-1.5 shrink-0 rounded-full bg-brand-3" />}
      </span>
    </button>
  );
}

export function VibePicker({
  vibes,
  current,
  onPick,
  layout = 'grid',
}: {
  vibes: Vibe[];
  current: string;
  onPick: (vibe: Vibe) => void;
  /** A grid for the mixer; a single row (scrolling on phones) for the page. */
  layout?: 'grid' | 'strip';
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Starting vibe"
      className={cn(
        layout === 'grid'
          ? 'grid grid-cols-2 gap-2'
          : 'flex snap-x gap-2 overflow-x-auto p-1 [scrollbar-width:none] *:w-[6.5rem] *:shrink-0 *:snap-start sm:*:w-auto sm:*:flex-1',
      )}
    >
      {vibes.map((v) => (
        <Card key={v.id} vibe={v} on={v.id === current} onPick={onPick} />
      ))}
    </div>
  );
}

/** The blank page's invitation, kept to the bottom edge: start from a vibe, or just draw. */
export function VibeStart({
  hint,
  ...props
}: {
  vibes: Vibe[];
  current: string;
  onPick: (vibe: Vibe) => void;
  /** What's happening right now, in place of the invitation. */
  hint?: string;
}) {
  return (
    <div className="on-paper pointer-events-auto w-full max-w-4xl rounded-[1.4rem] bg-white/75 p-2 shadow-[0_8px_30px_-14px_rgb(0_0_0/0.25)] ring-1 ring-black/[0.06] backdrop-blur-md">
      <p className="px-1.5 pt-0.5 pb-2 text-[12px] font-medium text-pencil/55">
        {hint ?? 'Start with a vibe, or just draw'}
      </p>
      <VibePicker {...props} layout="strip" />
    </div>
  );
}
