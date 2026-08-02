import type { CSSProperties } from 'react';
import { X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import type { Action, Track } from '../core/types';

interface Props {
  tracks: Track[];
  dispatch: (action: Action) => void;
}

/** Hues spread far enough apart that adjacent tracks never read as the same colour. */
const HUES = [205, 15, 45, 145, 265, 320, 95, 180];

/** Ids are `t1`, `t2`… — key off the sequence so a track keeps its colour when others go. */
function tint(id: string): CSSProperties {
  const h = HUES[(Number(id.replace(/\D/g, '')) || 0) % HUES.length];
  return {
    '--tint': `hsl(${h} 72% 76%)`,
    '--slider-range': `hsl(${h} 72% 82%)`,
    '--slider-track': `hsl(${h} 32% 40%)`,
    '--slider-thumb': `hsl(${h} 55% 15%)`,
  } as CSSProperties;
}

export function TrackRack({ tracks, dispatch }: Props) {
  if (!tracks.length) {
    return (
      <p className="rounded-2xl bg-card px-4 py-5 text-sm text-muted-foreground">
        Draw something or fire an event to build the mix.
      </p>
    );
  }

  // The rack is a container, not a fixed column — the rows sit side-by-side when
  // there is room and stack when the Mix column is narrow.
  return (
    <div className="@container flex flex-col gap-1">
      {tracks.map((track) => (
        <div
          key={track.id}
          style={tint(track.id)}
          className={cn(
            'group flex flex-col gap-2 rounded-2xl bg-card px-4 py-3.5 transition-opacity',
            '@md:grid @md:grid-cols-[minmax(0,1fr)_44%] @md:items-center @md:gap-x-4 @md:gap-y-1',
            track.muted && 'opacity-40',
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="truncate font-semibold text-[var(--tint)]"
              title={track.origin && `from “${track.origin}”`}
            >
              {track.label}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${track.label}`}
              className="ml-auto shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 @md:hidden"
              onClick={() => dispatch({ type: 'REMOVE_TRACK', target: track.id })}
            >
              <X />
            </Button>
          </div>

          <input
            value={track.prompt}
            spellCheck={false}
            aria-label={`${track.label} prompt`}
            className="w-full truncate bg-transparent text-[13px] text-muted-foreground outline-none hover:text-foreground focus:text-foreground @md:col-start-1"
            onChange={(e) =>
              dispatch({ type: 'MODIFY_TRACK', target: track.id, prompt: e.target.value })
            }
          />

          <div className="flex items-center gap-2 @md:col-start-2 @md:row-span-2 @md:row-start-1">
            <Slider
              fat
              value={[track.volume * 100]}
              max={100}
              step={1}
              aria-label={`${track.label} volume`}
              title={String(Math.round(track.volume * 100))}
              onValueChange={([v]) =>
                dispatch({ type: 'SET_VOLUME', target: track.id, volume: v / 100 })
              }
            />
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              onClick={() =>
                dispatch({ type: 'SET_MUTED', target: track.id, muted: !track.muted })
              }
            >
              {track.muted ? 'muted' : 'live'}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${track.label}`}
              className="hidden shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 @md:block"
              onClick={() => dispatch({ type: 'REMOVE_TRACK', target: track.id })}
            >
              <X />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
