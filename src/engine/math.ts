// {{ = EXPR }} arithmetic: recursive-descent evaluator for + - * / % ^ and parentheses. Verbatim from the legacy
// engine (no eval(); a bare identifier throws an UNRESOLVED_VARIABLE error that callers turn into a marker).

import { UNRESOLVED_VARIABLE_ERROR_PREFIX } from './markers';

export type MathToken = { type: 'num'; value: number } | { type: 'op'; value: string };

export function tokenizeMath(input: string): MathToken[] {
  const tokens: MathToken[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      let num = '';
      while (i < input.length && ((input[i] >= '0' && input[i] <= '9') || input[i] === '.')) {
        num += input[i];
        i += 1;
      }
      const value = parseFloat(num);
      if (!Number.isFinite(value)) {
        throw new Error('Invalid number in equation');
      }
      tokens.push({ type: 'num', value });
      continue;
    }
    if ('+-*/%^()'.indexOf(ch) !== -1) {
      tokens.push({ type: 'op', value: ch });
      i += 1;
      continue;
    }
    // A run of letters/digits/underscore that isn't a valid number is almost always a variable
    // reference the author forgot to wrap in its own {{ }} -- e.g. `{{ = i%4 }}` instead of the
    // correct `{{ = {{i}}%4 }}`. A genuine variable's VALUE is always substituted to a plain number
    // by renderTemplateText before this tokenizer ever runs (see renderTokenContent's math branch),
    // so an identifier can only reach here by mistake. Thrown with a distinctive, parseable message
    // (UNRESOLVED_VARIABLE_ERROR_PREFIX) so callers can surface a specific, actionable error instead
    // of silently rendering nothing -- see renderTokenContent and applyIfBlocks.
    if (/[A-Za-z_]/.test(ch)) {
      let ident = '';
      while (i < input.length && /[A-Za-z0-9_]/.test(input[i])) {
        ident += input[i];
        i += 1;
      }
      throw new Error(UNRESOLVED_VARIABLE_ERROR_PREFIX + ident);
    }
    throw new Error('Unexpected character in equation');
  }
  return tokens;
}

// Recursive-descent parser/evaluator over the token stream.
export function evaluateMathExpression(input: string): number {
  const tokens = tokenizeMath(input);
  let pos = 0;

  const peek = (): MathToken | undefined => tokens[pos];

  // primary := number | '(' expr ')' | ('+'|'-') primary
  const parsePrimary = (): number => {
    const tok = peek();
    if (!tok) throw new Error('Unexpected end of equation');
    if (tok.type === 'op' && (tok.value === '+' || tok.value === '-')) {
      pos += 1;
      const operand = parsePrimary();
      return tok.value === '-' ? -operand : operand;
    }
    if (tok.type === 'op' && tok.value === '(') {
      pos += 1;
      const value = parseAddSub();
      const close = peek();
      if (!close || close.type !== 'op' || close.value !== ')') {
        throw new Error('Missing closing parenthesis');
      }
      pos += 1;
      return value;
    }
    if (tok.type === 'num') {
      pos += 1;
      return tok.value;
    }
    throw new Error('Unexpected token in equation');
  };

  // power := primary ('^' power)?  (right-associative)
  const parsePower = (): number => {
    const base = parsePrimary();
    const tok = peek();
    if (tok && tok.type === 'op' && tok.value === '^') {
      pos += 1;
      const exponent = parsePower();
      return Math.pow(base, exponent);
    }
    return base;
  };

  // mulDiv := power (('*'|'/'|'%') power)*
  const parseMulDiv = (): number => {
    let value = parsePower();
    let tok = peek();
    while (
      tok &&
      tok.type === 'op' &&
      (tok.value === '*' || tok.value === '/' || tok.value === '%')
    ) {
      pos += 1;
      const right = parsePower();
      if (tok.value === '*') value = value * right;
      else if (tok.value === '/') value = value / right;
      else value = value % right;
      tok = peek();
    }
    return value;
  };

  // addSub := mulDiv (('+'|'-') mulDiv)*
  const parseAddSub = (): number => {
    let value = parseMulDiv();
    let tok = peek();
    while (tok && tok.type === 'op' && (tok.value === '+' || tok.value === '-')) {
      pos += 1;
      const right = parseMulDiv();
      value = tok.value === '+' ? value + right : value - right;
      tok = peek();
    }
    return value;
  };

  const result = parseAddSub();
  if (pos !== tokens.length) {
    throw new Error('Unexpected trailing tokens in equation');
  }
  return result;
}
