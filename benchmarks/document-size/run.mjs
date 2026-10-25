/**
 * Time one query that reads 1,000 orders, three ways, against documents of four sizes.
 *
 *   node run.mjs --uri mongodb://localhost:27017                 # warm: the same window each run
 *   node run.mjs --uri mongodb://localhost:27017 --mode random   # a random window each run
 *
 * The three ways:
 *
 * 1. Whole documents. No projection.
 * 2. A projection of two small fields, `createdAt` and `total`. This is the "proper projection" a
 *    code review asks for, and it still returns `_id`, so the server has to fetch each document.
 * 3. The same two fields with `_id: 0`. The index `{ createdAt: 1, total: 1 }` holds both, so the
 *    server can answer from the index alone. This is a covered query.
 *
 * Every collection holds the same 1,000 orders in the window with the same `createdAt` and `total`,
 * and the runner checks that all three ways return them before timing anything. A fast wrong answer
 * is not a result.
 *
 * Beside each timing it prints what the server did: the plan, the documents examined, the time the
 * server itself spent (from `opLatencies`, so the network and the driver are not in it), and the
 * bytes WiredTiger read into its cache from disk while the query ran.
 *
 * `--mode warm` reads the same window every run after `--warmup` untimed runs, so everything the
 * query reads is in the cache. `--mode random` reads a random window from the whole collection each
 * run, after 50 random warm-up runs. That is a working set the size of the collection: a cache that
 * holds the collection answers every run from memory, and a cache that holds a part of it does not.
 * Run it against a server with a small cache to see what that costs. The README has the settings.
 */
import { BSON, MongoClient } from 'mongodb';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const URI = arg('uri', 'mongodb://localhost:27017');
const DB = arg('db', 'docsize_bench');
const MODE = arg('mode', 'warm');
const RUNS = Number(arg('runs', 20));
const WARMUP = Number(arg('warmup', MODE === 'random' ? 50 : 5));
const MATCH = Number(arg('match', 1000));
const LABEL = arg('label', '');
const ONLY = arg('only', '');

