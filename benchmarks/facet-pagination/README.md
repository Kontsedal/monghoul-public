# $facet pagination against two queries

What one page of results with its total count costs, written the three ways people write it.

The accompanying write-up is at https://monghoul.com/blog/facet-pagination-measured/. It does not
publish a number this harness has not produced.

## Running it

Any MongoDB 6.0 or later will do, including a throwaway container:

```bash
docker run -d --name bench-mongo -p 27017:27017 mongo:8
```

Then:

```bash
npm install
node generate.mjs --uri mongodb://localhost:27017 --docs 2000000
node run.mjs      --uri mongodb://localhost:27017
node run.mjs      --uri mongodb://localhost:27017 --size-check
```

`generate.mjs` is seeded, so the same `--docs` produces the same collection on any machine. The
documents are about 900 bytes each, with line items, an address and a notes field, because the cost
being measured is fetching documents and a 100-byte toy document makes that look free. 60% of them
are `shipped`, so two million documents give 1.2 million to page through.

## What it measures

Each result-set size is a window of the NEWEST shipped orders holding exactly that many documents:
1,000, 10,000, 100,000 and 1,000,000 by default (`--sizes`). Page 1 is therefore the same 50
documents at every size, and the only thing that grows is how much there is to count.

At each size, the median and 95th percentile of `--runs` timed passes after `--warmup` untimed ones,
for:

1. **Two queries, one after the other.** `find().sort().skip().limit()`, then `countDocuments()`.
2. **Two queries, in parallel.** The same two, sent together with `Promise.all`.
3. **`$facet` after an indexed `$sort`.** `$match`, `$sort`, then `$facet` with a `data` branch
   (`$skip`, `$limit`) and a `total` branch (`$count`).
4. **`$facet` with `$sort` inside it.** The same, with the sort moved into the `data` branch.
5. The page alone, the count alone, and the count capped with `limit` (`--cap`, default 1,000).

Before timing anything it checks that shapes 1 to 4 return the same 50 ids and the same total. It
prints `totalKeysExamined`, `totalDocsExamined` and the plan stages beside every timing, so the
numbers can be checked against what the server did.

`--skip N` times a deep page instead of page 1. `--size-check` asks for 20,000 documents through
`find` and through `$facet`, which shows the 16 MB limit on `$facet` output.

## Adding network latency

On localhost a round trip costs almost nothing, and saving a round trip is the whole case for
`$facet`. To measure that case, put [Toxiproxy](https://github.com/Shopify/toxiproxy) in front of the
server and add latency in both directions:

```bash
docker run -d --name bench-toxiproxy -p 8474:8474 -p 27032:27032 ghcr.io/shopify/toxiproxy:2.12.0
curl -X POST localhost:8474/proxies \
  -d '{"name":"mongo","listen":"0.0.0.0:27032","upstream":"host.docker.internal:27017"}'
curl -X POST localhost:8474/proxies/mongo/toxics \
  -d '{"name":"down","type":"latency","stream":"downstream","attributes":{"latency":10}}'
curl -X POST localhost:8474/proxies/mongo/toxics \
  -d '{"name":"up","type":"latency","stream":"upstream","attributes":{"latency":10}}'

node run.mjs --uri "mongodb://localhost:27032/?directConnection=true" --label "20 ms round trip"
```

`host.docker.internal` is how a container reaches the host on Docker Desktop. On Linux, put both
containers on one network and use the server container's name instead.
