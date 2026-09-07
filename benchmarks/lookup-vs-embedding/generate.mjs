/**
 * Build the two collection shapes this benchmark compares, from one seeded distribution.
 *
 * Seeded on purpose. Write cost in this comparison is a function of FAN OUT, not of row count: the
 * question "what does it cost to change one customer" is answered by how many orders carry a copy
 * of that customer, and that is a property of the distribution. An unseeded generator would produce
 * a different busiest customer on every machine and the write numbers would not be comparable.
 *
 *   node generate.mjs --uri mongodb://localhost:27017 --orders 1000000
 */
import { MongoClient } from 'mongodb';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const URI = arg('uri', 'mongodb://localhost:27017');
const DB = arg('db', 'lookup_bench');
const ORDERS = Number(arg('orders', 1_000_000));
const CUSTOMERS = Number(arg('customers', Math.max(1000, Math.floor(ORDERS / 50))));
const BATCH = 10_000;

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

const TIERS = ['free', 'plus', 'pro', 'enterprise'];
const COUNTRIES = ['GB', 'US', 'DE', 'FR', 'ES', 'PL', 'NL', 'IE'];
const STATUSES = ['draft', 'paid', 'shipped', 'refunded'];

/**
 * Which customer an order belongs to.
 *
 * Deliberately skewed rather than uniform. A uniform assignment gives every customer the same
 * number of orders, which makes the write comparison meaningless: the interesting figure is the
 * TAIL, and real data has one. This squares the random value, so low-numbered customers get
 * disproportionately many orders and customer 0 is the busiest.
 */
const pickCustomer = (r) => Math.floor(r() ** 2 * CUSTOMERS);

/**
 * Recompute the distribution from what is already in the database.
 *
 * `--stats-only` exists because the stats write is the LAST thing a six minute insert does, so a
 * bug there costs the whole run. It also lets the figures be re-derived from the data rather than
 * from the generator's own counters, which is the better provenance for something a write-up quotes.
 */
