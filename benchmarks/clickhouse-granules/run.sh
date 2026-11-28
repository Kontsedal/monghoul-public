#!/bin/sh
# Runs every query of the write-up against the tables that setup.sh built.
#
#   sh run.sh > results/run-100m.txt 2>&1
#
# For each query it prints the EXPLAIN indexes = 1 plan, then runs the query five times with the
# query condition cache off and a log_comment. At the end it reads the rows, the bytes and the
# times from system.query_log.
#
# It adds three data skipping indexes to blog.events as it goes, so run it one time on a fresh
# setup. CONTAINER names the Docker container (default ch-granules), DB the database (default blog).

CONTAINER="${CONTAINER:-ch-granules}"
DB="${DB:-blog}"
C="docker exec -i $CONTAINER clickhouse-client"

# A tag for this run, so a second run in the same server does not mix its log rows with the first.
RUN="g$(date +%s)"

q() {
  name="$1"; sql="$2"
  echo "=================== $name"
  echo "$sql"
  echo "--- plan"
  echo "EXPLAIN indexes = 1 $sql SETTINGS use_query_condition_cache = 0, use_skip_indexes_on_data_read = 0" | $C
  echo "--- result"
  for i in 1 2 3 4; do
    echo "$sql" | $C --use_query_condition_cache 0 --log_comment "$RUN-$name" >/dev/null
  done
  echo "$sql" | $C --use_query_condition_cache 0 --log_comment "$RUN-$name"
}

HOUR="event_time >= '2026-09-10 00:00:00' AND event_time < '2026-09-10 01:00:00'"
DAY="event_time >= '2026-09-10 00:00:00' AND event_time < '2026-09-11 00:00:00'"

echo "=================== tables"
$C --multiquery <<EOF
SELECT version();
SELECT table, name AS part, rows, marks FROM system.parts WHERE database = '$DB' AND active ORDER BY table, name FORMAT PrettyCompactMonoBlock;
SELECT countIf(rows_in_granule > 0) AS granules, count() AS marks FROM mergeTreeIndex('$DB', 'events');
EOF

# The primary key.
q one_tenant "SELECT avg(duration_ms) FROM $DB.events WHERE tenant_id = 42"
q tenant_and_day "SELECT avg(duration_ms) FROM $DB.events WHERE tenant_id = 42 AND $DAY"
q time_only "SELECT avg(duration_ms) FROM $DB.events WHERE $HOUR"
q time_only_by_type "SELECT avg(duration_ms) FROM $DB.events_by_type WHERE $HOUR"

# Columns outside the key, before any skipping index exists.
q user_no_index "SELECT avg(duration_ms) FROM $DB.events WHERE user_id = 42317"
q session_no_index "SELECT avg(duration_ms) FROM $DB.events WHERE session_id = 1124974"

# A function around a key column.
q tostring_42 "SELECT avg(duration_ms) FROM $DB.events WHERE toString(tenant_id) = '42'"
q tostring_7 "SELECT avg(duration_ms) FROM $DB.events WHERE toString(tenant_id) = '7'"
q tostring_420 "SELECT avg(duration_ms) FROM $DB.events WHERE toString(tenant_id) = '420'"
q modulo "SELECT avg(duration_ms) FROM $DB.events WHERE tenant_id % 1000 = 42"
q todate "SELECT avg(duration_ms) FROM $DB.events WHERE tenant_id = 42 AND toDate(event_time) = '2026-09-10'"

# Partitions.
q monthly_tenant_and_day "SELECT avg(duration_ms) FROM $DB.events_monthly WHERE tenant_id = 42 AND $DAY"
q monthly_time_only "SELECT avg(duration_ms) FROM $DB.events_monthly WHERE $HOUR"

# The count shortcut.
q count_range "SELECT count() FROM $DB.events WHERE tenant_id BETWEEN 100 AND 199"

echo "=================== query condition cache: default settings, three runs, no skipping index"
$C -q "SYSTEM DROP QUERY CONDITION CACHE"
for i in 1 2 3; do
  echo "SELECT avg(duration_ms) FROM $DB.events WHERE user_id = 42317" | $C --log_comment "$RUN-cache_run_$i" >/dev/null
