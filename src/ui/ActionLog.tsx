import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { Action } from '../core/types';

export interface LogEntryTimings {
  /** generateContent round trip, ms. */
  request: number;
  /** Canvas downscale + JPEG encode, ms. */
  encode: number;
  imageBytes: number;
  /** Audio already queued when we steered, seconds — the floor on being heard. */
  buffer: number;
  promptTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
}

export interface LogEntry {
  id: number;
  event: string;
  reasoning?: string;
  actions?: Action[];
  error?: string;
  timings?: LogEntryTimings;
}

const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`);

function summarizeTimings(t: LogEntryTimings): string {
  const parts = [`plan ${ms(t.request)}`];
  if (t.imageBytes) parts.push(`img ${(t.imageBytes / 1024).toFixed(1)}KB ${ms(t.encode)}`);
  if (t.promptTokens != null) {
    const out = (t.outputTokens ?? 0) + (t.thoughtTokens ?? 0);
    parts.push(`${t.promptTokens}→${out} tok`);
  }
  // Listed last because it is the term that dominates time-to-hear.
  parts.push(`buffer ${t.buffer.toFixed(1)}s`);
  return parts.join(' · ');
}

function summarize(action: Action): string {
  switch (action.type) {
    case 'ADD_TRACK':
      return `+ ${action.label}`;
    case 'REMOVE_TRACK':
      return `− ${action.target}`;
    case 'MODIFY_TRACK':
      return `~ ${action.target}`;
    case 'SET_VOLUME':
      return `${action.target} → ${Math.round(action.volume * 100)}`;
    case 'SET_MUTED':
      return `${action.target} ${action.muted ? 'muted' : 'live'}`;
    case 'SET_CONFIG':
      return Object.entries(action.config)
        .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(2) : v}`)
        .join(' ');
    case 'SET_BACKEND':
      return `backend → ${action.backend}`;
    case 'CLEAR_TRACKS':
      return 'clear all';
    case 'RESET_CONTEXT':
      return 'reset';
  }
}

export function ActionLog({ entries }: { entries: LogEntry[] }) {
  if (!entries.length) {
    return (
      <p className="rounded-2xl bg-card px-4 py-5 text-sm text-muted-foreground">
        Actions the planner takes will appear here.
      </p>
    );
  }

  return (
    <div className="scrollbar-thin flex max-h-[28rem] flex-col gap-1 overflow-y-auto">
      {entries.map((entry) => (
        <div key={entry.id} className="rounded-2xl bg-card px-4 py-3">
          <div
            className={cn('text-[13px] text-muted-foreground', entry.error && 'text-destructive')}
          >
            {entry.event}
          </div>

          {entry.error ? (
            <p className="mt-1 text-sm text-destructive">{entry.error}</p>
          ) : (
            <>
              {entry.reasoning && <p className="mt-1 text-sm">{entry.reasoning}</p>}
              {!!entry.actions?.length && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {entry.actions.map((action, i) => (
                    <Badge key={i}>{summarize(action)}</Badge>
                  ))}
                </div>
              )}
            </>
          )}

          {entry.timings && (
            <div className="mt-2 font-mono text-[11px] text-muted-foreground/60">
              {summarizeTimings(entry.timings)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
