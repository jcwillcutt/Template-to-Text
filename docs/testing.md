# Test strategy

`npm test` runs everything below (~10 s). The suite is built around one idea: **the legacy engine is a
test oracle.** `tests/helpers/legacy-oracle.ts` loads the original engine straight out of the untouched root file
`template-to-text.tsx` (reads it, appends one export, transpiles, runs it in a `vm` with `preact` stubbed), so the
new engine can be compared against the real, shipped behaviour -- not against a description of it.

| Layer | Files | What it proves |
|---|---|---|
| **Behaviour** (explicit expectations) | `tokens`, `variables-math-conditions`, `loops-and-text-tools`, `plan` | Every token, variable rule, equation, boolean, `#if`, every loop and text tool, selection loops (skip/kinds/prev/next), file-break modes, naming, Merge IF, source ids -- with the expected string written out. |
| **Reported bug** | `reported-issues` | The `#if`-with-variables bug in 10 shapes, the owner's real template and saved bad output from `Errors/`, and that the legacy engine gets them wrong (so the fix is pinned to a cause). |
| **Unit** | `math`, `datetime`, `wrap-textops`, `lexicon`, `zip`, `parse` | Leaf modules in isolation; the ZIP writer is checked by an *independent* ZIP reader plus CRC, and byte-for-byte against the legacy writer. |
| **Differential** | `differential` | Curated corpus (50 templates x 5 file-break modes), Merge IF + globals, and 2 x 1,500 **randomly generated templates** (fast-check) -- new engine output must equal the legacy engine's, file for file, name for name. Intentional divergences are listed and pinned in both directions. |
| **Totality / properties** | `parse` (property tests), `limits` | Parsing and rendering never throw on arbitrary text (3,000 random strings each, including binary), output is deterministic, runaway templates fail with a clear error instead of hanging. |
| **Documentation** | `syntax-guide` | Every worked example in `template-syntax-guide`. Examples whose stated output is wrong are asserted with the *real* output and explained (see `syntax-guide-audit.md`). |
| **Performance** | `scaling` | Work grows linearly (N vs 4N), Merge IF planning is not quadratic, a long template is parsed once. Absolute speed: `npm run bench`. |
| **Build / single file** | `build/bundle`, `build/compat` | The concatenated file is self-contained and equals the module code in behaviour; build-script rules; no post-ES2019 APIs in the engine (old Chrome). |

## Differential testing details

* `tests/helpers/template-gen.ts` generates templates only from constructs where the legacy engine is *known to be
  correct*. Anything else would flag the legacy engine's bugs as failures. The exclusions are written next to the
  generator and mirror the intentional divergences in `engine-rewrite.md`.
* Raise the run count / change the seed for a longer soak:
  `FUZZ_RUNS=20000 FUZZ_SEED=123 npx vitest run tests/engine/differential.test.ts -t random --testTimeout 900000`
* When a run fails, fast-check prints a *shrunk* counterexample (the smallest failing template). Decide whether it
  is (a) a bug in the new engine -> fix; or (b) a legacy quirk -> add to the divergence list *and* tighten the
  generator so it stays out of that territory.

## What is not covered (and why)

* **The UI** (`src/ui/Extension.tsx`): it needs Shopify admin's runtime (`shopify` global, Polaris `s-*` web
  components). It is only checked for *linking*: the bundle test verifies no UI identifier is left unresolved after
  the engine swap. Layout/interaction fixes (row click, double click, table overflow) need a browser or the
  Shopify dev store to verify; see `known-issues.md`.
* **Shopify storage calls** (`shopify.query` GraphQL): no sandbox. The storage *packing/parsing* logic is pure and a
  good next candidate (see `suggestions.md` D-items).
* **Real old-browser execution.** `compat.test.ts` guards the APIs used; actually reproducing the old-Chrome crash
  needs the Chrome version and a stack trace from the owner.
