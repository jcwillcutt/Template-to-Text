// Pure interaction helpers for the extension UI (no Shopify / DOM dependencies, so they are unit-tested).

// The `{{ insert }}` placeholder the editors' Insert menus replace. A fresh regex per call: a shared /g regex
// keeps `lastIndex` between `.test()` calls, which made every second insert miss the placeholder.
export const INSERT_PLACEHOLDER_TEXT = '{{ insert }}';

// Insert a token into editor text: every `{{ insert }}` placeholder is replaced by the token; with no
// placeholder the token is appended to the end.
export function insertIntoText(prev: string, token: string): string {
  const placeholder = /\{\{\s*insert\s*\}\}/g;
  if (placeholder.test(prev)) {
    return prev.replace(/\{\{\s*insert\s*\}\}/g, () => token);
  }
  return prev.length > 0 ? prev + token : token;
}

// Two clicks on the same row within DOUBLE_CLICK_MS count as a double click. Tracked by the caller in a ref so
// the first click's timestamp is visible to the second even if the re-render caused by the first has not yet
// flushed (a state-based tracker would miss rapid double clicks).
export const DOUBLE_CLICK_MS = 400;

export interface ClickRecord {
  id: string;
  at: number;
}

export function registerClick(
  last: ClickRecord | null,
  id: string,
  now: number,
  windowMs: number = DOUBLE_CLICK_MS,
): { isDouble: boolean; next: ClickRecord | null } {
  if (last && last.id === id && now - last.at <= windowMs) {
    // Consumed: a third rapid click starts a new pair rather than counting as another double.
    return { isDouble: true, next: null };
  }
  return { isDouble: false, next: { id, at: now } };
}

// Clicks that began on an interactive control inside a row (a link, a checkbox, a text field, a menu button...)
// belong to that control, not to the row. `target` is the click's event.target; works on any object exposing
// `closest`.
export const INTERACTIVE_SELECTOR =
  's-link, s-button, s-checkbox, s-text-field, s-text-area, s-search-field, s-menu, s-select, a, button, input, textarea, select, label';

export function isInteractiveTarget(target: unknown, selector: string = INTERACTIVE_SELECTOR): boolean {
  const el = target as { closest?: (s: string) => unknown } | null;
  return Boolean(el && typeof el.closest === 'function' && el.closest(selector));
}
