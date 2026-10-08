import { Monitor, Moon, Sun } from 'lucide-react';
import type { Theme } from '@/ui/Settings';

const choices = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
] as const;

export function ThemeSwitcher({ value, onChange }: {
  value: Theme;
  onChange: (theme: Theme) => void;
}) {
  return (
    <div className="theme-switcher" role="group" aria-label="Appearance">
      {choices.map(({ value: choice, label, Icon }) => (
        <button
          key={choice}
          type="button"
          aria-label={`${label} appearance`}
          title={choice === 'system' ? 'Follow system appearance' : `${label} appearance`}
          aria-pressed={value === choice}
          onClick={() => onChange(choice)}
        >
          <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