async function statsOnly(db, build) {
  const agg = await db
    .collection('orders_emb')
    .aggregate(
      [
        { $group: { _id: '$customer._id', n: { $sum: 1 } } },
        {
          $group: {
            _id: null,
            customers: { $sum: 1 },
            orders: { $sum: '$n' },
            busiestCount: { $max: '$n' }
          }
        }
      ],
      { allowDiskUse: true }
    )
    .next();

  const top = await db
    .collection('orders_emb')
    .aggregate(
      [
        { $group: { _id: '$customer._id', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 1 }
      ],
      { allowDiskUse: true }
    )
    .next();

  const doc = {
    _id: 'distribution',
    orders: agg.orders,
    customers: await db.collection('customers').estimatedDocumentCount(),
    customersWithOrders: agg.customers,
    busiestCustomer: top._id,
    busiestCount: top.n,
    meanOrdersPerCustomer: Math.round((agg.orders / agg.customers) * 10) / 10,
    serverVersion: build.version,
    generatedAt: new Date()
  };
  await db.collection('_meta').replaceOne({ _id: 'distribution' }, doc, { upsert: true });
  console.log(JSON.stringify(doc, null, 2));
}

async function main() {
  const client = new MongoClient(URI);
  await client.connect();
  const db = client.db(DB);

  const build = await db.admin().serverInfo();

  if (process.argv.includes('--stats-only')) {
    await statsOnly(db, build);
    await client.close();
    return;
  }

  console.log(`server ${build.version}, generating ${ORDERS.toLocaleString()} orders across ${CUSTOMERS.toLocaleString()} customers`);

  await Promise.all([
    db.collection('customers').drop().catch(() => {}),
    db.collection('orders_ref').drop().catch(() => {}),
    db.collection('orders_emb').drop().catch(() => {})
  ]);

  // Customers first, so the embedded copies are made from the same records.
  const cr = rng(1);
  const customers = [];
  for (let i = 0; i < CUSTOMERS; i++) {
    customers.push({
      _id: i,
      name: `Customer ${i}`,
      email: `customer${i}@example.test`,
      tier: TIERS[Math.floor(cr() * TIERS.length)],
      country: COUNTRIES[Math.floor(cr() * COUNTRIES.length)],
      // A field the read path never touches, so the embedded shape copies four fields and not the
      // whole document. Copying everything is how denormalising earns its bad reputation.
      notes: 'x'.repeat(200)
    });
  }
  for (let i = 0; i < customers.length; i += BATCH) {
    await db.collection('customers').insertMany(customers.slice(i, i + BATCH), { ordered: false });
  }
  console.log(`customers: ${CUSTOMERS.toLocaleString()}`);

  const or = rng(2);
  const start = Date.UTC(2024, 0, 1);
  const span = Date.UTC(2026, 8, 1) - start;
  const counts = new Array(CUSTOMERS).fill(0);

  let ref = [];
  let emb = [];
  for (let i = 0; i < ORDERS; i++) {
    const cid = pickCustomer(or);
    counts[cid]++;
    const c = customers[cid];
    const doc = {
      _id: i,
      status: STATUSES[Math.floor(or() * STATUSES.length)],
      total: Math.round(or() * 50000) / 100,
      createdAt: new Date(start + Math.floor(or() * span))
    };
    ref.push({ ...doc, customerId: cid });
    emb.push({
      ...doc,
      customer: { _id: cid, name: c.name, email: c.email, tier: c.tier, country: c.country }
    });

    if (ref.length === BATCH) {
      await db.collection('orders_ref').insertMany(ref, { ordered: false });
      await db.collection('orders_emb').insertMany(emb, { ordered: false });
      ref = [];
      emb = [];
      if ((i + 1) % (BATCH * 20) === 0) {
        process.stdout.write(`\rorders: ${(i + 1).toLocaleString()} / ${ORDERS.toLocaleString()}`);
      }
    }
  }
  if (ref.length) {
    await db.collection('orders_ref').insertMany(ref, { ordered: false });
    await db.collection('orders_emb').insertMany(emb, { ordered: false });
  }
  process.stdout.write(`\rorders: ${ORDERS.toLocaleString()} / ${ORDERS.toLocaleString()}\n`);

  // The indexes each query needs, in ESR order. The point of this benchmark is the shape of the
  // data, so neither side is allowed to lose on a missing index.
  await db.collection('orders_ref').createIndexes([
    { key: { status: 1, createdAt: -1 } },
    { key: { customerId: 1 } }
  ]);
  await db.collection('orders_emb').createIndexes([
    { key: { status: 1, createdAt: -1 } },
    { key: { 'customer._id': 1 } },
    { key: { status: 1, 'customer.tier': 1, createdAt: -1 } }
  ]);
  console.log('indexes built');

  // The distribution, written down, because run.mjs reports against it and the write-up quotes it.
  //
  // Looped rather than `Math.max(...counts)`. Spreading an array of 200,000 into a call blows the
  // stack, and it does it at the very END of a six minute insert, which is the worst possible place
  // to find out.
  let busiest = 0;
  let nonZero = 0;
  let sum = 0;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] > counts[busiest]) busiest = i;
    if (counts[i] > 0) {
      nonZero++;
      sum += counts[i];
    }
  }
  const mean = sum / nonZero;
  await db.collection('_meta').replaceOne(
    { _id: 'distribution' },
    {
      _id: 'distribution',
      orders: ORDERS,
      customers: CUSTOMERS,
      busiestCustomer: busiest,
      busiestCount: counts[busiest],
      meanOrdersPerCustomer: Math.round(mean * 10) / 10,
      serverVersion: build.version,
      generatedAt: new Date()
    },
    { upsert: true }
  );

  console.log(
    `distribution: mean ${Math.round(mean * 10) / 10} orders per customer, ` +
      `busiest is customer ${busiest} with ${counts[busiest].toLocaleString()}`
  );
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
