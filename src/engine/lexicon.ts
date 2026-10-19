// Reserved words, identifier grammar, whitespace/comment/global pre-passes. Verbatim from the legacy engine.

import { deprecatedSyntaxMarker, globalUndefinedMarker } from './markers';

// ----------------------------------------------------------------------------------------------
// TEMPLATE ENGINE -- token scanning primitives (brace-depth-aware parsing)
// Small hand-rolled scanners (topLevelEqualsIndex, topLevelLessThanIndex, hasBooleanOperator, and
// renderTokenContent/renderTemplateText, the single left-to-right token scanner every render pass
// goes through) that all share the same "count {{ / }} depth while scanning" shape as the block
// finders and findMatchingClose below -- see architecture-notes.md for the dedup opportunity.
// ----------------------------------------------------------------------------------------------
// Tag keywords that may never be used as a variable name, so tokens such as `{{ length=... }}` keep
// their own meaning instead of being read as an assignment.
//
// THIS LIST IS HAND-MAINTAINED and is NOT derived from the individual block-tag regexes
// (CHOP_OPEN_SOURCE, REPEAT_OPEN_SOURCE, LENGTH_PREFIX_REGEX, the parameter-name checks inside
// parseChopParams/parseWrapParams/etc., ...) scattered through the rest of this file -- adding a new
// block type or tag parameter there and forgetting to add its keyword HERE means that keyword would
// silently be readable/writable as a plain variable (`{{ myNewKeyword = 5 }}`) instead of being
// recognized as the new tag. Every site below that introduces a new reserved keyword is marked with
// a `// RESERVED KEYWORD:` comment as a reminder; RESERVED_KEYWORDS_IN_USE right below cross-checks
// against those sites at module load, so a forgotten entry fails loudly (a thrown error) instead of
// silently. Fully deriving this set from the regex sources themselves was considered and rejected as
// riskier than it's worth: the sources have inconsistent shapes (`while=` has no leading `#`; `else`
// and the parameter names have no dedicated regex constant at all, just inline literals), so an
// automated extractor would itself be a second thing that could quietly drift or break.
export const RESERVED_ASSIGNMENT_NAMES = new Set([
  'length',
  'while',
  'insert',
  'if',
  'else',
  'comment',
  'wrap',
  'repeat',
  'index',
  'chop',
  'trim',
  'delineator',
  'direction',
  'drop',
  'tied',
  'hard',
  'min_wraps',
  'max_wraps',
  'skip_first',
  'skip_last',
  // Added session 6, with the loop redesign:
  'break',
  'skip',
  'tag',
  // Added session 9, with the {{ time=FORMAT }} token:
  'time',
  // Added session 13, with the {{ #replace=... }} block:
  'replace',
  'replacement',
]);

// Cross-check list for the reminder above: every keyword actually introduced by a
// `// RESERVED KEYWORD:` comment elsewhere in this file, kept immediately next to
// RESERVED_ASSIGNMENT_NAMES so the two are as hard as possible to edit out of sync. Throws
// immediately at module load if the two ever disagree, rather than failing silently at render time.
export const RESERVED_KEYWORDS_IN_USE = [
  'length',
  'while',
  'insert',
  'if',
  'else',
  'comment',
  'wrap',
  'repeat',
  'index',
  'chop',
  'trim',
  'delineator',
  'direction',
  'drop',
  'tied',
  'hard',
  'min_wraps',
  'max_wraps',
  'skip_first',
  'skip_last',
  'break',
  'skip',
  'tag',
  'time',
  'replace',
  'replacement',
];