done
echo "The plan after the three runs, default settings:"
echo "EXPLAIN indexes = 1 SELECT avg(duration_ms) FROM $DB.events WHERE user_id = 42317" | $C | grep "Granules"

echo "=================== what the kept granules are (time_only)"
$C --multiquery <<EOF
SELECT 'events' AS tbl, countIf(mn != mx) AS tenant_boundary, countIf(hit > 0) AS hold_the_hour, countIf(mn != mx OR hit > 0) AS either
FROM (SELECT intDiv(_part_offset, 8192) AS g, min(tenant_id) AS mn, max(tenant_id) AS mx, countIf($HOUR) AS hit
      FROM $DB.events GROUP BY g);
SELECT 'events_monthly, September' AS tbl, countIf(mn != mx) AS tenant_boundary, countIf(hit > 0) AS hold_the_hour, countIf(mn != mx OR hit > 0) AS either
FROM (SELECT intDiv(_part_offset, 8192) AS g, min(tenant_id) AS mn, max(tenant_id) AS mx, countIf($HOUR) AS hit
      FROM $DB.events_monthly WHERE _partition_id = '202609' GROUP BY g);
SELECT 'session_id = 1124974' AS tbl, count() AS matching_rows, uniqExact(intDiv(_part_offset, 8192)) AS granules_with_a_match
FROM $DB.events WHERE session_id = 1124974;
SELECT 'result rows' AS what,
       (SELECT count() FROM $DB.events WHERE tenant_id = 42) AS one_tenant,
       (SELECT count() FROM $DB.events WHERE tenant_id = 42 AND $DAY) AS tenant_and_day,
       (SELECT count() FROM $DB.events WHERE $HOUR) AS one_hour,
       (SELECT count() FROM $DB.events WHERE user_id = 42317) AS one_user;
EOF

echo "=================== minmax skipping indexes"
$C --multiquery <<EOF
ALTER TABLE $DB.events ADD INDEX idx_user user_id TYPE minmax GRANULARITY 1;
ALTER TABLE $DB.events ADD INDEX idx_session_mm session_id TYPE minmax GRANULARITY 1;
ALTER TABLE $DB.events MATERIALIZE INDEX idx_user SETTINGS mutations_sync = 2;
ALTER TABLE $DB.events MATERIALIZE INDEX idx_session_mm SETTINGS mutations_sync = 2;
SELECT name, type_full, formatReadableSize(data_compressed_bytes) AS size FROM system.data_skipping_indices WHERE database = '$DB' FORMAT PrettyCompactMonoBlock;
EOF
q user_minmax "SELECT avg(duration_ms) FROM $DB.events WHERE user_id = 42317"
q session_minmax "SELECT avg(duration_ms) FROM $DB.events WHERE session_id = 1124974"

echo "=================== Bloom filter skipping index"
$C --multiquery <<EOF
ALTER TABLE $DB.events DROP INDEX idx_session_mm;
ALTER TABLE $DB.events ADD INDEX idx_session_bf session_id TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE $DB.events MATERIALIZE INDEX idx_session_bf SETTINGS mutations_sync = 2;
SELECT name, type_full, formatReadableSize(data_compressed_bytes) AS size FROM system.data_skipping_indices WHERE database = '$DB' FORMAT PrettyCompactMonoBlock;
SELECT name AS column, formatReadableSize(data_compressed_bytes) AS compressed FROM system.columns WHERE database = '$DB' AND table = 'events' FORMAT PrettyCompactMonoBlock;
EOF
q session_bloom "SELECT avg(duration_ms) FROM $DB.events WHERE session_id = 1124974"

echo "=================== query_log"
$C --multiquery <<EOF
SYSTEM FLUSH LOGS;
SELECT
    replaceOne(log_comment, '$RUN-', '') AS name,
    min(q.read_rows) AS rows_read,
    formatReadableSize(min(q.read_bytes)) AS bytes_read,
    min(q.query_duration_ms) AS min_ms,
    median(q.query_duration_ms) AS median_ms,
    count() AS runs,
    min(q.ProfileEvents['SelectedMarks']) AS granules
FROM system.query_log AS q
WHERE q.type = 'QueryFinish' AND startsWith(q.log_comment, '$RUN-')
GROUP BY log_comment
ORDER BY min(q.event_time_microseconds)
FORMAT PrettyCompactMonoBlock;
EOF
