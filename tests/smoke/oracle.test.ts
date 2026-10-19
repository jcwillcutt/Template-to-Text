import { it, expect } from 'vitest';
import { loadLegacyEngine } from '../helpers/legacy-oracle';
import { makeProducts, FIXED_NOW } from '../helpers/fixtures';
it('legacy oracle loads and renders', () => {
  const L = loadLegacyEngine();
  const plan = L.planOutputFiles('T', '{{ product.title }}|{{ product.vendor }}', 'txt', makeProducts(2), [], 'product', '', 'x.myshopify.com', FIXED_NOW, {});
  expect(plan.count).toBe(2);
  expect(plan.build(0).content).toBe('Product 1|Acme Co');
});