// A variable/counter name is NOT restricted to a conventional identifier shape (letters/digits/
// underscore, no leading digit) -- it can be any non-empty run of non-whitespace characters, as
// long as it (a) isn't a protected tag keyword (RESERVED_ASSIGNMENT_NAMES above) and (b) doesn't
// contain any character that is itself structurally meaningful inside a token, which would make the
// name ambiguous with the surrounding grammar:
//   {  }        block delimiters
//   .           field-path separator (`product.title`, `day.week`, ...)
//   =           assignment / comparison
//   < > ! & |   comparison and boolean operators
//   ,           tag-parameter separator
//   ( )         boolean-expression grouping
// Anything else -- letters, digits, punctuation like `-`, `'`, `?`, non-ASCII characters, a name
// that starts with a digit, etc. -- is a valid variable name.
// None of `{ } . = < > ! & | , ( )` need escaping inside a `[...]` character class.
export const IDENTIFIER_REGEX = /^[^\s{}.=<>!&|,()]+$/;

export const ASSIGNMENT_REGEX = /^([^\s{}.=<>!&|,()]+)\s*=(?!=)/;

// RESERVED KEYWORD: 'length' -- must stay listed in RESERVED_ASSIGNMENT_NAMES / RESERVED_KEYWORDS_IN_USE.
export const LENGTH_PREFIX_REGEX = /^length\s*=/;

// RESERVED KEYWORD: 'time' -- must stay listed in RESERVED_ASSIGNMENT_NAMES / RESERVED_KEYWORDS_IN_USE.
export const TIME_PREFIX_REGEX = /^time\s*=/;

// Whether a tag parameter key names a VARIABLE (a loop counter) rather than one of the fixed tag
// options such as `tied`, `direction`, or `skip_first`.
export function isVariableName(key: string): boolean {
  return IDENTIFIER_REGEX.test(key) && !RESERVED_ASSIGNMENT_NAMES.has(key.toLowerCase());
}

