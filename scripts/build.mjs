// Concatenates the modular sources in src/ into ONE file (dist/template-to-text.tsx), because the
// Shopify extension must ship as a single file. Authoring rules that make this safe:
//   * Modules may use relative `import`/`export` (for tests and type-checking); the build strips them.
//   * Every top-level name must be unique across the whole bundle (they all share one scope). The
//     build fails with the clashing names if not.
//   * Only external imports (e.g. 'preact') are kept, merged and hoisted to the top.
//   * `export default` is allowed in exactly one file (the entry) and is preserved.
//   * No `export { a, b }` / `export * from` forms (use inline `export function ...`).
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Concatenation order. Top-level `const`s that run at load time must come after what they use.
export const ORDER = [
  'src/domain/types.ts',
  'src/storage/constants.ts',
  'src/storage/parsing.ts',
  'src/format/helpers.ts',
  // Template engine (pure; no UI). Order = dependency order for load-time constants.
  'src/engine/markers.ts',
  'src/engine/lexicon.ts',
  'src/engine/scan.ts',
  'src/engine/math.ts',
  'src/engine/datetime.ts',
  'src/engine/textops.ts',
  'src/engine/wrap.ts',
  'src/engine/zip.ts',
  'src/engine/rows.ts',
  'src/engine/templates-catalog.ts',
  'src/engine/ast.ts',
  'src/engine/fields.ts',
  'src/engine/parse.ts',
  'src/engine/evaluate.ts',
  'src/engine/plan.ts',
  'src/ui/search.ts',
  'src/ui/format.tsx',
  'src/ui/graphql.ts',
  'src/ui/syntax-guide.tsx',
  'src/ui/Extension.tsx',
];

function topLevelNames(st) {
  if (ts.isVariableStatement(st)) {
    const out = [];
    const visit = (n) => {
      if (ts.isIdentifier(n)) out.push(n.text);
      else if (ts.isObjectBindingPattern(n) || ts.isArrayBindingPattern(n)) n.elements.forEach((e) => ts.isBindingElement(e) && visit(e.name));
    };
    st.declarationList.declarations.forEach((d) => visit(d.name));
    return out;
  }
  if (
    (ts.isFunctionDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) &&
    st.name
  ) {
    // function overloads share a name; callers dedupe per file
    return [st.name.text];
  }
  return [];
}

// Remove every comment (and the blank lines that leave behind) from TypeScript/TSX source WITHOUT touching string,
// template, regex or JSX-text contents: comments are located as trivia attached to AST nodes, never by pattern
// matching on the text. Comments stay in the modules in src/; only the shipped bundle is stripped, to keep its
// line numbers (and error line references) as small as possible.
export function stripComments(text, fileName = 'bundle.tsx') {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const ranges = new Map(); // pos -> end
  const protectedSpans = []; // spans in which `//` or blank lines are content: JSX text, template/string literals
  const addComments = (list) => list?.forEach((c) => ranges.set(c.pos, c.end));
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText) {
      protectedSpans.push([node.pos, node.end]);
      return;
    }
    if (
      node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail ||
      node.kind === ts.SyntaxKind.StringLiteral ||
      node.kind === ts.SyntaxKind.RegularExpressionLiteral
    ) {
      protectedSpans.push([node.getStart(sf), node.end]);
    }
    // `{/* comment */}` between JSX children: drop the whole empty expression container.
    if (node.kind === ts.SyntaxKind.JsxExpression && !node.expression) {
      ranges.set(node.getStart(sf), node.end);
      return;
    }
    addComments(ts.getLeadingCommentRanges(text, node.pos));
    addComments(ts.getTrailingCommentRanges(text, node.end));
    // getChildren includes punctuation tokens, so comments sitting before a `|`, `}` or `)` are found too.
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  addComments(ts.getLeadingCommentRanges(text, sf.endOfFileToken.pos));
  const inProtected = (a, b) => protectedSpans.some(([s, e]) => a < e && b > s);
  const cuts = [...ranges.entries()].filter(([a, b]) => !inProtected(a, b)).sort((x, y) => x[0] - y[0]);
  let out = '';
  let last = 0;
  for (const [a, b] of cuts) {
    if (a < last) continue;
    out += text.slice(last, a);
    last = b;
  }
  out += text.slice(last);
  // Drop lines that are now empty, except blank lines that are inside literals / JSX text (their content).
  const sf2 = ts.createSourceFile(fileName, out, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const keep = [];
  const visit2 = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText) keep.push([node.pos, node.end]);
    else if (
      node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail
    ) {
      keep.push([node.getStart(sf2), node.end]);
    }
    ts.forEachChild(node, visit2);
  };
  visit2(sf2);
  const lines = out.split('\n');
  const result = [];
  let offset = 0;
  for (const line of lines) {
    const start = offset;
    const end = offset + line.length;
    offset = end + 1;
    if (line.trim() === '' && !keep.some(([a, b]) => start > a && start <= b)) continue;
    result.push(line.replace(/\s+$/, '') === line || keep.some(([a, b]) => start >= a && end <= b) ? line : line.replace(/\s+$/, ''));
  }
  return result.join('\n');
}

