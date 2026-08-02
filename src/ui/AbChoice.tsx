import { X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { MixConfig, Track } from '../core/types';

export interface AbVariantView {
  reasoning: string;
  tracks: Track[];
  config: MixConfig;
}

interface Props {
  /** Display order — [0] is A, [1] is B. Deliberately unlabeled beyond that. */
  variants: AbVariantView[];
  /** Config both plans started from, to show only what each one moved. */
  baseConfig: MixConfig;
  /** Which variant the engine is currently playing. */
  audition: number;
  onAudition: (index: number) => void;
  onChoose: (index: number) => void;
  onDismiss: () => void;
}

/** Only the knobs a plan can audibly move without restarting generation. */
function configDelta(next: MixConfig, base: MixConfig): string[] {
  const chips: string[] = [];
  if (next.density !== base.density)
    chips.push(`density ${base.density.toFixed(2)} → ${next.density.toFixed(2)}`);
  if (next.brightness !== base.brightness)
    chips.push(`brightness ${base.brightness.toFixed(2)} → ${next.brightness.toFixed(2)}`);
  if (next.bpm !== base.bpm) chips.push(`bpm ${base.bpm} → ${next.bpm}`);
  return chips;
}

/**
 * Two candidate mixes for the same drawing, blind-labeled A and B. The engine
 * can only play one at a time, so comparison is sequential: listen to each,
 * keep one. Which strategy produced which stays hidden until after the choice
 * (it lands in the action log), so the ear decides rather than the label.
 */
export function AbChoice({ variants, baseConfig, audition, onAudition, onChoose, onDismiss }: Props) {
  return (
    <section>
      <div className="mb-2.5 flex items-center gap-2 text-[13px] text-muted-foreground">
        <h2>Which mix is better?</h2>
        <span className="text-muted-foreground/60">listen to both, keep one</span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="dismiss without choosing"
          className="ml-auto"
          onClick={onDismiss}
        >
          <X />
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {variants.map((variant, i) => {
          const playing = audition === i;
          const live = variant.tracks.filter((t) => !t.muted && t.volume > 0);
          return (
            <div
              key={i}
              className={cn(
                'flex flex-col gap-3 rounded-2xl bg-card p-4 transition-shadow',
                playing && 'ring-1 ring-live',
              )}
            >
              <div className="flex items-center gap-2">
                <span className="font-semibold">{i === 0 ? 'A' : 'B'}</span>
                {playing && <span className="text-[12px] text-live">playing</span>}
                <div className="flex-1" />
                <Button variant="ghost" size="sm" disabled={playing} onClick={() => onAudition(i)}>
                  listen
                </Button>
                <Button variant="secondary" size="sm" onClick={() => onChoose(i)}>
                  keep
                </Button>
              </div>

              <div className="flex flex-col gap-1.5">
                {live.map((track) => (
                  <div key={track.id} className="min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-medium">{track.label}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground/60 tabular-nums">
                        {Math.round(track.volume * 100)}
                      </span>
                    </div>
                    <p className="truncate text-[12px] text-muted-foreground" title={track.prompt}>
                      {track.prompt}
                    </p>
                  </div>
                ))}
              </div>

              {configDelta(variant.config, baseConfig).length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {configDelta(variant.config, baseConfig).map((chip) => (
                    <Badge key={chip}>{chip}</Badge>
                  ))}
                </div>
              )}

              {variant.reasoning && (
                <p className="text-[12px] leading-snug text-muted-foreground/70">
                  {variant.reasoning}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
