// Loads the ORIGINAL engine straight out of the untouched root file `template-to-text.tsx` and exposes
// it for differential testing / benchmarking. Nothing in the root file is modified: we read it,
// append one export line in memory, transpile with the TypeScript compiler, and evaluate it in a
// vm context with `preact` stubbed out (the engine itself never touches the DOM).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

export interface LegacyEngine {
  planOutputFiles: (...args: any[]) => any;
  buildOutputFiles: (...args: any[]) => any;
  buildZipBase64: (entries: { name: string; content: string }[]) => string;
  formatDateTime: (d: Date, f: string) => string;
  stripComments: (s: string) => string;
  templateNeedsSelectionObjects: (s: string) => boolean;
  mediaTypeForExtension: (e: string) => string;
  evaluateBooleanExpression: (s: string) => boolean;
  evaluateMathExpression: (s: string) => number;
  PRODUCT_FIELD_TOKENS: { token: string; label: string }[];
  VARIANT_FIELD_TOKENS: { token: string; label: string }[];
}

const ROOT = path.resolve(import.meta.dirname, '..', '..');
let cached: LegacyEngine | null = null;

export function loadLegacyEngine(file = path.join(ROOT, 'template-to-text.tsx')): LegacyEngine {
  if (cached && file.endsWith('template-to-text.tsx')) return cached;
  const source =
    fs.readFileSync(file, 'utf8') +
    `\nexport const __legacy = { planOutputFiles, buildOutputFiles, buildZipBase64, formatDateTime, stripComments, templateNeedsSelectionObjects, mediaTypeForExtension, evaluateBooleanExpression, evaluateMathExpression, PRODUCT_FIELD_TOKENS, VARIANT_FIELD_TOKENS };\n`;
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    fileName: 'legacy.tsx',
  }).outputText;
  const stubs: Record<string, unknown> = {
    preact: { render() {} },
    'preact/hooks': { useState() {}, useEffect() {}, useMemo() {}, useRef() {} },
    'react/jsx-runtime': { jsx() {}, jsxs() {}, Fragment() {} },
  };
  const module = { exports: {} as any };
  const ctx = vm.createContext({
    module,
    exports: module.exports,
    require: (id: string) => {
      if (id in stubs) return stubs[id];
      throw new Error('legacy oracle: unexpected require ' + id);
    },
    console,
    setTimeout,
    Date,
    Math,
    String,
    Number,
    Object,
    Array,
    Set,
    Map,
    RegExp,
    JSON,
    Error,
    Promise,
    Uint8Array,
    parseInt,
    parseFloat,
    isFinite,
  });
  vm.runInContext(js, ctx, { filename: 'legacy.js' });
  const engine = module.exports.__legacy as LegacyEngine;
  if (file.endsWith('template-to-text.tsx')) cached = engine;
  return engine;
}

// createRequire is exported for tests that want to resolve node_modules from here.
export const requireFromRoot = createRequire(path.join(ROOT, 'package.json'));
