// Old-browser guard. Some merchants run old Chrome versions; the engine must not use JavaScript features
// newer than ES2019 (the app code already relies on optional chaining / nullish coalescing, which Shopify's
// build transpiles). This scans the engine sources for APIs and syntax that would throw or fail to parse
// on an older engine.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const engineDir = path.join(ROOT, 'src', 'engine');
const files = fs.readdirSync(engineDir).filter((f) => f.endsWith('.ts') && f !== 'index.ts');

const banned: [RegExp, string][] = [
  [/\.at\(/, 'Array/String.prototype.at (Chrome 92)'],
  [/\.replaceAll\(/, 'String.prototype.replaceAll (Chrome 85)'],
  [/structuredClone\(/, 'structuredClone (Chrome 98)'],
  [/Object\.hasOwn\(/, 'Object.hasOwn (Chrome 93)'],
  [/\.flatMap\(|\.flat\(/, 'Array.prototype.flat/flatMap (Chrome 69)'],
  [/\.matchAll\(/, 'String.prototype.matchAll (Chrome 73)'],
  [/\(\?<[=!]/, 'regex lookbehind (Chrome 62)'],
  [/\(\?<[A-Za-z_]/, 'regex named groups (Chrome 64)'],
  [/\?\?=|\|\|=|&&=/, 'logical assignment (Chrome 85)'],
  [/\.toSorted\(|\.findLast\(|\.findLastIndex\(/, 'ES2023 array methods'],
  [/\bBigInt\b|\d+n\b(?![\w'"])/, 'BigInt (Chrome 67)'],
  [/Object\.fromEntries\(/, 'Object.fromEntries (Chrome 73)'],
  [/\.trimStart\(|\.trimEnd\(/, 'trimStart/trimEnd (Chrome 66)'],
  [/\bclass\s+\w+\s*\{[^}]*\n\s+(static\s+)?#?\w+\s*=/, 'class fields (Chrome 72)'],
  [/\bawait\b|\basync\b/, 'async/await in the engine (it is synchronous; Chrome 55)'],
];

describe('engine sources avoid post-ES2019 features', () => {
  for (const f of files) {
    it(f, () => {
      const text = fs
        .readFileSync(path.join(engineDir, f), 'utf8')
        // ignore comments so prose can mention these names
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\s\/\/ .*$/gm, '');
      const hits = banned.filter(([re]) => re.test(text)).map(([, why]) => why);
      expect(hits).toEqual([]);
    });
  }
});
