// Cases for the "#if can't use variables/equations" bug. Expected values are what the syntax guide promises.
const { __t } = require(process.argv[2] + '/js/t2t.js');
const mk = (h, i) => ({ id: 'gid://shopify/Product/' + i, title: 'T' + i, handle: h, vendor: i % 2 ? 'A' : 'B',
  productType: '', tags: [], status: 'active', description: '', totalInventory: i, imageUrl: null, priceMin: '1',
  priceMax: '1', currencyCode: 'USD', createdAt: '', updatedAt: '', variants: [], allVariants: [], metafields: [], note: '' });
const prods = ['a', 'b', 'c', 'd'].map(mk);
const run = (body) => {
  const plan = __t.planOutputFiles('t', body, 'txt', prods, [], 'selection', '', 'x', new Date(), {});
  try { return plan.build(0).content; } catch (e) { return 'ERR ' + e.message; }
};
const cases = [
  ['var in condition', `{{ x = 5 }}{{ #if={{ x }} > 3 }}big{{ #else }}small{{ /if }}`, 'big'],
  ['equation of var', `{{ x = 5 }}{{ #if={{ = {{x}}*2 }} == 10 }}yes{{ #else }}no{{ /if }}`, 'yes'],
  ['truthy var', `{{ f = TRUE }}{{ #if={{ f }} }}T{{ #else }}F{{ /if }}`, 'T'],
  ['var set inside earlier if', `{{ #if=1==1 }}{{ n = 3 }}{{ /if }}{{ #if={{n}}==3 }}three{{ #else }}no{{ /if }}`, 'three'],
  ['while counter', `{{ x = 0 }}{{ #while={{x}}<4 }}{{ #if={{x}}==2 }}[two]{{ #else }}{{x}}{{ /if }}{{ x = {{ ={{x}}+1 }} }}{{/while}}`, '01[two]3'],
  ['var derived from product, in foreach', `{{#selection.foreach product, i=0}}{{ v = {{ product.vendor }} }}{{ #if={{v}} == A }}A{{ #else }}-{{ /if }}{{/selection.foreach}}`, '-A-A'],
  ['running total (off-by-one on bug)', `{{ t = 0 }}{{#selection.foreach product, i=0}}{{ t = {{ = {{t}} + {{ product.totalInventory }} }} }}{{ #if={{t}} > 2 }}[{{t}}!]{{ #else }}[{{t}}]{{ /if }}{{/selection.foreach}}`, '[0][1][3!][6!]'],
  ['foreach counter (always worked)', `{{#selection.foreach product, i=0}}{{ #if={{ = {{ i }}%2 }} == 0 }}E{{ #else }}O{{ /if }}{{/selection.foreach}}`, 'EOEO'],
];
let fail = 0;
for (const [name, body, want] of cases) {
  const got = run(body); const ok = got === want; if (!ok) fail++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name.padEnd(40) + JSON.stringify(got) + (ok ? '' : '   expected ' + JSON.stringify(want)));
}
process.exit(fail ? 1 : 0);
