/**
 * Build four collections of the same orders, which differ only in how large each document is.
 *
 * Every collection holds the same `--docs` orders with the same `_id`, `customerId`, `status`,
 * `createdAt` and `total`, from one seed. What differs is a `history` array of events at the end of
 * each document, filled until the document reaches its target size: about 1, 4, 16 and 64 KB by
 * default (`--sizes`). A query that projects the small fields asks for exactly the same values from
 * all four, so any difference in its cost comes from the part of the document it did not ask for.
 *
 * The event notes are words drawn from a fixed vocabulary, so they compress about as well as real
 * free text does. A string of one repeated character would compress to almost nothing on disk and
 * hide the cost being measured.
 *
 *   node generate.mjs --uri mongodb://localhost:27017 --docs 50000
 */
import { BSON, MongoClient } from 'mongodb';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const URI = arg('uri', 'mongodb://localhost:27017');
const DB = arg('db', 'docsize_bench');
const DOCS = Number(arg('docs', 50_000));
const SIZES = (arg('sizes', '1,4,16,64') ?? '').split(',').map(Number);
const BATCH = 1_000;

/** One order a minute from this instant, so a window of N orders is a window of N minutes. */
const START = Date.UTC(2025, 0, 1);
const STEP = 60_000;

/** mulberry32. Small, fast, and identical everywhere, which is the whole requirement. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATUSES = ['shipped', 'paid', 'draft', 'refunded'];
const ACTORS = ['system', 'warehouse', 'support', 'courier', 'customer', 'billing'];
const WORDS = (
  'parcel left at the front door customer asked for a later delivery slot address updated after ' +
  'call courier could not find the building label printed again item out of stock replaced with ' +
  'the same model in blue refund requested for one item payment captured invoice sent by email ' +
  'tracking number changed package weighed again box damaged in transit photo attached warehouse ' +
  'moved the order to the next batch note from support customer prefers text messages gift wrap ' +
  'removed discount code applied after checkout delivery window confirmed signature required'
).split(' ');

const pick = (r, xs) => xs[Math.floor(r() * xs.length)];

/** The fields every query reads. Drawn from their own generator, so they match across sizes. */
function head(r, i) {
  return {
    _id: i,
    customerId: Math.floor(r() * 5_000),
    status: pick(r, STATUSES),
    createdAt: new Date(START + i * STEP),
    total: Math.round(r() * 50_000) / 100
  };
}

/**
 * Events until the document reaches `target` bytes, give or take 20% so the sizes are not all
 * identical. The size is added up per event rather than measured on the whole document each time,
 * because measuring a 64 KB document 500 times per document is the slow part of the run.
 */
function history(r, i, target) {
  const goal = target * (0.8 + r() * 0.4);
  const events = [];
  let size = 150;
  let at = START + i * STEP;
  while (size < goal) {
    at += Math.floor(r() * 3_600_000);
    const n = 6 + Math.floor(r() * 18);
    const words = [];
    for (let k = 0; k < n; k++) words.push(pick(r, WORDS));
    const event = { at: new Date(at), by: pick(r, ACTORS), note: words.join(' ') };
    events.push(event);
    size += BSON.calculateObjectSize({ e: event }) - 4;
  }
  return events;
}

async function main() {
  const client = new MongoClient(URI);
  await client.connect();
  const db = client.db(DB);
  const build = await db.admin().serverInfo();
  console.log(`server ${build.version}, ${DOCS.toLocaleString()} orders at ${SIZES.join(', ')} KB`);

  const meta = [];
  for (const kb of SIZES) {
    const name = `orders_${kb}k`;
    const coll = db.collection(name);
    await coll.drop().catch(() => {});

    // Same seed for the head in every collection, a different one for the history.
    const rHead = rng(7);
    const rBody = rng(1_000 + kb);
    let batch = [];
    for (let i = 0; i < DOCS; i++) {
      batch.push({ ...head(rHead, i), history: history(rBody, i, kb * 1024) });
      if (batch.length === BATCH) {
        await coll.insertMany(batch, { ordered: false });
        batch = [];
        process.stdout.write(`\r${name}: ${(i + 1).toLocaleString()} / ${DOCS.toLocaleString()}`);
      }
    }
    if (batch.length) await coll.insertMany(batch, { ordered: false });
    process.stdout.write(`\r${name}: ${DOCS.toLocaleString()} / ${DOCS.toLocaleString()}\n`);

    // One index, and it is the same in every collection. It holds both projected fields, so the
    // covered query in run.mjs can answer from it alone, and the other two queries use it to find
    // their documents.
    await coll.createIndex({ createdAt: 1, total: 1 });

    // Until a checkpoint writes the new data, collStats reports a storage size of 0.
    await db.admin().command({ fsync: 1 });
    const s =await db.command({ collStats: name });
    meta.push({
      name,
      targetKB: kb,
      docs: s.count,
      avgObjSize: s.avgObjSize,
      dataSizeMB: Math.round(s.size / 1e6),
      storageSizeMB: Math.round(s.storageSize / 1e6),
      indexSizeMB: Math.round((s.totalIndexSize / 1e6) * 10) / 10
    });
    console.log(JSON.stringify(meta.at(-1)));
  }

  await db
    .collection('_meta')
    .replaceOne(
      { _id: 'dataset' },
      {
        _id: 'dataset',
        serverVersion: build.version,
        docs: DOCS,
        start: new Date(START),
        stepMs: STEP,
        collections: meta,
        generatedAt: new Date()
      },
      { upsert: true }
    );
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
