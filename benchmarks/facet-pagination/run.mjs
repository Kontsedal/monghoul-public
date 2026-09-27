/**
 * Time one page of results with its total count, the three ways people write it.
 *
 *   node run.mjs --uri mongodb://localhost:27017 --runs 20 --warmup 5
 *   node run.mjs --uri mongodb://localhost:27017 --skip 10000     # a deep page instead of page 1
 *   node run.mjs --uri mongodb://localhost:27017 --size-check     # the 16 MB output limit
 *
 * Each result-set size is a window of the NEWEST shipped orders holding exactly that many
 * documents. So page 1 is the same 50 documents at every size, and the only thing that grows is
 * how much there is to count. That isolates the one variable this is about.
 *
 * Prints a markdown table, with the plan statistics beside each timing so it can be checked against
 * what the server examined rather than taken on trust. Before timing anything it checks that every
 * approach returns the same page and the same total, because a fast wrong answer is not a result.
 */
import { BSON, MongoClient } from 'mongodb';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const URI = arg('uri', 'mongodb://localhost:27017');
const DB = arg('db', 'facet_bench');
const RUNS = Number(arg('runs', 20));
const WARMUP = Number(arg('warmup', 5));
const PAGE = Number(arg('page', 50));
const SKIP = Number(arg('skip', 0));
const CAP = Number(arg('cap', 1000));
const LABEL = arg('label', '');
const SIZES = (arg('sizes', '1000,10000,100000,1000000') ?? '').split(',').map(Number);

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : n >= 10 ? `${Math.round(n)} ms` : `${n.toFixed(1)} ms`);

/** Warm up untimed, then time. A first run measures a cold cache, not the query. */
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

/**
 * What the server did, summed over every plan in an explain document.
 *
 * Walked rather than read from one fixed path, because the shape differs by command and by engine:
 * a find puts `executionStats` at the top, an aggregate may put it under `stages[0].$cursor`, and a
 * pipeline the slot-based engine takes whole puts it at the top again.
 */
function planSummary(explain) {
  const out = { keys: 0, docs: 0, stages: [] };
  // The query layer's stages, leaf first, which is the order they run in.
  const stagesOf = (node) => {
    if (!node || typeof node !== 'object') return [];
    const kids = [node.inputStage, ...(node.inputStages ?? []), node.innerStage, node.outerStage].flatMap(stagesOf);
    return typeof node.stage === 'string' ? [...kids, node.stage] : kids;
  };
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    for (const [k, v] of Object.entries(node)) {
      if (k === 'executionStats' && v && typeof v === 'object') {
        out.keys += v.totalKeysExamined ?? 0;
        out.docs += v.totalDocsExamined ?? 0;
        out.stages.push(...stagesOf(v.executionStages));
      } else if (k !== 'command') {
        walk(v);
      }
    }
  };
  walk(explain);
  // Then whatever the pipeline ran above the query layer, in pipeline order.
  for (const s of explain.stages ?? []) {
    const name = Object.keys(s).find((k) => k.startsWith('$'));
    if (name && name !== '$cursor') out.stages.push(name);
  }
  return out;
}

