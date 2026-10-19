// Pure string transforms behind the text-tool blocks. Verbatim from the legacy engine.

// Return the single character at 0-based position `index` of the rendered inner content. A negative
// index counts back from the end (-1 is the last character). A non-integer or out-of-range index
// renders the empty string.
export function applyIndex(innerRendered: string, index: number | null): string {
  if (index == null || !Number.isInteger(index)) {
    return '';
  }
  const chars = Array.from(innerRendered);
  const position = index < 0 ? chars.length + index : index;
  if (position < 0 || position >= chars.length) {
    return '';
  }
  return chars[position];
}

// Output the rendered inner content `count` times joined by the delineator. A count that is missing,
// non-integer, or less than 1 renders nothing; a count of exactly 1 returns the content unchanged.
export function applyRepeat(innerRendered: string, count: number | null, delineator: string): string {
  if (count == null || !Number.isInteger(count) || count < 1) {
    return '';
  }
  if (count === 1) {
    return innerRendered;
  }
  const copies: string[] = [];
  for (let n = 0; n < count; n++) {
    copies.push(innerRendered);
  }
  return copies.join(delineator);
}

// Substitute every non-overlapping occurrence of `search` in `text` with `replacement`, scanning
// left to right -- the same semantics as String.prototype.split(search).join(replacement) (a LITERAL
// substring match, never a regex). An empty `search` is a deliberate no-op (returns `text`
// unchanged) rather than splitting on every character, which is what `text.split('')` would
// otherwise do -- an empty SEARCH has no meaningful "occurrence" to replace.
export function applyReplace(text: string, search: string, replacement: string): string {
  if (search === '') return text;
  return text.split(search).join(replacement);
}

// Splice `inner` into the surrounding rendered output. For a position >= 0 the split point is N
// characters INTO the text that follows the block; for a negative position it is |N| characters back
// from the end of the text that precedes the block. An out-of-range position is dropped when
// `drop` is true and clamped to the end / start otherwise. A missing or non-integer position drops
// the inner content.
export function applyInsert(
  before: string,
  after: string,
  inner: string,
  position: number | null,
  drop: boolean,
): string {
  if (position == null || !Number.isInteger(position)) {
    return before + after;
  }
  const afterChars = Array.from(after);
  if (position >= 0) {
    if (position > afterChars.length) {
      return drop ? before + after : before + after + inner;
    }
    return (
      before + afterChars.slice(0, position).join('') + inner + afterChars.slice(position).join('')
    );
  }
  const beforeChars = Array.from(before);
  const splitAt = beforeChars.length + position;
  if (splitAt < 0) {
    return drop ? before + after : inner + before + after;
  }
  return (
    beforeChars.slice(0, splitAt).join('') + inner + beforeChars.slice(splitAt).join('') + after
  );
}
