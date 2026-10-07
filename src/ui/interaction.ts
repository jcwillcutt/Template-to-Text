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

// A click delivered twice for one physical click (a real click plus the row's delegated click) arrives within a few
// milliseconds; a person cannot double-click that fast, so anything closer than this is the same click.
export const DUPLICATE_CLICK_MS = 30;

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
  if (last && last.id === id && now - last.at < DUPLICATE_CLICK_MS) {
    return { isDouble: false, next: last };
  }
  if (last && last.id === id && now - last.at <= windowMs) {
    // Consumed: a third rapid click starts a new pair rather than counting as another double.
    return { isDouble: true, next: null };
  }
  return { isDouble: false, next: { id, at: now } };
}