async function main() {
  const client = new MongoClient(URI, { maxPoolSize: 10 });
  await client.connect();
  const db = client.db(DB);
  const orders = db.collection('orders');

  const meta = await db.collection('_meta').findOne({ _id: 'dataset' });
  if (!meta) throw new Error('No _meta.dataset. Run generate.mjs first.');

  const sort = { createdAt: -1 };

  /** The newest `n` shipped orders, as a filter. */
  async function windowOf(n) {
    const [edge] = await orders
      .find({ status: 'shipped' }, { projection: { _id: 0, createdAt: 1 } })
      .sort(sort)
      .skip(n - 1)
      .limit(1)
      .toArray();
    return { status: 'shipped', createdAt: { $gte: edge.createdAt } };
  }

  // The three shapes, plus the two halves of the first one timed on their own.
  const shapes = (match) => {
    const page = () => orders.find(match).sort(sort).skip(SKIP).limit(PAGE).toArray();
    const count = () => orders.countDocuments(match);
    const capped = () => orders.countDocuments(match, { limit: CAP + 1 });
    const facetAfterSort = [
      { $match: match },
      { $sort: sort },
      { $facet: { data: [{ $skip: SKIP }, { $limit: PAGE }], total: [{ $count: 'n' }] } }
    ];
    const facetSortInside = [
      { $match: match },
      { $facet: { data: [{ $sort: sort }, { $skip: SKIP }, { $limit: PAGE }], total: [{ $count: 'n' }] } }
    ];
    // What countDocuments sends, so its plan can be explained. The driver builds exactly this.
    const countPipeline = [{ $match: match }, { $group: { _id: 1, n: { $sum: 1 } } }];
    const cappedPipeline = [{ $match: match }, { $limit: CAP + 1 }, { $group: { _id: 1, n: { $sum: 1 } } }];

    return [
      {
        name: 'Two queries, one after the other',
        run: async () => ({ data: await page(), total: await count() }),
        explain: async () => [
          await orders.find(match).sort(sort).skip(SKIP).limit(PAGE).explain('executionStats'),
          await orders.aggregate(countPipeline).explain('executionStats')
        ]
      },
      {
        name: 'Two queries, in parallel',
        run: async () => {
          const [data, total] = await Promise.all([page(), count()]);
          return { data, total };
        },
        explain: null
      },
      {
        name: '$facet after an indexed $sort',
        run: async () => {
          const [r] = await orders.aggregate(facetAfterSort).toArray();
          return { data: r.data, total: r.total[0]?.n ?? 0 };
        },
        explain: async () => [await orders.aggregate(facetAfterSort).explain('executionStats')]
      },
      {
        name: '$facet with $sort inside it',
        run: async () => {
          const [r] = await orders.aggregate(facetSortInside).toArray();
          return { data: r.data, total: r.total[0]?.n ?? 0 };
        },
        explain: async () => [await orders.aggregate(facetSortInside).explain('executionStats')]
      },
      {
        name: '  the page alone',
        run: async () => ({ data: await page(), total: null }),
        explain: async () => [await orders.find(match).sort(sort).skip(SKIP).limit(PAGE).explain('executionStats')]
      },
      {
        name: '  the count alone',
        run: async () => ({ data: null, total: await count() }),
        explain: async () => [await orders.aggregate(countPipeline).explain('executionStats')]
      },
      {
        name: `  the count, capped at ${CAP.toLocaleString()}`,
        run: async () => ({ data: null, total: await capped() }),
        explain: async () => [await orders.aggregate(cappedPipeline).explain('executionStats')]
      }
    ];
  };

  if (process.argv.includes('--size-check')) {
    await sizeCheck(orders, await windowOf(Math.min(100_000, meta.shipped)), sort);
    await client.close();
    return;
  }

  console.log(`\nserver ${meta.serverVersion}${LABEL ? `, ${LABEL}` : ''}`);
  console.log(
    `${meta.docs.toLocaleString()} orders, ${meta.shipped.toLocaleString()} shipped, ` +
      `mean document ${meta.avgObjSize} bytes, ${meta.dataSizeMB} MB of data`
  );
  console.log(`page of ${PAGE}, skip ${SKIP.toLocaleString()}, median of ${RUNS} runs after ${WARMUP} warm-up runs\n`);

  const rows = [];
  for (const size of SIZES.filter((s) => s <= meta.shipped)) {
    const match = await windowOf(size);
    const actual = await orders.countDocuments(match);
    const list = shapes(match);

    // Same page, same total, from every full shape. Checked once, before any timing.
    const answers = [];
    for (const s of list.slice(0, 4)) answers.push(await s.run());
    const ids = (a) => a.data.map((d) => d._id).join(',');
    for (const a of answers.slice(1)) {
      if (ids(a) !== ids(answers[0]) || a.total !== answers[0].total) {
        throw new Error(`the shapes disagree at ${size}: ${JSON.stringify({ a: a.total, b: answers[0].total })}`);
      }
    }
    console.log(`${actual.toLocaleString()} matching: all four shapes return the same ${PAGE} ids and total ${answers[0].total.toLocaleString()}`);

    for (const s of list) {
      const t = await time(s.run);
      let plan = { keys: '', docs: '', stages: '' };
      if (s.explain) {
        const sums = (await s.explain()).map(planSummary);
        plan = {
          keys: sums.reduce((n, x) => n + x.keys, 0).toLocaleString(),
          docs: sums.reduce((n, x) => n + x.docs, 0).toLocaleString(),
          stages: sums.map((x) => x.stages.join(' > ')).join(', then ')
        };
      }
      rows.push([actual.toLocaleString(), s.name, ms(t.median), ms(t.p95), plan.keys, plan.docs, plan.stages]);
      process.stdout.write(`  ${s.name.trim()}: ${ms(t.median)}\n`);
    }
  }

  console.log('\n| Matching | Approach | Median | 95th | Keys examined | Docs examined | Plan |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.join(' | ')} |`);
  await client.close();
}

/**
 * The 16 MB limit on `$facet` output. A page is one document when `$facet` returns it, so a page
 * that would be fine as a cursor fails as a facet. Asks for 20,000 documents both ways and reports
 * what came back.
 */
async function sizeCheck(orders, match, sort) {
  const N = 20_000;
  const viaFind = await orders.find(match).sort(sort).limit(N).toArray();
  const bytes = viaFind.reduce((n, d) => n + BSON.calculateObjectSize(d), 0);
  console.log(`find, limit ${N.toLocaleString()}: ${viaFind.length.toLocaleString()} documents, ${(bytes / 1048576).toFixed(1)} MiB of BSON`);
  try {
    const [r] = await orders
      .aggregate([
        { $match: match },
        { $sort: sort },
        { $facet: { data: [{ $limit: N }], total: [{ $count: 'n' }] } }
      ])
      .toArray();
    console.log(`$facet, limit ${N.toLocaleString()}: ${r.data.length.toLocaleString()} documents`);
  } catch (e) {
    console.log(`$facet, limit ${N.toLocaleString()}: failed, code ${e.code} ${e.codeName}`);
    console.log(`  ${e.message}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
