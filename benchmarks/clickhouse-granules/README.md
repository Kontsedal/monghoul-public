# ClickHouse granules and EXPLAIN indexes = 1

How many granules a ClickHouse query selects, and how many rows it then reads, for one query
written in different forms: a filter on the primary key, on its second column alone, on a column
outside the key, through a function, with data skipping indexes and with partitions.

The accompanying write-up is at https://monghoul.com/blog/clickhouse-granules-measured/. It does not
publish a number these scripts have not produced.

## Running it

The scripts need Docker and a POSIX shell. They talk to the server through `docker exec`, so no
port and no client on the host are necessary.

```bash
docker run -d --name ch-granules --ulimit nofile=262144:262144 \
  clickhouse/clickhouse-server:26.8.34.13

sh setup.sh
sh run.sh > results/run-100m.txt 2>&1
```

`setup.sh` builds three MergeTree tables in the database `blog`, each with the same 100,000,000
rows, and merges each with `OPTIMIZE FINAL`. It takes about one minute and 5 GB of disk.

| Table | Key |
|---|---|
| `events` | `ORDER BY (tenant_id, event_time)` |
| `events_by_type` | `ORDER BY (event_type, event_time)` |
| `events_monthly` | `PARTITION BY toYYYYMM(event_time) ORDER BY (tenant_id, event_time)` |

The rows come from `numbers()` and `cityHash64`, so every run builds the same data: 1,000 tenants
with 100,000 rows each, 90 days of times, user ids grouped by tenant, and a random `session_id`.

`run.sh` adds three data skipping indexes to `events` as it goes. Run it one time on a fresh
setup. To run it again, drop the database and run `setup.sh` first.

Three variables change the target: `CONTAINER` (default `ch-granules`), `DB` (default `blog`), and
for `setup.sh` also `ROWS` (default `100000000`).

## What it measures

For each query `run.sh` prints:

1. the plan from `EXPLAIN indexes = 1`, with `use_query_condition_cache = 0` and
   `use_skip_indexes_on_data_read = 0`, so the plan shows the indexes alone;
2. the result of the query, after five runs with the query condition cache off and a `log_comment`.

At the end it reads `system.query_log` and prints, for each query, the rows read, the bytes read,
the lowest and the median time of the five runs, and the granules selected.

It also prints three things the plans do not show:

- **The query condition cache.** One query with no index, run three times with the default
  settings. The first run reads every row, and the next runs skip the granules the first run found
  empty.
- **What the kept granules are.** For the one-hour filter with no tenant, a count of the granules
  that hold a tenant boundary and of the granules that hold a row of the hour.
- **The Bloom filter's false positives.** The count of granules that hold the tested `session_id`,
  to compare with the granules the index kept.

## The smaller run

The write-up quotes one plan from 10,000,000 rows, where a tenant covers little more than one
granule:

```bash
ROWS=10000000 DB=blog10m sh setup.sh
```

`results/time-only-10m.txt` is that plan.

## The published results

`results/` holds the output the write-up's numbers come from: ClickHouse 26.8.34.13 in Docker on a
Windows desktop with a Ryzen 7 9800X3D, on 28 November 2026.

| File | What it is |
|---|---|
| `setup-100m.txt` | The parts of the three tables after the build |
| `run-100m.txt` | Every plan, every result and the query log table |
| `setup-10m.txt` | The parts of the 10,000,000 row tables |
| `time-only-10m.txt` | The one-hour filter's plan on 10,000,000 rows |

The granule counts and the rows read are the same on every run, because the data is generated. The
times depend on the machine and move by a millisecond or two between runs.
