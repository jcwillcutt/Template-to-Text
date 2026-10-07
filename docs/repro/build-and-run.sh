#!/usr/bin/env bash
# Runs the template engine headlessly in Node (no Shopify, no browser) to reproduce engine bugs.
# Usage: docs/repro/build-and-run.sh [path/to/template-to-text.tsx]   (needs `tsc` on PATH)
# The engine functions are pure; only the UI at the bottom of the file needs preact, which is stubbed.
set -euo pipefail
SRC="${1:-$(dirname "$0")/../../template-to-text.tsx}"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
mkdir -p "$W/node_modules/react" "$W/node_modules/preact/hooks"
echo 'exports.jsx=exports.jsxs=exports.Fragment=()=>null;' > "$W/node_modules/react/jsx-runtime.js"
echo 'exports.render=()=>{};' > "$W/node_modules/preact/index.js"
echo 'exports.useState=exports.useEffect=exports.useMemo=exports.useRef=()=>{};' > "$W/node_modules/preact/hooks/index.js"
cp "$SRC" "$W/t2t.tsx"
echo 'export const __t = { planOutputFiles, renderTokens, evaluateSingle };' >> "$W/t2t.tsx"
(cd "$W" && tsc --noCheck --target es2022 --module commonjs --jsx react-jsx --skipLibCheck --outDir js t2t.tsx)
node "$(dirname "$0")/if_cases.js" "$W"
