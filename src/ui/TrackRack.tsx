import { useState, type CSSProperties } from 'react';
import { Plus, Volume2, VolumeX, X } from 'lucide-react';

import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import type { Action, Track } from '../core/types';

interface Props {
  tracks: Track[];
  dispatch: (action: Action) => void;
  /** How many channels the engine takes; the add row says so when they're full. */
  maxTracks: number;
  /**
   * Display-only mode for auditioning an A/B candidate: edits to a mix that
   * isn't committed would desync what's heard from what gets recorded.
   */
  readOnly?: boolean;
}

/** OKLCH hues spread far enough apart that neighbouring channels never read as one colour. */
const HUES = [255, 25, 75, 150, 295, 350, 110, 200];

/** Ids are `t1`, `t2`… — key off the sequence so a channel keeps its colour when others go. */
function tint(id: string): CSSProperties {
  const h = HUES[(Number(id.replace(/\D/g, '')) || 0) % HUES.length];
  return {
    '--tint': `oklch(0.7 0.15 ${h})`,
    '--slider-range': `oklch(0.74 0.12 ${h})`,
    '--slider-track': `oklch(0.74 0.12 ${h} / 0.16)`,
    '--slider-thumb': 'oklch(0.99 0 0)',
  } as CSSProperties;
}

/** Visible on hover with a mouse, always on touch screens where nothing hovers. */
const REVEAL =
  'opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100';

export function TrackRack({ tracks, dispatch, maxTracks, readOnly = false }: Props) {
  const [draft, setDraft] = useState('');
  const full = tracks.length >= maxTracks;

  const add = () => {
    const prompt = draft.trim();
    if (!prompt || full) return;
    dispatch({
      type: 'ADD_TRACK',
      label: prompt.split(/\s+/).slice(0, 2).join(' '),
      prompt,
      volume: 0.5,
      origin: 'you',
    });
    setDraft('');
  };

  return (
    <div className="flex flex-col gap-1.5">
      {!tracks.length && (
        <p className="rounded-2xl bg-card px-4 py-4 text-[13px] text-muted-foreground">
          No sounds yet. Draw something, or add one below.
        </p>
      )}

      {tracks.map((track) => (
        <div
          key={track.id}
          style={tint(track.id)}
          className={cn('group rounded-2xl bg-card px-3 pt-2 pb-2.5', track.muted && 'opacity-50')}
        >
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-[var(--tint)]" />
            <span
              className="min-w-0 truncate text-[13px] font-medium"
              title={track.origin && `from “${track.origin}”`}
            >
              {track.label}
            </span>
            <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
              {track.muted ? 'off' : Math.round(track.volume * 100)}
            </span>
            <button
              type="button"
              disabled={readOnly}
              aria-pressed={!track.muted}
              aria-label={track.muted ? `Turn ${track.label} on` : `Turn ${track.label} off`}
              title={track.muted ? 'Turn on' : 'Turn off'}
              onClick={() => dispatch({ type: 'SET_MUTED', target: track.id, muted: !track.muted })}
              className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none"
            >
              {track.muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
            </button>
            {!readOnly && (
              <button
                type="button"
                aria-label={`Remove ${track.label}`}
                title="Remove"
                onClick={() => dispatch({ type: 'REMOVE_TRACK', target: track.id })}
                className={cn(
                  'grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60',
                  REVEAL,
                )}
              >
                <X className="size-4" />
              </button>
            )}
          </div>

          <input
            value={track.prompt}
            spellCheck={false}
            readOnly={readOnly}
            aria-label={`What ${track.label} plays`}
            title="Edit to change what this sound plays"
            className="mt-0.5 w-full truncate rounded-md bg-transparent text-[13px] text-muted-foreground outline-none hover:text-foreground focus:text-foreground"
            onChange={(e) =>
              dispatch({ type: 'MODIFY_TRACK', target: track.id, prompt: e.target.value })
            }
          />

          <Slider
            fat
            className="mt-1.5"
            disabled={readOnly}
            value={[track.volume * 100]}
            max={100}
            step={1}
            aria-label={`${track.label} volume`}
            onValueChange={([v]) => dispatch({ type: 'SET_VOLUME', target: track.id, volume: v / 100 })}
          />
        </div>
      ))}

      {!readOnly && (
        <form
          className="flex h-11 items-center gap-2 rounded-2xl border border-dashed border-border pr-1.5 pl-3 focus-within:border-solid focus-within:border-ring/50"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            value={draft}
            disabled={full}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={full ? `All ${maxTracks} channels in use` : 'Add a sound, like “warm cello”'}
            aria-label="Describe a sound to add"
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          />
          {draft.trim() && !full && (
            <button
              type="submit"
              className="h-8 shrink-0 rounded-full bg-primary px-3 text-[12px] font-medium text-primary-foreground outline-none hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              Add
            </button>
          )}
        </form>
      )}
    </div>
  );
}
