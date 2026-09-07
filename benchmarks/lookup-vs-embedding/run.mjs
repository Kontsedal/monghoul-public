/**
 * Time the four operations that separate a referenced shape from an embedded one.
 *
 *   node run.mjs --uri mongodb://localhost:27017 --runs 20 --warmup 5
 *
 * Prints a markdown table, and the plan statistics beside each read so the timing can be checked
 * against `totalDocsExamined` rather than taken on trust. Nothing here is reported in the write-up
 * that this script did not print.
 */
import { MongoClient } from 'mongodb';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const URI = arg('uri', 'mongodb://localhost:27017');
const DB = arg('db', 'lookup_bench');
const RUNS = Number(arg('runs', 20));
const WARMUP = Number(arg('warmup', 5));
const PAGE = 50;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`);

/** Warm up untimed, then time. A first run measures the cache being cold, not the shape. */
async function time(fn) {
  for (let i = 0; i < WARMUP; i++) await fn();
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const t = process.hrtime.bigint();
    await fn();
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  return { median: median(times), p95: pct(times, 0.95) };
}

async function main() {
  const client = new MongoClient(URI);
  await client.connect();
  const db = client.db(DB);

  const meta = await db.collection('_meta').findOne({ _id: 'distribution' });
  if (!meta) throw new Error('No _meta.distribution. Run generate.mjs first.');

  const ordersRef = db.collection('orders_ref');
  const ordersEmb = db.collection('orders_emb');
  const customers = db.collection('customers');

  const from = new Date(Date.UTC(2025, 0, 1));
  const to = new Date(Date.UTC(2026, 0, 1));
  const match = { status: 'shipped', createdAt: { $gte: from, $lt: to } };

  // 1 and 2: the page read, each shape, sorted by date.
  const embPage = () =>
    ordersEmb.find(match).sort({ createdAt: -1 }).limit(PAGE).toArray();

  const refPage = () =>
    ordersRef
      .aggregate([
        { $match: match },
        { $sort: { createdAt: -1 } },
        { $limit: PAGE },
        { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'customer' } },
        { $unwind: '$customer' }
      ])
      .toArray();

  // 3 and 4: the same page, ordered by a field on the joined side. This is the case that separates
  // the two shapes, because $lookup output is not available when the planner picks an index.
  const embPageByTier = () =>
    ordersEmb.find(match).sort({ 'customer.tier': 1, createdAt: -1 }).limit(PAGE).toArray();

  const refPageByTier = () =>
    ordersRef
      .aggregate([
        { $match: match },
        { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'customer' } },
        { $unwind: '$customer' },
        { $sort: { 'customer.tier': 1, createdAt: -1 } },
        { $limit: PAGE }
      ])
      .toArray();

  // 5 and 6: changing one customer's tier. Referencing writes one document; embedding writes every
  // order that carries a copy.
  const tiers = ['free', 'plus', 'pro', 'enterprise'];
  let flip = 0;
  const nextTier = () => tiers[flip++ % tiers.length];

  const typicalId = Math.floor(meta.customers / 2);
  const busiestId = meta.busiestCustomer;

  const refUpdate = (id) => () => customers.updateOne({ _id: id }, { $set: { tier: nextTier() } });
  const embUpdate = (id) => () =>
    ordersEmb.updateMany({ 'customer._id': id }, { $set: { 'customer.tier': nextTier() } });

  const typicalCount = await ordersEmb.countDocuments({ 'customer._id': typicalId });

  console.log(`\nserver ${meta.serverVersion}`);
  console.log(
    `${meta.orders.toLocaleString()} orders, ${meta.customers.toLocaleString()} customers, ` +
      `mean ${meta.meanOrdersPerCustomer} per customer`
  );
  console.log(`median of ${RUNS} runs after ${WARMUP} warm-up runs\n`);

  const rows = [];
  const add = async (label, fn) => {
    const r = await time(fn);
    rows.push([label, ms(r.median), ms(r.p95)]);
    process.stdout.write(`  ${label}\n`);
  };

  await add('Page read, embedded', embPage);
  await add('Page read, referenced ($lookup on indexed _id)', refPage);
  await add('Page read sorted on the joined field, embedded', embPageByTier);
  await add('Page read sorted on the joined field, referenced', refPageByTier);
  await add(`Update one customer, referenced (1 doc)`, refUpdate(typicalId));
  await add(`Update one customer, embedded (${typicalCount.toLocaleString()} docs)`, embUpdate(typicalId));
  await add(`Update busiest customer, referenced (1 doc)`, refUpdate(busiestId));
  await add(
    `Update busiest customer, embedded (${meta.busiestCount.toLocaleString()} docs)`,
    embUpdate(busiestId)
  );

  console.log('\n| Operation | Median | 95th |');
  console.log('|---|---|---|');
  for (const [a, b, c] of rows) console.log(`| ${a} | ${b} | ${c} |`);

  // The plan behind the read numbers, so a reader can check them instead of trusting them.
  console.log('\nPlan statistics');
  const stats = async (label, cursor) => {
    const e = await cursor.explain('executionStats');
    const s = e.executionStats ?? e.stages?.[0]?.$cursor?.executionStats;
    console.log(
      `  ${label}: nReturned ${s?.nReturned}, totalDocsExamined ${s?.totalDocsExamined}, ` +
        `executionTimeMillis ${s?.executionTimeMillis}`
    );
  };
  await stats('embedded page', ordersEmb.find(match).sort({ createdAt: -1 }).limit(PAGE));
  await stats('embedded page by tier', ordersEmb.find(match).sort({ 'customer.tier': 1, createdAt: -1 }).limit(PAGE));

  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