if (MODE !== 'warm' && MODE !== 'random') throw new Error(`--mode is warm or random, not ${MODE}`);

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** Nearest rank: the smallest value with at least p of the sample at or below it. */
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(s.length * p) - 1)];
};
const ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : n >= 10 ? `${Math.round(n)} ms` : `${n.toFixed(1)} ms`);
const mb = (n) => (n >= 10e6 ? `${Math.round(n / 1e6)} MB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);

/** mulberry32, for a shuffle of the windows that is the same on every machine. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The plan's stages leaf first, and the keys and documents it examined. */
function planSummary(explain) {
  const stats = explain.executionStats;
  const stagesOf = (node) => {
    if (!node || typeof node !== 'object') return [];
    const kids = [node.inputStage, ...(node.inputStages ?? [])].flatMap(stagesOf);
    return typeof node.stage === 'string' ? [...kids, node.stage] : kids;
  };
  // The slot-based engine reports its own stage names under executionStages, and the classic
  // names under queryPlanner.winningPlan. The classic names are the ones people know.
  const winning = explain.queryPlanner?.winningPlan;
  return {
    keys: stats.totalKeysExamined,
    docs: stats.totalDocsExamined,
    stages: stagesOf(winning?.queryPlan ?? winning).join(' > ')
  };
}

async function main() {
  const client = new MongoClient(URI, { maxPoolSize: 4 });
  await client.connect();
  const db = client.db(DB);
  const admin = db.admin();

  const meta = await db.collection('_meta').findOne({ _id: 'dataset' });
  if (!meta) throw new Error('No _meta.dataset. Run generate.mjs first.');

  const slots = Math.floor(meta.docs / MATCH);
  /** The orders in window `k`, which holds exactly MATCH of them because there is one a minute. */
  const windowOf = (k) => ({
    createdAt: {
      $gte: new Date(meta.start.getTime() + k * MATCH * meta.stepMs),
      $lt: new Date(meta.start.getTime() + (k + 1) * MATCH * meta.stepMs)
    }
  });

  const status = async () => {
    const s = await admin.command({ serverStatus: 1 });
    return {
      latencyUs: s.opLatencies.reads.latency,
      readBytes: s.wiredTiger.cache['bytes read into cache'],
      cacheMax: s.wiredTiger.cache['maximum bytes configured'],
      cacheNow: s.wiredTiger.cache['bytes currently in the cache']
    };
  };

  const first = await status();
  console.log(`\nserver ${meta.serverVersion}, ${MODE} windows${LABEL ? `, ${LABEL}` : ''}`);
  console.log(`WiredTiger cache ${mb(first.cacheMax)}, ${mb(first.cacheNow)} in it at the start`);
  console.log(
    `${MATCH.toLocaleString()} orders per query, ` +
      (MODE === 'warm'
        ? `the same window each run, median of ${RUNS} runs after ${WARMUP} warm-up runs\n`
        : `a random window each run, median of ${RUNS} runs after ${WARMUP} random warm-up runs\n`)
  );

  const sort = { createdAt: 1 };
  const SHAPES = [
    { name: 'Whole documents', projection: undefined },
    { name: 'Projection, two fields', projection: { createdAt: 1, total: 1 } },
    { name: 'Covered by the index', projection: { _id: 0, createdAt: 1, total: 1 } }
  ];

  // The window the answer check, the explain and the warm mode read.
  const checkSlot = Math.floor(slots / 2);

  const rows = [];
  const collections = meta.collections.filter((c) => !ONLY || ONLY.split(',').includes(c.name));
  for (const c of collections) {
    const coll = db.collection(c.name);
    const query = (shape, k) => coll.find(windowOf(k), { projection: shape.projection }).sort(sort).toArray();

    // Same 1,000 rows from every shape, checked once before any timing.
    const answers = [];
    for (const s of SHAPES) answers.push(await query(s, checkSlot));
    const key = (docs) => docs.map((d) => `${d.createdAt.getTime()}:${d.total}`).join(',');
    for (const a of answers) {
      if (a.length !== MATCH || key(a) !== key(answers[0])) {
        throw new Error(`${c.name}: the shapes disagree (${a.length} rows against ${answers[0].length})`);
      }
    }
    console.log(
      `${c.name}: mean document ${c.avgObjSize.toLocaleString()} bytes, ${c.dataSizeMB} MB of data, ` +
        `${c.storageSizeMB} MB on disk. All three shapes return the same ${MATCH.toLocaleString()} rows.`
    );

    for (const [i, s] of SHAPES.entries()) {
      // One seed per shape, the same in every collection, so each collection sees the same windows.
      const r = rng(100 + i);
      const pickWindow = () => (MODE === 'warm' ? checkSlot : Math.floor(r() * slots));
      const returned = answers[i].reduce((n, d) => n + BSON.calculateObjectSize(d), 0);
      const plan = planSummary(await coll.find(windowOf(checkSlot), { projection: s.projection }).sort(sort).explain('executionStats'));

      for (let w = 0; w < WARMUP; w++) await query(s, pickWindow());
      const before = await status();
      const times = [];
      for (let run = 0; run < RUNS; run++) {
        const k = pickWindow();
        const t = process.hrtime.bigint();
        await query(s, k);
        times.push(Number(process.hrtime.bigint() - t) / 1e6);
      }
      const after = await status();

      const serverMs = (after.latencyUs - before.latencyUs) / RUNS / 1000;
      const readPerRun = (after.readBytes - before.readBytes) / RUNS;
      rows.push([
        `${c.targetKB} KB`,
        s.name,
        ms(median(times)),
        ms(pct(times, 0.95)),
        ms(serverMs),
        mb(readPerRun),
        mb(returned),
        plan.docs.toLocaleString(),
        plan.stages
      ]);
      console.log(`  ${s.name}: ${ms(median(times))}, server ${ms(serverMs)}, read ${mb(readPerRun)}`);
    }
  }

  const spread = RUNS >= 20 ? '95th' : 'Slowest';
  console.log(`\n| Document | Query | Median | ${spread} | Server, mean | Read into cache | Returned | Docs examined | Plan |`);
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const row of rows) console.log(`| ${row.join(' | ')} |`);
  const last = await status();
  console.log(`\n${mb(last.cacheNow)} in the WiredTiger cache after the run`);
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
