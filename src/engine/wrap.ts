// {{ #wrap=... }} line-breaking algorithms. Verbatim from the legacy engine.

// ----------------------------------------------------------------------------------------------
// TEMPLATE ENGINE -- word wrap ({{ #wrap=... }})
// ----------------------------------------------------------------------------------------------
// Break a single line into rows of no more than maxChars characters, splitting on spaces. Once maxWraps
// rows have been produced (maxWraps > 0), all remaining words are appended to the final row without
// further breaking. maxWraps <= 0 means unlimited rows.
export function breakLineIntoRows(line: string, maxChars: number, maxWraps: number): string[] {
  if (line.length <= maxChars) {
    return [line];
  }
  const words = line.split(' ');
  const rows: string[] = [];
  let current = '';
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    // If we've hit the row cap, dump this and all remaining words onto the last row.
    if (maxWraps > 0 && rows.length === maxWraps - 1) {
      const remaining = words.slice(i).join(' ');
      current = current === '' ? remaining : current + ' ' + remaining;
      break;
    }
    if (current === '') {
      current = word;
    } else if ((current + ' ' + word).length > maxChars) {
      rows.push(current);
      current = word;
    } else {
      current = current + ' ' + word;
    }
  }
  if (current !== '') {
    rows.push(current);
  }
  return rows;
}

// SOFT wrap helper: break a single line into fixed-width CHUNKS strictly on the nth character,
// ignoring word boundaries. No characters are removed or replaced; the caller joins the chunks with
// the delineator, so the delineator is effectively inserted after every maxChars characters. Once
// maxWraps chunks have been produced (maxWraps > 0), all remaining characters are appended to the
// final chunk without further breaking. maxWraps <= 0 means unlimited chunks.
export function breakLineIntoHardChunks(line: string, maxChars: number, maxWraps: number): string[] {
  if (line.length <= maxChars) {
    return [line];
  }
  const chunks: string[] = [];
  let pos = 0;
  while (pos < line.length) {
    // If we've hit the chunk cap, append everything remaining to the last chunk.
    if (maxWraps > 0 && chunks.length === maxWraps - 1) {
      chunks.push(line.slice(pos));
      break;
    }
    chunks.push(line.slice(pos, pos + maxChars));
    pos += maxChars;
  }
  return chunks;
}

// Wrap text so no row exceeds maxChars characters. maxWraps caps the number of rows (<= 0 = unlimited);
// once the cap is reached, remaining text is placed on the last row. minWraps sets a floor (<= 0 = none):
// if fewer than minWraps rows result, empty-string rows are appended until minWraps is reached.
// Rows are joined with delineator. When `hard` is true, breaking happens strictly on the nth character
// (ignoring word boundaries, preserving all characters); when false, breaking happens on spaces.
export function applyWordWrap(
  text: string,
  maxChars: number,
  minWraps: number,
  maxWraps: number,
  delineator: string,
  hard: boolean,
): string {
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    return text;
  }
  const inputLines = text.split('\n');
  const allRows: string[] = [];
  for (const line of inputLines) {
    const rows = hard
      ? breakLineIntoHardChunks(line, maxChars, maxWraps)
      : breakLineIntoRows(line, maxChars, maxWraps);
    for (const row of rows) {
      allRows.push(row);
    }
  }
  if (minWraps > 0) {
    while (allRows.length < minWraps) {
      allRows.push('');
    }
  }
  return allRows.join(delineator);
}

// Parse the wrap tag parameter string into maxChars, minWraps, maxWraps, and delineator.
// Format: `max_chars, min_wraps=N, max_wraps=N, delineator=STR`. The delineator value is captured as
// everything after the FIRST `delineator=` occurrence (so it may itself contain commas, e.g.
// `delineator=,`); only the portion before `delineator=` is split on commas to read the numeric params.
// The delineator is trimmed of genuinely typed leading/trailing whitespace (so padding you type is
// ignored -- "agnostic"); whitespace produced by the {{ \n }} / {{ \t }} tokens is carried as sentinels
// that are NOT whitespace, so it survives this trim at any position. A missing or empty delineator
// defaults to the empty string (no separator).
export function parseWrapParams(rawParams: string): {
  maxChars: number;
  minWraps: number;
  maxWraps: number;
  delineator: string;
  hard: boolean;
} {
  const raw = String(rawParams);
  // Split the delineator off first so its value can contain commas. The canonical tag order places
  // `hard=...` BEFORE `delineator=`, so `hard` lives entirely within the comma-split section that is
  // parsed below; the delineator value is everything after the first `delineator=` up to the closing
  // `}}`.
  const delineatorMatch = raw.match(/delineator\s*=/);
  let numericPart = raw;
  let delineator = '';
  if (delineatorMatch && delineatorMatch.index != null) {
    numericPart = raw.slice(0, delineatorMatch.index);
    const valueStart = delineatorMatch.index + delineatorMatch[0].length;
    // Trim typed whitespace only; sentinels (token-produced whitespace) are not whitespace and remain.
    delineator = raw.slice(valueStart).trim();
  }
  const segments = numericPart.split(',');
  const maxChars = parseInt((segments[0] || '').trim(), 10);
  let minWraps = 0;
  let maxWraps = 0;
  let hard = false;
  for (let i = 1; i < segments.length; i++) {
    const eqIndex = segments[i].indexOf('=');
    if (eqIndex === -1) continue;
    const key = segments[i].slice(0, eqIndex).trim();
    const rawVal = segments[i].slice(eqIndex + 1);
    // RESERVED KEYWORD: 'min_wraps', 'max_wraps', 'hard' -- must stay listed in
    // RESERVED_ASSIGNMENT_NAMES / RESERVED_KEYWORDS_IN_USE.
    if (key === 'min_wraps') {
      const parsed = parseInt(rawVal.trim(), 10);
      minWraps = Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
    } else if (key === 'max_wraps') {
      const parsed = parseInt(rawVal.trim(), 10);
      maxWraps = Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
    } else if (key === 'hard') {
      hard = rawVal.trim() === 'TRUE';
    }
  }
  return { maxChars, minWraps, maxWraps, delineator, hard };
}
