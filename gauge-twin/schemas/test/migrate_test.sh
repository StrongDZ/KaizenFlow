#!/usr/bin/env bash
# Migration test: up -> behaviour checks -> down -> up again.
# Needs `migrate` and `psql` on PATH and DATABASE_URL pointing at an empty
# TimescaleDB database.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
MIGRATIONS="$(cd "$(dirname "$0")/../sql" && pwd)"
LATEST=11

m() { migrate -path "$MIGRATIONS" -database "$DATABASE_URL" "$@"; }
q() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qAt -c "$1"; }

fail() { echo "FAIL: $*" >&2; exit 1; }
expect() { # expect <description> <expected> <actual>
  [ "$2" = "$3" ] || fail "$1: expected '$2', got '$3'"
  echo "ok: $1"
}

for _ in $(seq 1 60); do
  if psql "$DATABASE_URL" -qAt -c 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "== migrate up"
m up
expect "schema version" "$LATEST" "$(q 'SELECT version FROM schema_migrations')"
expect "schema not dirty" "f" "$(q 'SELECT dirty FROM schema_migrations')"

expect "hypertables" "gauge_reading" \
  "$(q "SELECT string_agg(hypertable_name, ',' ORDER BY hypertable_name)
        FROM timescaledb_information.hypertables WHERE hypertable_schema = 'public'")"
expect "auxiliary tables" "camera,camera_scan,edge_assignment,edge_node,gauge_candidate,gauge_sighting,machine,rejected_reading,station_config" \
  "$(q "SELECT string_agg(tablename, ',' ORDER BY tablename) FROM pg_tables
        WHERE schemaname = 'public' AND tablename IN ('machine', 'gauge', 'edge_node', 'station_config', 'rejected_reading', 'camera',
                                                      'gauge_candidate', 'camera_scan', 'gauge_sighting', 'edge_assignment')")"
expect "background policies" \
  "gauge_reading:policy_compression,policy_refresh_continuous_aggregate,gauge_reading:policy_retention" \
  "$(q "SELECT string_agg(concat_ws(':', h.hypertable_name, j.proc_name), ',' ORDER BY j.proc_name)
        FROM timescaledb_information.jobs j
        LEFT JOIN timescaledb_information.hypertables h
               ON h.hypertable_schema = j.hypertable_schema AND h.hypertable_name = j.hypertable_name
        WHERE j.proc_name IN ('policy_compression', 'policy_retention', 'policy_refresh_continuous_aggregate')
          AND (j.proc_name <> 'policy_retention' OR j.hypertable_schema = 'public')")"
expect "retention periods (readings, one-minute aggregate)" "30 days,2 years" \
  "$(q "SELECT string_agg(config ->> 'drop_after', ',' ORDER BY (config ->> 'drop_after')::interval)
        FROM timescaledb_information.jobs WHERE proc_name = 'policy_retention'")"

echo "== idempotent insert"
INSERT="INSERT INTO gauge_reading (ts, machine_id, gauge_id, value, v_min, v_max, n_frames, quality, flags, edge_id, seq)
        VALUES (date_trunc('minute', now()) - interval '10 minutes', 'M1', 'G1', 10, 9, 11, 2, 0.9, '{}', 'E1', 1)
        ON CONFLICT DO NOTHING"
q "$INSERT"
q "$INSERT"
expect "duplicate insert keeps one row" "1" "$(q 'SELECT count(*) FROM gauge_reading')"
expect "replayed defaults to false" "f" "$(q 'SELECT replayed FROM gauge_reading')"

echo "== gauge_1m quality filter"
q "INSERT INTO gauge_reading (ts, machine_id, gauge_id, value, v_min, v_max, quality, flags) VALUES
     (date_trunc('minute', now()) - interval '10 minutes' + interval '1 second', 'M1', 'G1', 30, 1, 99, 0.5, '{1}'),
     (date_trunc('minute', now()) - interval '10 minutes' + interval '2 seconds', 'M1', 'G1', NULL, 0, 0, 0.0, '{3}')"
q "CALL refresh_continuous_aggregate('gauge_1m', NULL, NULL)"
expect "gauge_1m row (avg_v|min_v|max_v|avg_v_all|n_good|n_all)" "10|9|11|20|1|2" \
  "$(q 'SELECT avg_v, min_v, max_v, avg_v_all, n_good, n_all FROM gauge_1m')"

echo "== rejected_reading"
REJECT="INSERT INTO rejected_reading (rejected_at, reason, kafka_topic, kafka_partition, kafka_offset, payload)
        VALUES (now(), 'bad_schema', 'gauge.telemetry', 3, 42, '\\x00ff')
        ON CONFLICT (kafka_topic, kafka_partition, kafka_offset) DO NOTHING"
q "$REJECT"
q "$REJECT"
expect "reprocessed record keeps one rejected row" "1" "$(q 'SELECT count(*) FROM rejected_reading')"
q "INSERT INTO rejected_reading (rejected_at, reason, kafka_topic, kafka_partition, kafka_offset)
   VALUES (now() - interval '31 days', 'bad_schema', 'gauge.telemetry', 3, 1)"
q "CALL purge_rejected_reading(0, '{}')"
expect "rows older than 30 days are purged" "1" "$(q 'SELECT count(*) FROM rejected_reading')"
expect "retention job is scheduled" "1" \
  "$(q "SELECT count(*) FROM timescaledb_information.jobs WHERE proc_name = 'purge_rejected_reading'")"

echo "== station_config and gauge view"
q "INSERT INTO station_config (machine_id, config_version, config) VALUES ('M1', 7,
   '{\"machine_id\": \"M1\", \"gauges\": [{\"gauge_id\": \"A\", \"type\": \"seg7\", \"unit\": \"V\"},
                                          {\"gauge_id\": \"B\", \"type\": \"analog_dial\"}]}')"
expect "gauge view lists the gauges of the config" "A:seg7:V:7,B:analog_dial::7" \
  "$(q "SELECT string_agg(concat_ws(':', gauge_id, type, unit, config_version), ',' ORDER BY gauge_id) FROM gauge")"
expect "edge_node.machine_ids defaults to empty" "0" \
  "$(q "INSERT INTO edge_node (edge_id) VALUES ('E1') RETURNING cardinality(machine_ids)")"

echo "== gauge_candidate"
expect "a new candidate is pending and seen once" "pending|1" \
  "$(q "INSERT INTO gauge_candidate (camera_id, roi, type, score) VALUES ('C1', '{1,2,30,40}', 'analog_dial', 0.4)
        RETURNING status || '|' || seen")"
if q "INSERT INTO gauge_candidate (camera_id, roi, type, score, status) VALUES ('C1', '{1,2,3,4}', 'seg7', 0.4, 'maybe')" 2>/dev/null; then
  fail "an unknown candidate status was accepted"
fi
echo "ok: unknown candidate status is refused"

echo "== migrate down"
m down -all
expect "no objects left" "0" \
  "$(q "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm') AND c.relname <> 'schema_migrations'")"

echo "== migrate up again"
m up
expect "schema version after re-up" "$LATEST" "$(q 'SELECT version FROM schema_migrations')"

echo "PASS: migrations"