// Remove every {{ #comment }} ... {{ /comment }} block (tags and inner content, across newlines) so
// comments never appear in generated output. Applied as the FIRST evaluation step. Uses a global,
// non-greedy regex so multiple comment blocks are all removed and an unclosed opening tag is left inert.
// RESERVED KEYWORD: 'comment' -- must stay listed in RESERVED_ASSIGNMENT_NAMES / RESERVED_KEYWORDS_IN_USE.
export const COMMENT_REGEX = /\{\{\s*#comment\s*\}\}[\s\S]*?\{\{\s*\/comment\s*\}\}/g;

export function stripComments(body: string): string {
  return body.replace(COMMENT_REGEX, '');
}

// Session 26: whether a template body references ANY per-object data -- a product/variant field, a
// note (including the direct `selection.curr/next/prev/first/last.note` form -- session 24), or a
// foreach loop that steps through variants/tags/metafields/notes/the selection. Used to decide
// whether a 'selection'-fileBreak template may be downloaded/previewed with an EMPTY selection (see
// canDownload/canPreview) -- fileBreak alone is not a sufficient check: several of these tokens
// (selection.first/last/curr especially) don't just render blank against zero objects the way an
// ordinary `{{ product.FIELD }}` token already does when used INSIDE a real per-object render --
// they throw outright, because with zero products `first`/`rows[0]` is `undefined`, and
// resolveSelectionNeighborField/resolveOnProduct dereference a field directly off whatever row
// they're handed, with no "missing row" fallback (unlike the ordinary product/variant dispatch,
// which is only ever reached against a REAL object in every other code path).
// A plain substring scan over the (comment-stripped) body, deliberately simple rather than a full
// token-aware parse: it can't tell a real `{{ }}` token from the same words in ordinary prose (a
// sentence ending "...our product." would also match), so a false POSITIVE is possible. That costs
// the merchant nothing beyond needing to select at least one product -- the exact behavior every
// template already had before this session -- so erring conservative here is the safe direction.
export const SELECTION_OBJECT_REFERENCE_MARKERS = [
  'product.',
  'products.',
  'variant.',
  'variants.',
  'mf.',
  'notes.foreach',
  'selection.foreach',
  'tags.foreach',
  'metafields.foreach',
  'selection.first',
  'selection.last',
  'selection.curr',
  'selection.next',
  'selection.prev',
];

export function templateNeedsSelectionObjects(body: string): boolean {
  const stripped = stripComments(body);
  return SELECTION_OBJECT_REFERENCE_MARKERS.some((marker) => stripped.includes(marker));
}

// --- Global variables (session 23) --------------------------------------------------------------
// `{{ $global:NAME }}` reads a shop-wide variable defined on its own Settings page (see
// GlobalVarEntry/renderGlobalVarsView), never inside a template -- see roadmap.md item 22 for the
// full design discussion. `:` is not in IDENTIFIER_REGEX/ASSIGNMENT_REGEX's excluded-character set,
// so `$global:NAME` is already a syntactically ordinary identifier shape to the rest of this file;
// no grammar change was needed to recognize it, only the splice/guard code below.
export const GLOBAL_PREFIX = '$global:';

// Matches a BARE global-variable read -- the whole token is exactly `{{ $global:NAME }}`, nothing
// else inside the braces. An assignment attempt (`{{ $global:NAME = VALUE }}`) has extra content
// after NAME and deliberately does NOT match this, so it falls through untouched to
// renderTokenContent's own assignment branch, which is where the read-only rejection is enforced
// (see the guard added there) -- splicing only ever needs to handle the read direction.
// A REAL regex literal (not a string concatenation): see IF_OPEN_SOURCE's own long comment further
// down for exactly why a plain string of `\{\{\s*...` is NOT safe here (a JS string literal silently
// drops the backslash before `\s`, turning it into a literal lowercase "s") -- this file was bitten
// by that exact bug once already (session 6) and every tag pattern since has used a real regex.
export const GLOBAL_READ_REGEX = /\{\{\s*\$global:([^\s{}.=<>!&|,()]+)\s*\}\}/g;

// Textually splice every bare `{{ $global:NAME }}` reference in a template's OUTER body with that
// global's own (already comment-stripped -- see globalBodiesByTitle's own comment) text, or a
// visible marker when NAME isn't a defined global. Runs ONCE, right after the outer body's own
// stripComments (so a global reference sitting inside a `{{ #comment }}` block is already gone by
// the time this runs, and a global's own spliced-in text is never itself raw, un-stripped comment
// markup) and BEFORE every other pass (`applyWhitespaceTokens` has already run; `flattenForeachInsideWhile`,
// foreach expansion, and `renderTokens` all run AFTER) -- so a spliced-in global's body is evaluated
// completely normally, in the same left-to-right document-order pass as everything else in the file.
// This is what makes a global reference see the OUTER file's own local variables (e.g. `x`) at their
// CURRENT value at that exact point in the file's own document order, per the clarifying example in
// roadmap.md item 22 -- pre-evaluating a global once, up front, could not do that.
//
// `String.prototype.replace` with a global regex scans the ORIGINAL string in one pass; it does not
// re-scan text just inserted by an earlier replacement. That is what enforces roadmap.md item 22's
// "no global-to-global references" scope limit for free: if a global's own body itself contains
// `{{ $global:other }}`, that text is spliced in here VERBATIM (never expanded), and is left for
// resolveOnProduct's own fallback (see its "not expanded" check) to render as a visible marker
// instead of silently resolving to '' once the normal token pipeline reaches it. It also means a
// global that (accidentally or not) references itself can never recurse -- there is no cycle to
// guard against.
export function spliceGlobalVariables(body: string, globalBodiesByTitle: Record<string, string>): string {
  return body.replace(GLOBAL_READ_REGEX, (_match: string, name: string) =>
    Object.prototype.hasOwnProperty.call(globalBodiesByTitle, name)
      ? globalBodiesByTitle[name]
      : globalUndefinedMarker(name),
  );
}

// Whitespace tokens: `{{ /return }}` resolves to a real newline and `{{ /space }}` resolves to a
// single space character. Both are leading/trailing whitespace agnostic between the braces. This
// runs as the FIRST compiler pass so the resulting whitespace is present for every later pass and
// survives trimming that would otherwise strip surrounding whitespace (e.g. inside a wrap
// `delineator=` value).
// The single backslash character, built via char code so it survives source formatting untouched --
// still needed below to DETECT (and flag as deprecated) the old backslash-letter spelling.
export const BACKSLASH = String.fromCharCode(92);

// `WS` matches optional whitespace between braces so tokens are leading/trailing whitespace agnostic
// (e.g. `{{ /return }}`, `{{/return}}`, `{{  /return  }}`).
export const WS = BACKSLASH + 's*';

export const OPEN = BACKSLASH + '{' + BACKSLASH + '{';

export const CLOSE = BACKSLASH + '}' + BACKSLASH + '}';

// `{{ /return }}` / `{{ /space }}` are the only supported spellings as of session 7 (see
// applyWhitespaceTokens for why the old `{{ \n }}` / `{{ \t }}` spelling is deprecated, not removed
// outright).
export const RETURN_TOKEN_PATTERN = OPEN + WS + '/return' + WS + CLOSE;

export const SPACE_ALIAS_TOKEN_PATTERN = OPEN + WS + '/space' + WS + CLOSE;
// `{{ /tab }}` -> a real tab character (U+0009), e.g. for TSV output; survives trimming like /return and /space.
export const TAB_TOKEN_PATTERN = OPEN + WS + '/tab' + WS + CLOSE;

// RETIRED (session 7), per explicit direction -- kept only so applyWhitespaceTokens can still
// DETECT the old spelling and flag it as deprecated, rather than letting it fall through to the
// generic pass-through and render silently wrong (an unrecognized `\n`/`\t` two-character token
// resolves to '', same silent-failure shape the session-6 regex bug had).
export const NEWLINE_TOKEN_PATTERN = OPEN + WS + BACKSLASH + BACKSLASH + 'n' + WS + CLOSE;

export const SPACE_TOKEN_PATTERN = OPEN + WS + BACKSLASH + BACKSLASH + 't' + WS + CLOSE;

// Non-whitespace, non-brace placeholder characters that stand in for a token-produced newline / space
// during compilation. Control chars (U+0001 / U+0002) never appear in real templates or product data,
// and crucially they are NOT matched by \s, so they survive every whitespace trim (including the wrap
// tag's `delineator=` trimming) and are only turned into real whitespace at the very end.
export const NEWLINE_SENTINEL = String.fromCharCode(1);

export const SPACE_SENTINEL = String.fromCharCode(2);
export const TAB_SENTINEL = String.fromCharCode(5);

// `{{ break }}` / `{{ skip }}` (added session 6, loop redesign) -- like the whitespace sentinels
// above, these are non-printable control characters (U+0003 / U+0004) that can never appear in a
// real template or in product data, embedded in a loop iteration's rendered text by
// renderTokenContent's bare-token check (see below) and detected+stripped ONLY by the loop-driving
// code (expandForeachBlocks, applyVariantLoop, the tags loop, applyWhileLoop) -- every other caller
// of renderTokens/renderTemplateText never inspects for them, so a `{{ break }}`/`{{ skip }}` typed
// outside any loop simply renders as an invisible, inert character (effectively nothing), exactly
// the same "outside its context, harmlessly does nothing" behavior every other loop-scoped token in
// this file already has (e.g. `{{ variant.* }}` outside a variant loop). This mirrors the marker
// pattern already proven out for the unresolved-variable fix (session 5): an in-band sentinel,
// substring-detected at one specific call site, needs no new return type threaded through the whole
// render pipeline -- far less invasive than changing every function's signature to carry a separate
// out-of-band signal.
// Both discard the current iteration's ENTIRE rendered output (not just the text from the token
// onward -- text before AND after `{{ break }}`/`{{ skip }}` in that same iteration still renders
// normally, in the usual left-to-right token order, but the iteration's combined result is thrown
// away rather than appended once either sentinel is found in it); `{{ break }}` additionally stops
// the loop from running any further iterations, `{{ skip }}` only discards the current one and
// continues. Both are almost always reached conditionally, inside an `{{ #if=... }}` branch -- no
// new conditional grammar is needed for that, it composes with the existing one for free.
export const BREAK_SENTINEL = String.fromCharCode(3);

export const SKIP_SENTINEL = String.fromCharCode(4);

export function applyWhitespaceTokens(body: string): string {
  // Encode `{{ /return }}` / `{{ /space }}` as sentinels. Runs as the FIRST compiler pass so the
  // sentinels are present for every later pass. Because sentinels are not whitespace, token-produced
  // whitespace is never eaten by trimming -- so the tokens work anywhere, including at the edge of a
  // wrap delineator, while genuinely typed whitespace stays trim-able (agnostic).
  // The OLD `{{ \n }}` / `{{ \t }}` spelling is retired (session 7): matched here ONLY so it can be
  // replaced with a visible deprecatedSyntaxMarker instead of silently doing nothing (see
  // NEWLINE_TOKEN_PATTERN's comment) -- this must run BEFORE the sentinel replacements below, since
  // the marker text itself is plain prose (no braces), so it cannot be mistaken for a whitespace
  // token by a later pass.
  const deprecatedNewline = deprecatedSyntaxMarker(
    'the backslash-n whitespace token is retired -- use the /return token instead',
  );
  const deprecatedSpace = deprecatedSyntaxMarker(
    'the backslash-t whitespace token is retired -- use the /space token instead',
  );
  const withDeprecatedFlagged = body
    .replace(new RegExp(NEWLINE_TOKEN_PATTERN, 'g'), deprecatedNewline)
    .replace(new RegExp(SPACE_TOKEN_PATTERN, 'g'), deprecatedSpace);
  const returnToken = new RegExp(RETURN_TOKEN_PATTERN, 'g');
  const spaceAliasToken = new RegExp(SPACE_ALIAS_TOKEN_PATTERN, 'g');
  const tabToken = new RegExp(TAB_TOKEN_PATTERN, 'g');
  return withDeprecatedFlagged
    .replace(returnToken, NEWLINE_SENTINEL)
    .replace(spaceAliasToken, SPACE_SENTINEL)
    .replace(tabToken, TAB_SENTINEL);
}

export function restoreWhitespaceTokens(text: string): string {
  // Turn the whitespace sentinels back into real characters. Runs as the LAST step, after wrapping,
  // so nothing downstream can strip them.
  return text
    .split(NEWLINE_SENTINEL)
    .join(String.fromCharCode(10))
    .split(SPACE_SENTINEL)
    .join(' ')
    .split(TAB_SENTINEL)
    .join(String.fromCharCode(9));
}

// Whitespace control, in analogy with Liquid's `{%- -%}`: `{-{` removes the newline BEFORE the tag (and any
// spaces/tabs between that newline and the tag, i.e. its indentation); `}-}` removes the newline AFTER the tag
// (and any spaces/tabs between the tag and that newline). Both are otherwise ordinary `{{` / `}}`, and may be
// combined on one tag: `{-{ x }-}`. Applied to the raw template (and to global bodies) before anything else, so
// it also works on block tags: `{{ #if=... }-}`.
export function applyWhitespaceControl(body: string): string {
  if (body.indexOf('{-{') === -1 && body.indexOf('}-}') === -1) return body;
  return body
    .replace(/(?:\r\n|\n|\r)[ \t]*\{-\{/g, '{{')
    .replace(/\{-\{/g, '{{')
    .replace(/\}-\}[ \t]*(?:\r\n|\n|\r)/g, '}}')
    .replace(/\}-\}/g, '}}');
}
