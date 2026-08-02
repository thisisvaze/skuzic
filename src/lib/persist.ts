/**
 * Settings that should outlive a reload. The iOS build keeps the same set under
 * the same names in UserDefaults, so the two stay recognisably the same app.
 */

export const KEYS = {
  apiKey: 'skuzic_key',
  autoInterpret: 'skuzic_auto_interpret',
  abTest: 'skuzic_ab_test',
  plannerModel: 'skuzic_planner_model',
  plannerConfig: 'skuzic_planner_config',
  masterVolume: 'skuzic_master_volume',
  inkColor: 'skuzic_ink_color',
  // Versioned because `load` merges a stored record *over* the defaults, so a
  // saved config from an earlier build silently wins forever. The key, tempo
  // and guidance in INITIAL_CONFIG are the sound of the instrument, not a user
  // preference worth preserving through a retune — bump this when they change.
  config: 'skuzic_config_v2',
} as const;

/** Storage is unavailable in private mode and full quotas; never let it throw. */
export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw) as T;
    // A stored object from an older build may be missing newer keys, so merge
    // rather than replace — otherwise one added field resets the whole record.
    if (
      parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
      fallback && typeof fallback === 'object' && !Array.isArray(fallback)
    ) {
      return { ...fallback, ...parsed };
    }
    return parsed;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Out of quota or blocked; the setting simply will not persist.
  }
}
