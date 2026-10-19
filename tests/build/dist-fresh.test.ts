import { expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error -- plain ESM script without types
import { build } from '../../scripts/build.mjs';

// dist/template-to-text.tsx is the file that gets deployed and it is committed, so it must never go stale.
it('the committed dist/template-to-text.tsx is up to date with src/ (run `npm run build`)', () => {
  const dist = path.resolve(import.meta.dirname, '..', '..', 'dist', 'template-to-text.tsx');
  expect(fs.existsSync(dist), 'run `npm run build` and commit dist/').toBe(true);
  expect(fs.readFileSync(dist, 'utf8')).toBe(build());
});
