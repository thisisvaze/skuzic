import { useEffect, useId, useState, type ReactNode } from 'react';
import { ChevronDown, Monitor, Moon, Sun, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { penVoice, type PenVoice } from '../audio/touch';
import type { Backend } from '../core/types';
import { KEYS, save } from '../lib/persist';
import { PLANNER_CONFIG_LIST, type PlannerConfigId } from '../llm/configs';
import { PLANNER_MODELS, type PlannerModel } from '../llm/planner';
import './settings.css';

export type Theme = 'system' | 'light' | 'dark';

const BRIDGE_HELP = 'https://github.com/thisisvaze/skuzic/blob/main/server/README.md';

const RESPONSE_HINTS: Record<PlannerConfigId, string> = {
  sparse: 'Start quiet. Add more sound as your drawing grows.',
  vibe1: 'Keep the music in tune with the whole scene.',
  realvibe: 'Make a fresh mix each time the drawing is read.',
  sounds: 'Turn the scene into sounds, like rain or birdsong.',
  continuity: 'Let new marks nudge the music along.',
};

interface Props {
  open: boolean;
  onClose: () => void;
  backend: Backend;
  onBackendChange: (backend: Backend) => void;
  apiKey: string;
  /** The hosted demo's shared key plays when the artist has none. */
  demo: boolean;
  /** Opens the key dialog, to connect a first key or swap it. */
  onConnectKey: () => void;
  onRemoveKey: () => void;
  plannerConfig: PlannerConfigId;
  onPlannerConfigChange: (config: PlannerConfigId) => void;
  plannerModel: PlannerModel;
  onPlannerModelChange: (model: PlannerModel) => void;
  abTest: boolean;
  onAbTestChange: (on: boolean) => void;
  /** Gemini refines the music every few seconds while the page changes. */
  follow: boolean;
  onFollowChange: (on: boolean) => void;
  /** Preference pairs saved so far — see src/lib/dataset.ts. */
  datasetCount: number;
  onExportDataset: () => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  connected: boolean;
  onDisconnect: () => void;
}


/** Native radios keep Tab and arrow-key navigation familiar. */
function Appearance({ value, onChange }: { value: Theme; onChange: (theme: Theme) => void }) {
  const name = useId();
  return (
    <fieldset className="settings-appearance">
      <legend>Appearance</legend>
      <div className="settings-segments">
        {([
          { id: 'system', label: 'System', Icon: Monitor },
          { id: 'light', label: 'Light', Icon: Sun },
          { id: 'dark', label: 'Dark', Icon: Moon },
        ] as const).map(({ id, label, Icon }) => (
          <label key={id}>
            <input type="radio" name={name} value={id} checked={value === id} onChange={() => onChange(id)} />
            <span><Icon size={15} aria-hidden="true" />{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** The shared Select, portalled inside the native dialog's focus boundary. */
function SettingSelect<T extends string>({ label, value, options, hint, onChange, container }: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  hint: string;
  onChange: (value: T) => void;
  container: HTMLDialogElement | null;
}) {
  const id = useId();
  return (
    <div className="settings-field">
      <label htmlFor={id}>{label}</label>
      <Select value={value} onValueChange={(next) => onChange(next as T)}>
        <SelectTrigger id={id} aria-describedby={`${id}-hint`} className="settings-select-trigger">
          <SelectValue />
        </SelectTrigger>
        <SelectContent
          container={container}
          collisionBoundary={container}
          collisionPadding={12}
          sideOffset={6}
          className="settings-select-content"
        >
          {options.map((option) => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}
        </SelectContent>
      </Select>
      <p id={`${id}-hint`} className="settings-hint">{hint}</p>
    </div>
  );
}

function Disclosure({ title, summary, children, open }: {
  title: string;
  summary: string;
  children: ReactNode;
  open?: boolean;
}) {
  return (
    <details className="settings-disclosure" open={open}>
      <summary>
        <span><span className="settings-label">{title}</span><span className="settings-hint">{summary}</span></span>
        <ChevronDown size={17} aria-hidden="true" />
      </summary>
      <div className="settings-disclosure-content">{children}</div>
    </details>
  );
}

/** Everyday choices first; connection and model details stay out of the way. */
export function Settings({
  open, onClose, backend, onBackendChange, apiKey, demo, onConnectKey, onRemoveKey,
  plannerConfig, onPlannerConfigChange, plannerModel, onPlannerModelChange,
  abTest, onAbTestChange, follow, onFollowChange, datasetCount, onExportDataset,
  theme, onThemeChange, connected, onDisconnect,
}: Props) {
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  // The pen reads this on every stroke, so it needs no wiring through the app.
  const [voice, setVoice] = useState(penVoice);
  const titleId = useId();
  useEffect(() => {
    if (open && !dialog?.open) dialog?.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open, dialog]);

  return (
    <dialog
      ref={setDialog}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      className="settings-dialog shadow-2xl"
    >
      <div className="settings-shell">
        <header className="settings-header">
          <h2 id={titleId} tabIndex={-1} autoFocus>Settings</h2>
          <button type="button" aria-label="Close settings" onClick={onClose} className="settings-close">
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="settings-body scrollbar-thin">
          <section className="settings-section" aria-label="Drawing and music">
            <div className="settings-row">
              <div>
                <h3>Follow my drawing</h3>
                <p className="settings-hint">Let the music pick up new details as you draw.</p>
              </div>
              <Switch on={follow} onChange={onFollowChange} label="Follow my drawing" />
            </div>
            {!follow && <p className="settings-hint">Automatic refinements are off. Use Reimagine whenever you like.</p>}
            <SettingSelect
              container={dialog}
              label="How the music changes"
              value={plannerConfig}
              options={PLANNER_CONFIG_LIST.map((c) => ({ id: c.id, label: c.label }))}
              hint={RESPONSE_HINTS[plannerConfig]}
              onChange={onPlannerConfigChange}
            />
            <SettingSelect<PenVoice>
              container={dialog}
              label="Brush sounds"
              value={voice}
              options={[{ id: 'brushes', label: 'Pluck and swell' }, { id: 'piano', label: 'Piano' }]}
              hint={voice === 'piano'
                ? 'Soft piano notes for every brush.'
                : 'The pencil plucks and the watercolor swells. Try both while you draw.'}
              onChange={(next) => {
                setVoice(next);
                save(KEYS.penVoice, next);
              }}
            />
          </section>

          <section className="settings-section">
            <Appearance value={theme} onChange={onThemeChange} />
          </section>

          <Disclosure
            title="Connection"
            summary={apiKey ? 'Using your Gemini key' : demo ? 'Using the skuzic demo' : 'Add a Gemini key to connect'}
            open={!apiKey && !demo ? true : undefined}
          >
            <div>
              <p className="settings-label">Gemini API key</p>
              <p className="settings-hint">For music and Reimagine. Your key is saved in this browser.</p>
            </div>
            {apiKey ? (
              <div className="settings-key">
                <span className="settings-hint">Key ending in <span className="settings-key-suffix">{apiKey.slice(-4)}</span></span>
                <div className="settings-actions">
                  <Button size="sm" variant="secondary" onClick={onConnectKey}>Change key</Button>
                  <Button size="sm" variant="ghost" onClick={onRemoveKey}>Remove key</Button>
                </div>
              </div>
            ) : (
              <div className="settings-key">
                {demo && <p className="settings-hint">The demo connection is shared. Add your own key if it gets busy.</p>}
                <Button size="sm" variant="secondary" onClick={onConnectKey}>Add your key</Button>
              </div>
            )}
            {connected && (
              <div className="settings-session">
                <p className="settings-hint">End the current music session.</p>
                <Button size="sm" variant="ghost" onClick={onDisconnect}>Stop music</Button>
              </div>
            )}
          </Disclosure>

          <Disclosure title="Advanced" summary="Models and experiments">
            <SettingSelect
              container={dialog}
              label="Music engine"
              value={backend}
              options={[{ id: 'lyria', label: 'Lyria RealTime' }, { id: 'magenta', label: 'Magenta RT' }]}
              hint={backend === 'lyria'
                ? 'Streams music from Google. Switching engines reconnects the music.'
                : 'Runs on your Mac with the local bridge. Switching engines reconnects the music.'}
              onChange={onBackendChange}
            />
            {backend === 'magenta' && <a className="settings-link" href={BRIDGE_HELP} target="_blank" rel="noreferrer">Set up the Magenta bridge ↗</a>}
            <SettingSelect
              container={dialog}
              label="Drawing model"
              value={plannerModel}
              options={PLANNER_MODELS.map((m) => ({ id: m.id, label: `${m.label} · ${m.detail}` }))}
              hint="Reads your picture for Follow my drawing and Reimagine."
              onChange={onPlannerModelChange}
            />
            <div className="settings-experiment">
              <div className="settings-row">
                <div>
                  <h3>Compare two mixes</h3>
                  <p className="settings-hint">Reimagine makes two versions. Pick your favorite.</p>
                </div>
                <Switch on={abTest} onChange={onAbTestChange} label="Compare two mixes" />
              </div>
              <div className="settings-export">
                <p className="settings-hint">
                  {datasetCount > 0 ? `${datasetCount} pick${datasetCount === 1 ? '' : 's'} saved in this browser.` : 'Your picks stay in this browser.'}
                </p>
                {datasetCount > 0 && <Button size="sm" variant="ghost" onClick={onExportDataset}>Export picks</Button>}
              </div>
            </div>
          </Disclosure>
        </div>

        <footer className="settings-footer">
          <p className="settings-hint">Changes save automatically.</p>
          <Button variant="default" onClick={onClose}>Done</Button>
        </footer>
      </div>
    </dialog>
  );
}
