import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, Lock, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { checkGeminiKey } from '../audio/lyria';

const STUDIO = 'https://aistudio.google.com/apikey';
const SOURCE = 'https://github.com/thisisvaze/skuzic';

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex items-baseline gap-3">
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-secondary text-[12px] font-semibold">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}

/**
 * Asking for a key the way a trustworthy app would: why skuzic needs one, how
 * to get it, where it goes, and a check with Google before anything is saved.
 * A native modal, like Settings.
 */
export function KeyDialog({
  open,
  demo,
  onClose,
  onConnect,
}: {
  open: boolean;
  /** The shared demo key is playing; this key would replace it. */
  demo: boolean;
  onClose: () => void;
  /** Only ever called with a key Google accepted. */
  onConnect: (key: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [key, setKey] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog?.open) {
      setKey('');
      setError('');
      dialog?.showModal();
    }
    if (!open && dialog?.open) dialog.close();
  }, [open]);

  const connect = async () => {
    const trimmed = key.trim();
    if (!trimmed || checking) return;
    setChecking(true);
    setError('');
    const problem = await checkGeminiKey(trimmed);
    setChecking(false);
    // Closed while Google was answering: the artist changed their mind.
    if (!ref.current?.open) return;
    if (problem) setError(problem);
    else onConnect(trimmed);
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby="key-title"
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      className="m-auto w-[min(28rem,calc(100vw-1.5rem))] rounded-[1.75rem] bg-popover p-0 text-popover-foreground shadow-2xl ring-1 ring-border"
    >
      <div className="flex flex-col gap-5 px-6 pt-5 pb-6">
        <header className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2
              id="key-title"
              tabIndex={-1}
              autoFocus
              className="font-display text-xl font-semibold tracking-[-0.02em] outline-none"
            >
              {demo ? 'Use your own Gemini key' : 'Connect your Gemini key'}
            </h2>
            <p className="mt-1.5 text-[14px] leading-relaxed text-muted-foreground">
              {demo
                ? "Google's Lyria model plays the music. Everyone here shares skuzic's key, so it can get busy. A free key from your own Google account gives you your own quota."
                : "skuzic has no accounts. Google's Lyria model plays the music live, on a free key from your own Google account."}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <X className="size-4" />
          </button>
        </header>

        <ol className="flex flex-col gap-2.5 text-[14px]">
          <Step n={1}>
            Open{' '}
            <a
              href={STUDIO}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 font-medium underline underline-offset-2"
            >
              Google AI Studio
              <ArrowUpRight className="size-3.5" />
            </a>{' '}
            and sign in.
          </Step>
          <Step n={2}>Choose Create API key, then copy it.</Step>
          <Step n={3}>Paste it here.</Step>
        </ol>

        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void connect();
          }}
        >
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste your key"
            aria-label="Gemini API key"
            aria-invalid={!!error}
            aria-describedby={error ? 'key-error' : undefined}
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setError('');
            }}
          />
          {error && (
            <p id="key-error" role="alert" className="text-[13px] leading-snug text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" variant="default" className="h-11" disabled={!key.trim() || checking}>
            {checking ? 'Checking with Google…' : 'Connect'}
          </Button>
        </form>

        <p className="flex gap-2 text-[12px] leading-snug text-muted-foreground">
          <Lock className="mt-px size-3.5 shrink-0" />
          <span>
            Your key is saved only in this browser and only ever sent to Google. skuzic never sees
            it, and you can remove it in Settings any time. The code is{' '}
            <a href={SOURCE} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              open source
            </a>
            , so you can check.
          </span>
        </p>
      </div>
    </dialog>
  );
}
