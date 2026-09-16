import { ChevronRight } from 'lucide-react';

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

/**
 * Each pass is read → reason → act, and only the last of those three is worth
 * a permanent line: it is what the mix actually did. The reasoning is the long
 * part and the timings are for debugging, so both live behind the disclosure.
 * `<details>` rather than state — the open/closed bit belongs to one row and
 * nothing else in the app reads it.
 */
function Row({ entry }: { entry: LogEntry }) {
  // An error has no plan to unfold; showing a twisty that reveals nothing is
  // worse than no twisty.
  if (entry.error) {
    return (
      <div className="rounded-2xl bg-card px-4 py-3">
        <div className="text-[13px] text-destructive">{entry.event}</div>
        <p className="mt-1 text-sm text-destructive">{entry.error}</p>
      </div>
    );
  }

  const detail = entry.reasoning || entry.timings;

  return (
    <details className="group rounded-2xl bg-card [&[open]]:pb-3">
      <summary
        className={cn(
          'flex list-none items-start gap-2 rounded-2xl px-4 py-3 outline-none',
          'transition-colors focus-visible:ring-2 focus-visible:ring-ring/60',
          detail ? 'cursor-pointer hover:bg-accent/40' : 'cursor-default',
        )}
      >
        <ChevronRight
          className={cn(
            'mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform',
            'group-open:rotate-90',
            !detail && 'invisible',
          )}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {entry.actions?.length ? (
            <div className="flex flex-wrap gap-1.5">
              {entry.actions.map((action, i) => (
                <Badge key={i}>{summarize(action)}</Badge>
              ))}
            </div>
          ) : (
            <span className="text-[13px] text-muted-foreground">no change</span>
          )}
          <span className="truncate text-[12px] text-muted-foreground/60">{entry.event}</span>
        </div>
      </summary>

      {detail && (
        <div className="pr-4 pl-[2.375rem]">
          {entry.reasoning && <p className="text-sm">{entry.reasoning}</p>}
          {entry.timings && (
            <div className="mt-2 font-mono text-[11px] text-muted-foreground/60">
              {summarizeTimings(entry.timings)}
            </div>
          )}
        </div>
      )}
    </details>
  );
}

export function ActionLog({ entries }: { entries: LogEntry[] }) {
  if (!entries.length) {
    return (
      <p className="rounded-2xl bg-card px-4 py-5 text-sm text-muted-foreground">
        Each pass the planner makes will appear here.
      </p>
    );
  }

  return (
    <div className="scrollbar-thin flex max-h-[28rem] flex-col gap-1 overflow-y-auto">
      {entries.map((entry) => (
        <Row key={entry.id} entry={entry} />
      ))}
    </div>
  );
}
