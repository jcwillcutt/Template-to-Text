// Performance comparison: legacy engine (loaded from the untouched root file) vs. the new engine.
// Run: npm run bench            (add `-- legacy` to run only the legacy engine)
// Reports wall time (median of several runs) and peak heap growth per scenario.
import { loadLegacyEngine } from '../tests/helpers/legacy-oracle';
import { makeProducts, FIXED_NOW } from '../tests/helpers/fixtures';

const only = process.argv[2];
const engines: Record<string, any> = { legacy: loadLegacyEngine() };
if (only !== 'legacy') {
  try {
    engines.next = await import('../src/engine/index');
  } catch {
    /* new engine not available yet */
  }
}

const LINE = `{{ product.title }},{{ product.handle }},{{ product.vendor }},{{ product.priceMin }},{{ product.metafield.custom.material }}`;
const scenarios: { name: string; body: string; n: number; variants: number; fileBreak: string; merge?: string; runs?: number }[] = [
  { name: 'combined CSV, 4000 products (foreach + if + math)', n: 4000, variants: 1, fileBreak: 'selection',
    body: `title,handle\n{{#selection.foreach product, i=0}}{{ #if={{ = {{ i }}%4 }} == 0 }}{{ /return }}{{ #else }},{{ /if }}${LINE}{{/selection.foreach}}` },
  { name: 'combined, 1000 products x 3 variants, nested variant loop', n: 1000, variants: 3, fileBreak: 'selection',
    body: `{{#selection.foreach product, i=0}}{{ product.title }}:{{ #variants.foreach v, l=0 }} {{ variant.sku }}={{ variant.price }}{{/variants.foreach}}{{ /return }}{{/selection.foreach}}` },
  { name: 'per-variant files, 2000 products x 2 variants (4000 files)', n: 2000, variants: 2, fileBreak: 'variant',
    body: `SKU: {{ variant.sku }}{{ /return }}Title: {{ product.title }} - {{ variant.title }}{{ /return }}{{ #if={{ variant.inventoryQuantity }} > 5 }}In stock{{ #else }}Low{{ /if }}` },
  { name: 'per-product files, 1000 products, 40-line template', n: 1000, variants: 1, fileBreak: 'product',
    body: Array.from({ length: 40 }, (_, k) => `L${k}: {{ product.title }} {{ product.handle }} {{ product.metafield.productspecs.serial }} {{ = {{ product.totalInventory }} * ${k + 1} }}`).join('{{ /return }}') },
  { name: 'while loop, 5000 iterations', n: 1, variants: 1, fileBreak: 'selection',
    body: `{{ x = 0 }}{{ s = }}{{ #while={{x}}<5000 }}{{ #if={{ = {{x}}%1000 }} == 0 }}[{{x}}]{{ /if }}{{ x = {{ ={{x}}+1 }} }}{{/while}}` },
  { name: 'merge-IF grouping, 1500 products (group by vendor)', n: 1500, variants: 1, fileBreak: 'product', merge: `{{ selection.next.product.vendor }} == {{ selection.curr.product.vendor }}`,
    body: `{{ product.title }}{{ /return }}`, runs: 3 },
  { name: 'text tools: replace/wrap/repeat/chop, 800 products', n: 800, variants: 1, fileBreak: 'product',
    body: `{{ #replace=a, replacement=A }}{{ product.description }}{{/replace}}{{ /return }}{{#wrap=20, delineator={{ /return }}}}{{ product.description }}{{/wrap}}{{ /return }}{{ #repeat=3, delineator=- }}{{ product.handle }}{{/repeat}}{{ /return }}{{ #chop={{ {{j}}==5 }}, j=0 }}{{ product.title }}{{/chop}}` },
];

const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

for (const sc of scenarios) {
  const products = makeProducts(sc.n, { variants: sc.variants });
  const row: string[] = [];
  let ref: string | null = null;
  for (const [name, E] of Object.entries(engines)) {
    const times: number[] = [];
    let heapPeak = 0;
    let out = '';
    let flag = '';
    for (let r = 0; r < (sc.runs ?? 5); r++) {
      (globalThis as any).gc?.();
      const h0 = process.memoryUsage().heapUsed;
      const t0 = performance.now();
      const plan = E.planOutputFiles('Bench', sc.body, 'csv', products, [], sc.fileBreak, sc.merge ?? '', 'shop.myshopify.com', FIXED_NOW, {});
      let total = 0;
      let first = '';
      for (let i = 0; i < plan.count; i++) {
        const c = plan.build(i).content;
        total += c.length;
        if (i === 0) first = c;
      }
      times.push(performance.now() - t0);
      heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed - h0);
      out = `${plan.count} files, ${total} chars`;
      if (r === 0 && name === 'legacy') ref = first;
      if (r === 0 && name !== 'legacy' && ref !== null && first !== ref) flag = ' (!! first file differs from legacy)';
    }
    row.push(`${name.padEnd(6)} ${med(times).toFixed(1).padStart(9)} ms  heap+${(heapPeak / 1048576).toFixed(0).padStart(4)} MB  [${out}]${flag}`);
  }
  console.log(`\n${sc.name}\n  ` + row.join('\n  '));
}
