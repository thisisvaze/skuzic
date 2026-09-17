import { Input } from '@/components/ui/input';

const STUDIO = 'https://aistudio.google.com/apikey';

/** Paste-your-own Gemini key. Stays in localStorage; never baked into the bundle. */
export function ApiKeyField({
  value,
  onChange,
  onCommit,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  onCommit?: (value: string) => void;
  className?: string;
}) {
  return (
    <div className={className}>
      <Input
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder="Gemini API key"
        aria-label="Gemini API key"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => onCommit?.(value)}
      />
      <a
        href={STUDIO}
        target="_blank"
        rel="noreferrer"
        className="mt-1.5 inline-block text-[12px] text-muted-foreground/70 underline-offset-2 hover:underline"
      >
        Get a key
      </a>
    </div>
  );
}
