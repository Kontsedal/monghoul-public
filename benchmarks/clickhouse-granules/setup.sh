#!/bin/sh
# Builds the three test tables in a ClickHouse container.
#
#   sh setup.sh                              # 100,000,000 rows in database "blog"
#   ROWS=10000000 DB=blog10m sh setup.sh     # the smaller run the write-up quotes one time
#
# CONTAINER names the Docker container (default ch-granules).
set -e

CONTAINER="${CONTAINER:-ch-granules}"
DB="${DB:-blog}"
ROWS="${ROWS:-100000000}"

docker exec -i "$CONTAINER" clickhouse-client --multiquery <<EOF
CREATE DATABASE IF NOT EXISTS $DB;

CREATE TABLE $DB.events
(
    tenant_id   UInt32,
    event_time  DateTime,
    user_id     UInt64,
    event_type  LowCardinality(String),
    duration_ms UInt32,
    session_id  UInt64
)
ENGINE = MergeTree
ORDER BY (tenant_id, event_time);

INSERT INTO $DB.events
SELECT
    number % 1000 AS tenant_id,
    toDateTime('2026-08-01 00:00:00', 'UTC') + (cityHash64(number) % (90 * 86400)) AS event_time,
    (number % 1000) * 1000 + cityHash64(number, 1) % 1000 AS user_id,
    ['view', 'click', 'purchase', 'signup', 'refund'][cityHash64(number, 2) % 5 + 1] AS event_type,
    cityHash64(number, 3) % 10000 AS duration_ms,
    cityHash64(number, 4) % 50000000 AS session_id
FROM numbers($ROWS);

OPTIMIZE TABLE $DB.events FINAL;

CREATE TABLE $DB.events_by_type
(
    tenant_id   UInt32,
    event_time  DateTime,
    user_id     UInt64,
    event_type  LowCardinality(String),
    duration_ms UInt32,
    session_id  UInt64
)
ENGINE = MergeTree
ORDER BY (event_type, event_time);

INSERT INTO $DB.events_by_type SELECT * FROM $DB.events;
OPTIMIZE TABLE $DB.events_by_type FINAL;

CREATE TABLE $DB.events_monthly
(
    tenant_id   UInt32,
    event_time  DateTime,
    user_id     UInt64,
    event_type  LowCardinality(String),
    duration_ms UInt32,
    session_id  UInt64
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_time)
ORDER BY (tenant_id, event_time);

INSERT INTO $DB.events_monthly SELECT * FROM $DB.events;
OPTIMIZE TABLE $DB.events_monthly FINAL;

SELECT table, name AS part, rows, marks,
       formatReadableSize(bytes_on_disk) AS on_disk,
       formatReadableSize(primary_key_bytes_in_memory) AS primary_index
FROM system.parts
WHERE database = '$DB' AND active
ORDER BY table, name
FORMAT PrettyCompactMonoBlock;
EOF
