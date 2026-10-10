export type DrawingShortcut =
  | { type: 'tool'; tool: 'pencil' | 'watercolor' | 'eraser' }
  | { type: 'size'; delta: number }
  | { type: 'opacity'; value: number }
  | { type: 'opacity-step'; delta: number }
  | { type: 'color' | 'help' | 'undo' | 'redo' };

type ShortcutKey = Pick<
  KeyboardEvent,
  'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'defaultPrevented'
>;

/** Resolve only drawing chords; leave browser commands and text composition alone. */
export function drawingShortcut(event: ShortcutKey): DrawingShortcut | null {
  if (event.defaultPrevented || event.isComposing || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (event.metaKey || event.ctrlKey) {
    if (key === 'z') return { type: event.shiftKey ? 'redo' : 'undo' };
    if (key === 'y' && event.ctrlKey && !event.metaKey && !event.shiftKey) return { type: 'redo' };
    return null;
  }

  if (key === '?') return { type: 'help' };
  if (['[', ']', '{', '}'].includes(key)) {
    const delta = key === '[' || key === '{' ? -1 : 1;
    return event.shiftKey ? { type: 'opacity-step', delta: delta * 0.1 } : { type: 'size', delta };
  }
  if (event.shiftKey) return null;
  if (/^[0-9]$/.test(key)) return { type: 'opacity', value: key === '0' ? 1 : Number(key) / 10 };
  if (key === 'p') return { type: 'tool', tool: 'pencil' };
  if (key === 'b') return { type: 'tool', tool: 'watercolor' };
  if (key === 'e') return { type: 'tool', tool: 'eraser' };
  if (key === 'c') return { type: 'color' };
  return null;
}
