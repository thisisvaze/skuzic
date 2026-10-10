import { cn } from '@/lib/utils';

/** The skuzic mark, a bold scribble running into three bars, in the shared orange, pink and violet ink. */
export function SkuzicLogo({
  compact = false,
  className,
}: {
  /** Keep the mark visible and hide the name on small studio headers. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label="skuzic"
      className={cn('inline-flex shrink-0 items-center gap-2.5', className)}
    >
      <img
        src="/brand/skuzic-mark.svg"
        width="38"
        height="28"
        alt=""
        aria-hidden="true"
        draggable={false}
        className="h-7 w-[2.377rem] shrink-0"
      />
      <span
        aria-hidden="true"
        className={cn('font-display text-[1.25rem] leading-none font-bold tracking-[0.01em]', compact && 'hidden sm:inline')}
      >
        skuzic
      </span>
    </span>
  );
}
