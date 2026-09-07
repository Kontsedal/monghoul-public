# $lookup against embedding

What referencing costs against embedding, on the same data, for the same reads and writes.

The accompanying write-up is at https://monghoul.com/blog/lookup-vs-embedding-measured/. It does not
publish a number this harness has not produced.

## Running it

Any MongoDB 6.0 or later will do, including a throwaway container:

```bash
docker run -d --name bench-mongo -p 27017:27017 mongo:8
```

Then:

```bash
node generate.mjs --uri mongodb://localhost:27017 --orders 10000000
node run.mjs      --uri mongodb://localhost:27017
```

`generate.mjs` is seeded, so the same `--orders` produces the same distribution on any machine,
including the same busiest customer. That is the part that makes the write numbers comparable:
write cost here is a function of fan-out, and fan-out is a property of the distribution rather than
of the row count.

`--orders` defaults to 1,000,000 because ten million takes a while to insert. Whatever you pass is
what `run.mjs` reports, and the write-up states the figure it was actually run at rather than a
round number.

## What it builds

Two shapes of the same information, in one database:

- **`orders_ref`** with `customerId`, plus a separate `customers` collection. Reading an order with
  its customer needs a `$lookup`.
- **`orders_emb`** where each order carries a `customer` subdocument holding the four fields the
  read path uses: name, email, tier, country.

Both get the indexes their queries need, and the `$lookup` runs against an indexed `_id`, which is
the best case for referencing rather than a strawman.

## What it measures

Four things, each the median of `--runs` timed passes after `--warmup` untimed ones:

1. **Page read.** Filter by status and a date range, sort by date, take 50. The read an order history
   screen makes.
2. **Page read sorted on the joined side.** The same, ordered by customer tier. This is the case that
   separates the two shapes, because `$lookup` output is not available to the planner when it picks
   an index.
3. **Update one customer.** One document against however many orders carry a copy.
4. **Update the busiest customer.** The tail of the same operation, which is the number that decides
   whether embedding is safe.

It prints `nReturned`, `totalDocsExamined` and `executionTimeMillis` alongside the wall clock, so the
read numbers can be checked against the plan rather than taken on trust.
