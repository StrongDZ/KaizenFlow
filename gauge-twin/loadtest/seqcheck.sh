#!/usr/bin/env bash
# Compares the sequence log of edge-sim with the database.
# Needs psql on PATH and DATABASE_URL. Usage: seqcheck.sh <seq.jsonl>
#
# Expected in gauge_reading: every distinct (edge_id, seq) the broker
# acknowledged, except bad_schema messages, which must be in rejected_reading.
set -euo pipefail

LOG="${1:?usage: seqcheck.sh <seq.jsonl>}"
# SEQCHECK_PSQL: command that runs the SQL given on stdin (default: psql with
# DATABASE_URL). SEQCHECK_LOG_PATH: the log file as that psql sees it, when it
# runs somewhere else (e.g. inside the database container).
if [ -z "${SEQCHECK_PSQL:-}" ]; then
  : "${DATABASE_URL:?DATABASE_URL is required}"
  SEQCHECK_PSQL="psql $DATABASE_URL"
fi
LOG="${SEQCHECK_LOG_PATH:-$LOG}"

$SEQCHECK_PSQL -v ON_ERROR_STOP=1 -qAt <<SQL
CREATE TEMP TABLE seqlog_raw (line jsonb);
\copy seqlog_raw FROM '$LOG'
CREATE TEMP TABLE seqlog AS
SELECT line->>'edge_id' AS edge_id, (line->>'seq')::bigint AS seq, line->>'machine_id' AS machine_id,
       (line->>'window_end_ms')::bigint AS window_end_ms, line->>'fault' AS fault,
       (line->>'replayed')::boolean AS replayed, (line->>'acked')::boolean AS acked,
       (line->>'ts_ms')::bigint AS ts_ms
FROM seqlog_raw;
-- Only rows ingested during this run: earlier runs reuse the same edge ids.
CREATE TEMP TABLE run AS SELECT to_timestamp(min(ts_ms) / 1000.0) - interval '5 seconds' AS started FROM seqlog;
CREATE TEMP TABLE expected AS
SELECT DISTINCT edge_id, seq FROM seqlog WHERE acked AND fault <> 'bad_schema';
CREATE TEMP TABLE stored AS
SELECT DISTINCT edge_id, seq FROM gauge_reading, run
WHERE ingested_at >= run.started AND edge_id IN (SELECT DISTINCT edge_id FROM seqlog);

\echo == sequence log
SELECT 'acknowledged publishes: ' || count(*) FILTER (WHERE acked) || ', not acknowledged: ' || count(*) FILTER (WHERE NOT acked) FROM seqlog;
SELECT 'faults: ' || COALESCE(string_agg(fault || '=' || n, ', ' ORDER BY fault), 'none')
FROM (SELECT fault, count(*) AS n FROM seqlog WHERE acked AND fault <> '' GROUP BY fault) f;
SELECT 'replayed: ' || count(*) FROM seqlog WHERE acked AND replayed;

\echo == database
SELECT 'expected messages: ' || (SELECT count(*) FROM expected) || ', stored: ' || (SELECT count(*) FROM stored);
SELECT 'missing: ' || count(*) FROM (SELECT * FROM expected EXCEPT SELECT * FROM stored) m;
SELECT 'unexpected (stored but never acknowledged to the edge): ' || count(*) FROM (SELECT * FROM stored EXCEPT SELECT * FROM expected) u;
SELECT 'duplicate rows: ' || COALESCE(sum(n - 1), 0)
FROM (SELECT count(*) AS n FROM gauge_reading, run
      WHERE ingested_at >= run.started AND edge_id IN (SELECT DISTINCT edge_id FROM seqlog)
      GROUP BY machine_id, gauge_id, ts HAVING count(*) > 1) d;
SELECT 'bad_schema sent: ' || (SELECT count(*) FROM seqlog WHERE acked AND fault = 'bad_schema')
    || ', in rejected_reading: ' || (SELECT count(*) FROM rejected_reading, run WHERE rejected_at >= run.started AND reason = 'bad_schema');
SELECT 'out_of_range sent: ' || (SELECT count(DISTINCT (edge_id, seq)) FROM seqlog WHERE acked AND fault = 'out_of_range')
    || ', flagged in DB: ' || (SELECT count(DISTINCT (g.edge_id, g.seq)) FROM gauge_reading g, run
                               WHERE g.ingested_at >= run.started AND 4 = ANY (g.flags)
                                 AND (g.edge_id, g.seq) IN (SELECT edge_id, seq FROM seqlog WHERE fault = 'out_of_range'));
-- A replayed message is exempt from the clock check, so only skewed messages
-- that were delivered in real time are expected to carry the flag.
SELECT 'clock_skew sent in real time: ' || (SELECT count(DISTINCT (edge_id, seq)) FROM seqlog WHERE acked AND fault = 'clock_skew' AND NOT replayed)
    || ' (plus ' || (SELECT count(DISTINCT (edge_id, seq)) FROM seqlog WHERE acked AND fault = 'clock_skew' AND replayed) || ' replayed)'
    || ', flagged in DB: ' || (SELECT count(DISTINCT (g.edge_id, g.seq)) FROM gauge_reading g, run
                               WHERE g.ingested_at >= run.started AND 10 = ANY (g.flags)
                                 AND (g.edge_id, g.seq) IN (SELECT edge_id, seq FROM seqlog WHERE fault = 'clock_skew'));
SELECT 'readings without config (FLAG_NO_CONFIG): ' || count(*) FROM gauge_reading, run
WHERE ingested_at >= run.started AND 11 = ANY (flags) AND edge_id IN (SELECT DISTINCT edge_id FROM seqlog);

-- Out of order: a realtime reading stored after a newer reading of the same
-- gauge. Replayed data is late by design, and clock-skewed messages (flag 10)
-- carry a wrong timestamp on purpose; neither counts.
SELECT 'replayed rows: ' || count(*) FILTER (WHERE replayed) || ', out-of-order realtime rows: '
    || count(*) FILTER (WHERE NOT replayed AND NOT (10 = ANY (flags)) AND ts < newest_before)
FROM (SELECT g.replayed, g.flags, g.ts,
             max(g.ts) FILTER (WHERE NOT (10 = ANY (g.flags)))
               OVER (PARTITION BY g.machine_id, g.gauge_id ORDER BY g.ingested_at, g.ts
                     ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS newest_before
      FROM gauge_reading g, run
      WHERE g.ingested_at >= run.started AND g.edge_id IN (SELECT DISTINCT edge_id FROM seqlog)) o;

\echo == verdict
SELECT CASE WHEN (SELECT count(*) FROM (SELECT * FROM expected EXCEPT SELECT * FROM stored) m) = 0
            THEN 'PASS: every acknowledged message is in the database'
            ELSE 'FAIL: acknowledged messages are missing from the database' END;
SQL
