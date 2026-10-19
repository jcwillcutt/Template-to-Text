// Visible, brace-free marker strings that stand in for failed/retired constructs. They deliberately contain no
// literal double-curly characters (they can be re-rendered). Verbatim from the legacy engine.

// ----------------------------------------------------------------------------------------------
// TEMPLATE ENGINE -- arithmetic expression evaluator ({{ =EXPR }})
// ----------------------------------------------------------------------------------------------
// --- Arithmetic expression evaluator ---------------------------------------------------------
// A self-contained tokenizer + recursive-descent parser used for {{ =EXPR }} equations. It supports
// + - * / % ^ (exponentiation, right-associative), unary minus, and parentheses. JavaScript `eval`
// is intentionally NOT used so that `^` means exponentiation rather than bitwise XOR. Throws on any
// malformed input so callers can catch and render an empty string.
//
// A variable is ALWAYS referenced with its own {{ }} inside an equation (e.g. `{{ = {{i}}%4 }}`) --
// never bare (`{{ = i%4 }}` is invalid). tokenizeMath below specifically detects a bare identifier
// and throws an error prefixed with UNRESOLVED_VARIABLE_ERROR_PREFIX, naming the identifier; this is
// caught in exactly two places -- renderTokenContent's math branch and applyIfBlocks -- to surface a
// visible marker (see unresolvedVariableMarker) in the rendered output instead of silently rendering
// nothing or (worse, inside an {{ #if=EXPR }} condition) silently always taking whichever branch a
// broken string comparison happens to land on.
export const UNRESOLVED_VARIABLE_ERROR_PREFIX = 'UNRESOLVED_VARIABLE:';

// The visible marker rendered in place of a failed equation/condition when the failure was
// specifically an unresolved bare variable reference (see UNRESOLVED_VARIABLE_ERROR_PREFIX above).
// Deliberately contains NO literal `{{`/`}}` characters: this text can end up back inside a larger
// string that gets fed through another render pass (applyIfBlocks' own output is re-scanned by
// renderTokens right after it runs) -- a `{{ name }}` written INTO the marker as a "here's the fix"
// example would itself be resolved on that second pass and silently replaced by name's actual
// value, corrupting the very message meant to explain the mistake. Spelling the fix out in words
// instead avoids that trap entirely.
export function unresolvedVariableMarker(name: string): string {
  return `[[ unresolved variable "${name}" in equation -- wrap it in double curly braces ]]`;
}

// Whether an already-rendered string contains an unresolvedVariableMarker (used by applyIfBlocks to
// detect that part of a condition never actually evaluated, rather than proceeding to compare a
// broken string and silently picking a branch).
export function containsUnresolvedVariableMarker(text: string): boolean {
  return text.includes('unresolved variable "');
}

// Session 7: a general-purpose "this old syntax is retired" marker, same shape and same reasoning as
// unresolvedVariableMarker above -- rendered in place of running the OLD behavior for a construct
// whose old form was deliberately removed (see the while/tied/whitespace-token deprecations below),
// so an already-saved template that used the old form fails LOUDLY and ACTIONABLY (naming exactly
// what changed) instead of silently rendering wrong or empty output the way the regex bug and the
// bare-variable bug both did before they were caught. Deliberately contains NO literal `{{`/`}}`
// characters, for the same reason unresolvedVariableMarker doesn't: this text can end up back inside
// a string that gets fed through another render pass, and a literal `{{ ... }}` written into it as a
// "here's the fix" example would itself be resolved on that pass, corrupting the message.
export function deprecatedSyntaxMarker(description: string): string {
  return `[[ deprecated syntax removed -- ${description} ]]`;
}

// Visible markers for the three ways a global-variable reference can go wrong, matching this file's
// established "never fail silently" pattern (see unresolvedVariableMarker/deprecatedSyntaxMarker
// above) -- deliberately contain no literal double-curly-brace characters, for the same reason those
// two markers don't: this text can end up back inside a string fed through another render pass.
export function globalReadOnlyMarker(name: string): string {
  return `[[ global variable "${name}" is read-only in a template -- change its value in Settings under Global Vars instead ]]`;
}

export function globalUndefinedMarker(name: string): string {
  return `[[ no global variable named "${name}" is defined -- add one in Settings under Global Vars ]]`;
}

export function globalNotExpandedMarker(name: string): string {
  return `[[ global variable "${name}" was not expanded here -- a global cannot reference another global yet ]]`;
}