export function build(order = ORDER, root = ROOT, { comments = false } = {}) {
  const externals = new Map(); // module -> {default?:string, named:Set<string>}
  const seen = new Map(); // name -> file
  const bodies = [];
  let defaultExports = 0;
  for (const rel of order) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const edits = []; // [start,end,replacement]
    const fileNames = new Set();
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st)) {
        const spec = st.moduleSpecifier.text;
        if (spec.startsWith('.')) {
          edits.push([st.getFullStart(), st.end, '']);
        } else {
          const e = externals.get(spec) ?? { named: new Set(), def: null, ns: null, typeOnly: true };
          const c = st.importClause;
          if (c) {
            if (c.name) e.def = c.name.text;
            if (c.namedBindings && ts.isNamedImports(c.namedBindings)) c.namedBindings.elements.forEach((el) => e.named.add(el.getText()));
            if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) e.ns = c.namedBindings.name.text;
          }
          externals.set(spec, e);
          edits.push([st.getFullStart(), st.end, '']);
        }
        continue;
      }
      if (ts.isExportDeclaration(st)) throw new Error(`${rel}: 'export { ... }' / 'export * from' not allowed; use inline export`);
      if (ts.isExportAssignment(st)) {
        if (st.isExportEquals) throw new Error(`${rel}: 'export =' not allowed`);
        defaultExports += 1; // `export default <expr>` is preserved as-is
        continue;
      }
      const mods = ts.canHaveModifiers(st) ? ts.getModifiers(st) : undefined;
      const exp = mods?.find((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      const isDefault = mods?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      if (exp && !isDefault) edits.push([exp.getStart(), exp.end + 1 /* trailing space */, '']);
      if (isDefault) defaultExports += 1;
      for (const n of topLevelNames(st)) {
        if (fileNames.has(n) && ts.isFunctionDeclaration(st)) continue; // overloads
        fileNames.add(n);
        if (seen.has(n)) throw new Error(`Duplicate top-level name '${n}' in ${rel} and ${seen.get(n)}`);
        seen.set(n, rel);
      }
    }
    let out = text;
    for (const [a, b, r] of edits.sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + r + out.slice(b);
    bodies.push(`// ==== ${rel} ${'='.repeat(Math.max(3, 90 - rel.length))}\n${out.replace(/^\s+/, '').replace(/\s+$/, '')}\n`);
  }
  if (defaultExports !== 1) throw new Error(`Expected exactly one 'export default', found ${defaultExports}`);
  const imports = [...externals.entries()].map(([spec, e]) => {
    const parts = [];
    if (e.def) parts.push(e.def);
    if (e.ns) parts.push(`* as ${e.ns}`);
    if (e.named.size) parts.push(`{ ${[...e.named].sort().join(', ')} }`);
    return `import ${parts.join(', ')} from '${spec}';`;
  });
  const banner = `// GENERATED by scripts/build.mjs from src/ -- DO NOT EDIT. Edit the modules in src/ and rebuild.\n`;
  const full = banner + imports.join('\n') + '\n\n' + bodies.join('\n') + '\n';
  return comments ? full : stripComments(full) + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = build();
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
  const dest = path.join(ROOT, 'dist', 'template-to-text.tsx');
  fs.writeFileSync(dest, out);
  console.log(`wrote ${path.relative(ROOT, dest)} (${out.split('\n').length} lines, ${(out.length / 1024).toFixed(0)} KB)`);
}
