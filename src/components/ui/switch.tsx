import { cn } from '@/lib/utils';

/** On/off. "On" wears the brand gradient: it is always something the music is doing. */
function Switch({
  on,
  onChange,
  label,
  disabled,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn(
        'relative inline-flex h-6 w-10 shrink-0 items-center rounded-full outline-none transition-colors',
        'focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-40',
        on ? 'bg-brand' : 'bg-muted',
      )}
    >
      <span
        className={cn(
          'size-5 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.25)] transition-transform duration-200',
          on ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

export { Switch };
