import { Scale } from '@google/genai';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import type { EngineCapabilities } from '../audio/engine';
import type { Action, MixConfig } from '../core/types';
import {
  PLANNER_CONFIGS,
  PLANNER_CONFIG_LIST,
  type PlannerConfigId,
} from '../llm/configs';
import { PLANNER_MODELS, type PlannerModel } from '../llm/planner';

interface Props {
  config: MixConfig;
  capabilities: EngineCapabilities;
  dispatch: (action: Action) => void;
  /** Keep a parent hover menu open while the scale select portal is active. */
  onSelectOpenChange?: (open: boolean) => void;
  autoInterpret: boolean;
  onAutoInterpretChange: (on: boolean) => void;
  abTest: boolean;
  onAbTestChange: (on: boolean) => void;
  /** Preference pairs saved so far — see src/lib/dataset.ts. */
  datasetCount: number;
  onExportDataset: () => void;
  plannerModel: PlannerModel;
  onPlannerModelChange: (model: PlannerModel) => void;
  plannerConfig: PlannerConfigId;
  onPlannerConfigChange: (config: PlannerConfigId) => void;
}

const SCALE_LABELS: Record<string, string> = {
  [Scale.SCALE_UNSPECIFIED]: 'auto',
  [Scale.C_MAJOR_A_MINOR]: 'C / Am',
  [Scale.D_FLAT_MAJOR_B_FLAT_MINOR]: 'D♭ / B♭m',
  [Scale.D_MAJOR_B_MINOR]: 'D / Bm',
  [Scale.E_FLAT_MAJOR_C_MINOR]: 'E♭ / Cm',
  [Scale.E_MAJOR_D_FLAT_MINOR]: 'E / D♭m',
  [Scale.F_MAJOR_D_MINOR]: 'F / Dm',
  [Scale.G_FLAT_MAJOR_E_FLAT_MINOR]: 'G♭ / E♭m',
  [Scale.G_MAJOR_E_MINOR]: 'G / Em',
  [Scale.A_FLAT_MAJOR_F_MINOR]: 'A♭ / Fm',
  [Scale.A_MAJOR_G_FLAT_MINOR]: 'A / G♭m',
  [Scale.B_FLAT_MAJOR_G_MINOR]: 'B♭ / Gm',
  [Scale.B_MAJOR_A_FLAT_MINOR]: 'B / A♭m',
};

function Knob({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (n: number) => string;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex justify-between text-[13px] text-muted-foreground">
        {label}
        <span className="text-foreground tabular-nums">
          {format ? format(value) : value.toFixed(2)}
        </span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        aria-label={label}
        onValueChange={([v]) => onChange(v)}
      />
    </div>
  );
}

export function ConfigPanel({
  config,
  capabilities,
  dispatch,
  onSelectOpenChange,
  autoInterpret,
  onAutoInterpretChange,
  abTest,
  onAbTestChange,
  datasetCount,
  onExportDataset,
  plannerModel,
  onPlannerModelChange,
  plannerConfig,
  onPlannerConfigChange,
}: Props) {
  const set = (patch: Partial<MixConfig>) => dispatch({ type: 'SET_CONFIG', config: patch });

  // Only render what the active backend actually conditions on — a knob that
  // silently does nothing is worse than no knob.
  return (
    <div className="flex flex-col gap-4">
      <Button
        size="sm"
        variant={autoInterpret ? 'secondary' : 'ghost'}
        aria-pressed={autoInterpret}
        className="justify-start"
        onClick={() => onAutoInterpretChange(!autoInterpret)}
      >
        auto interpret
      </Button>

      <div className="flex flex-col gap-1">
        <Button
          size="sm"
          variant={abTest ? 'secondary' : 'ghost'}
          aria-pressed={abTest}
          className="justify-start"
          onClick={() => onAbTestChange(!abTest)}
        >
          A/B test
        </Button>
        <div className="flex items-center justify-between pl-3 text-[12px] text-muted-foreground/70">
          <span>{datasetCount} choice{datasetCount === 1 ? '' : 's'} saved</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={!datasetCount}
            onClick={onExportDataset}
          >
            export
          </Button>
        </div>
      </div>

      {capabilities.bpm && (
        <Knob
          label="bpm"
          value={config.bpm}
          min={60}
          max={200}
          step={1}
          format={(n) => String(Math.round(n))}
          onChange={(bpm) => set({ bpm })}
        />
      )}
      {capabilities.density && (
        <Knob
          label="density"
          value={config.density}
          min={0}
          max={1}
          step={0.01}
          onChange={(density) => set({ density })}
        />
      )}
      {capabilities.brightness && (
        <Knob
          label="brightness"
          value={config.brightness}
          min={0}
          max={1}
          step={0.01}
          onChange={(brightness) => set({ brightness })}
        />
      )}
      {capabilities.guidance && (
        <Knob
          label="guidance"
          value={config.guidance}
          min={0}
          max={6}
          step={0.1}
          format={(n) => n.toFixed(1)}
          onChange={(guidance) => set({ guidance })}
        />
      )}

      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-[13px] text-muted-foreground">arranger</span>
        <Select
          value={plannerConfig}
          onValueChange={(v) => onPlannerConfigChange(v as PlannerConfigId)}
          onOpenChange={onSelectOpenChange}
        >
          <SelectTrigger aria-label="arranger strategy">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PLANNER_CONFIG_LIST.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[12px] leading-snug text-muted-foreground/70">
          {PLANNER_CONFIGS[plannerConfig].description}
        </p>
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-[13px] text-muted-foreground">planner model</span>
        <Select
          value={plannerModel}
          onValueChange={(v) => onPlannerModelChange(v as PlannerModel)}
          onOpenChange={onSelectOpenChange}
        >
          <SelectTrigger aria-label="planner model">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PLANNER_MODELS.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {capabilities.scale && (
        <div className="flex min-w-0 flex-col gap-2">
          <span className="text-[13px] text-muted-foreground">scale</span>
          <Select
            value={config.scale}
            onValueChange={(v) => set({ scale: v as Scale })}
            onOpenChange={onSelectOpenChange}
          >
            <SelectTrigger aria-label="scale">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.values(Scale).map((s) => (
                <SelectItem key={s} value={s}>
                  {SCALE_LABELS[s] ?? s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {(capabilities.muteBass || capabilities.muteDrums) && (
        <div className="flex flex-wrap gap-2">
          {capabilities.muteBass && (
            <Button
              size="sm"
              variant={config.muteBass ? 'secondary' : 'ghost'}
              onClick={() => set({ muteBass: !config.muteBass })}
            >
              no bass
            </Button>
          )}
          {capabilities.muteDrums && (
            <Button
              size="sm"
              variant={config.muteDrums ? 'secondary' : 'ghost'}
              onClick={() => set({ muteDrums: !config.muteDrums })}
            >
              no drums
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
