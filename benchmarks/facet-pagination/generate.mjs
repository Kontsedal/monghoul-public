/**
 * Build the orders collection this benchmark paginates, from one seeded distribution.
 *
 * Seeded so the same `--docs` gives the same data on any machine. The documents are sized like a
 * real order list row, around 1 KB with line items and an address, because the cost this benchmark
 * is about is FETCHING documents, and a 100-byte toy document makes fetching look free.
 *
 *   node generate.mjs --uri mongodb://localhost:27017 --docs 2000000
 */
import { MongoClient } from 'mongodb';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const URI = arg('uri', 'mongodb://localhost:27017');
const DB = arg('db', 'facet_bench');
const DOCS = Number(arg('docs', 2_000_000));
const BATCH = 5_000;

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

/**
 * Weighted so that `shipped` is 60% of the collection. The run picks date windows inside `shipped`
 * that hold exactly 1,000 up to 1,000,000 documents, and 60% of two million is enough for the
 * largest one.
 */
const STATUSES = [
  ['shipped', 0.6],
  ['paid', 0.2],
  ['draft', 0.1],
  ['refunded', 0.1]
];
const COUNTRIES = ['GB', 'US', 'DE', 'FR', 'ES', 'PL', 'NL', 'IE'];
const CITIES = ['London', 'Austin', 'Berlin', 'Lyon', 'Valencia', 'Krakow', 'Utrecht', 'Cork'];
const PRODUCTS = [
  'Stainless steel water bottle',
  'Wireless keyboard, UK layout',
  'Cotton t-shirt, navy, medium',
  'USB-C charging cable, 2 m',
  'Ceramic pour-over coffee dripper',
  'Notebook, dotted, A5',
  'Running socks, pack of three',
  'Desk lamp with dimmer'
];

const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
const status = (r) => {
  let x = r();
  for (const [s, w] of STATUSES) {
    if ((x -= w) < 0) return s;
  }
  return STATUSES[0][0];
};

function order(r, i, start, span) {
  const cid = Math.floor(r() * 200_000);
  const country = pick(r, COUNTRIES);
  const items = [];
  const n = 2 + Math.floor(r() * 5);
  let total = 0;
  for (let k = 0; k < n; k++) {
    const qty = 1 + Math.floor(r() * 3);
    const price = Math.round(r() * 8000) / 100;
    total += qty * price;
    items.push({
      sku: `SKU-${String(Math.floor(r() * 1e6)).padStart(6, '0')}`,
      name: pick(r, PRODUCTS),
      qty,
      price
    });
  }
  return {
    _id: i,
    status: status(r),
    createdAt: new Date(start + Math.floor(r() * span)),
    total: Math.round(total * 100) / 100,
    customer: { _id: cid, name: `Customer ${cid}`, email: `customer${cid}@example.test` },
    shipping: {
      line1: `${1 + Math.floor(r() * 400)} Example Street`,
      city: pick(r, CITIES),
      postcode: String(Math.floor(r() * 99999)).padStart(5, '0'),
      country
    },
    items,
    // Free text of varying length, the way order notes are. It is what brings the mean document
    // to about 1 KB, and it is never read by any query here.
    notes: 'Leave with the neighbour if nobody answers. '.repeat(Math.floor(r() * 12))
  };
}

async function main() {
  const client = new MongoClient(URI);
  await client.connect();
  const db = client.db(DB);
  const build = await db.admin().serverInfo();

  console.log(`server ${build.version}, generating ${DOCS.toLocaleString()} orders`);
  await db.collection('orders').drop().catch(() => {});

  const r = rng(7);
  const start = Date.UTC(2024, 0, 1);
  const span = Date.UTC(2026, 8, 1) - start;

  let batch = [];
  for (let i = 0; i < DOCS; i++) {
    batch.push(order(r, i, start, span));
    if (batch.length === BATCH) {
      await db.collection('orders').insertMany(batch, { ordered: false });
      batch = [];
      if ((i + 1) % (BATCH * 20) === 0) {
        process.stdout.write(`\rorders: ${(i + 1).toLocaleString()} / ${DOCS.toLocaleString()}`);
      }
    }
  }
  if (batch.length) await db.collection('orders').insertMany(batch, { ordered: false });
  process.stdout.write(`\rorders: ${DOCS.toLocaleString()} / ${DOCS.toLocaleString()}\n`);

  // The one index a list screen needs: equality on status, then the sort key. Both approaches get
  // the same index, so neither can lose on a missing one.
  await db.collection('orders').createIndex({ status: 1, createdAt: -1 });
  console.log('index built: { status: 1, createdAt: -1 }');

  // Written down from the data rather than from the generator's counters, because the write-up
  // quotes these and the data is the better source.
  const stats = await db.command({ collStats: 'orders' });
  const shipped = await db.collection('orders').countDocuments({ status: 'shipped' });
  const doc = {
    _id: 'dataset',
    docs: stats.count,
    shipped,
    avgObjSize: stats.avgObjSize,
    dataSizeMB: Math.round(stats.size / 1e6),
    serverVersion: build.version,
    generatedAt: new Date()
  };
  await db.collection('_meta').replaceOne({ _id: 'dataset' }, doc, { upsert: true });
  console.log(JSON.stringify(doc, null, 2));
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
