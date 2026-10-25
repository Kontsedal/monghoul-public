# Document size and projection

What a query that reads two small fields costs as the documents around them grow from 1 KB to
64 KB, with a projection, without one, and as a covered query.

The accompanying write-up is at
https://monghoul.com/blog/projection-and-document-size-measured/. It does not publish a number this
harness has not produced.

## Running it

Any MongoDB 6.0 or later will do. Put the data on a named volume, because the small-cache run below
starts a second server on the same data:

```bash
docker run -d --name bench-mongo -p 27017:27017 -v bench-data:/data/db mongo:8.3.8
```

Then:

```bash
npm install
node generate.mjs --uri mongodb://localhost:27017 --docs 50000
node run.mjs      --uri mongodb://localhost:27017
node run.mjs      --uri mongodb://localhost:27017 --mode random
```

`generate.mjs` builds four collections, `orders_1k` to `orders_64k`, with `--docs` orders each.
The fields a query reads, `_id`, `customerId`, `status`, `createdAt` and `total`, come from one seed
and are identical in all four. A `history` array of events at the end of each document fills it to
about 1, 4, 16 or 64 KB (`--sizes`). The event notes are words from a fixed vocabulary, so they
compress about as well as real text. With 50,000 orders the four collections take about 4.4 GB in
memory and 1.8 GB on disk.

Each collection gets one index, `{ createdAt: 1, total: 1 }`.

## What it measures

There is one order a minute, so a window of `--match` minutes (default 1,000) holds exactly that
many orders. Each query reads one window, sorted by `createdAt`, three ways:

1. **Whole documents.** No projection.
2. **A projection of two fields**, `{ createdAt: 1, total: 1 }`. It returns `_id` too, so the
   server fetches each document.
3. **A covered query**, `{ _id: 0, createdAt: 1, total: 1 }`, which the index answers alone.

Before timing anything it checks that all three return the same rows. Beside each timing it prints:

- the median and the 95th percentile of `--runs` timed runs (default 20),
- the server's own time per query, from `serverStatus().opLatencies.reads`, as a mean,
- the bytes WiredTiger read into its cache per query, from `serverStatus().wiredTiger.cache`,
- the bytes returned, the documents examined and the plan.

`--mode warm` (the default) reads the same window every run after `--warmup` untimed runs
(default 5). `--mode random` reads a random window from the whole collection each run, after 50
random warm-up runs. `--only orders_64k` limits the run to the named collections.

## The small cache

`--mode random` against a large cache shows the same thing as `--mode warm`, because every
collection fits. To see what the document size costs when they do not, restart the server on the
same volume with a small cache and a memory limit. The memory limit matters: without it, the
operating system's file cache holds the data files and the "disk" reads come from memory.

```bash
docker rm -f bench-mongo
docker run -d --name bench-mongo -p 27017:27017 -v bench-data:/data/db --memory 1g \
  mongo:8.3.8 --wiredTigerCacheSizeGB 0.25
node run.mjs --uri mongodb://localhost:27017 --mode random --label "256 MB cache"
```

On Docker Desktop, files the first server read can stay in the Docker VM's file cache after it
stops. The published figures dropped that cache first, from a throwaway privileged container:

```bash
docker run --rm --privileged mongo:8.3.8 sh -c 'sync; echo 3 > /proc/sys/vm/drop_caches'
```

The timings in this mode depend on the disk and move between runs. The bytes read do not.
