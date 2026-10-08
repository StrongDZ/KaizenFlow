# query-api

Read-only REST API of the live monitoring UI. It reads PostgreSQL only: the
latest reading of a gauge comes from `gauge_reading`, because the UI needs the
flags and the window minimum and maximum, which Redis `latest:*` does not hold.

| Route | Answer |
| --- | --- |
| `GET /v1/live/stations` | Every station that has a config, with its gauges and their latest reading |
| `GET /v1/live/stations/{machine_id}` | One station, same shape; 404 without a config |
| `GET /v1/stations/{machine_id}/series?gauge=ID&minutes=15` | Trend of one gauge; `minutes` 1..240, at most 300 points (average value, lowest quality per bucket) |
| `GET /v1/stations/{machine_id}/history?gauge=ID&from=T&to=T` | History of one gauge between two RFC 3339 times (`to` defaults to now), at most 600 buckets, each with the average, the lowest and the highest value, the lowest quality and the number of readings. A range up to 7 days is answered from `gauge_reading` (`source: raw`), a longer one from `gauge_1m` (`source: 1m`, every reading with a value, quality null). `format=csv` gives the same as a file |
| `GET /v1/stations/{machine_id}/frame?camera=ID` | One frame of a camera of the station, from preview-svc (`frame_jpeg` base64, `width`, `height`); without `camera` the default one; 502 when the camera or preview-svc fails | `max_age=S` accepts a frame pulled in the last S seconds (at most 3600): the server keeps the last frame of every camera in memory and refreshes them in the background every `STILL_REFRESH` (default `5m`, `0` turns it off), so thumbnails answer at once; requests for the same camera share one pull

A station lists the ids of its cameras in `cameras` (the empty id is the default
camera) and every gauge carries the `camera_id` whose frame its `roi` is in. A
camera can serve several machines; its url never leaves the server.

| `GET /v1/stations/{machine_id}/live-frame?camera=ID` | Live view: the newest frame the edge sent for that camera, with what the edge read on that same frame. 404 `no live frame yet` until the first one arrives; 503 without `MQTT_BROKER` |

The edge sends numbers. An image only travels while somebody watches: every
call of `live-frame` keeps the edge sending previews of that machine for a few
seconds (MQTT `watch` and `preview`, SPEC section 3.2). The service keeps the
newest frame per camera in memory for 10 seconds and writes it nowhere. The
`frame` route is the fallback: the server pulls one frame from the camera
itself, which can be seconds away from the numbers on screen.

## Gauge and station state

The service computes the state the UI shows; the first rule that matches wins.

| State | Condition |
| --- | --- |
| `stale` | no reading in `LATEST_LOOKBACK`, or the latest one is older than `STALE_AFTER`, or it carries `FLAG_STALE` |
| `alarm` | `FLAG_OUT_OF_RANGE`, `FLAG_RATE_LIMIT` or `FLAG_NON_MONOTONIC` |
| `poor` | no value, quality below 0.7, or `FLAG_BLUR`, `FLAG_GLARE`, `FLAG_OCCLUDED`, `FLAG_FORMAT_INVALID`, `FLAG_ROI_DRIFT` |
| `ok` | otherwise |

The age that makes a reading stale follows how often the edge reports the
gauge (SPEC section 4.2): `STALE_AFTER` for a gauge reported in every window;
one minute more for a gauge with a deadband, which is repeated once a minute;
`report_interval_s` more for a counter that has one; and for a counter without
one, which is only reported when it changes, any reading still inside
`LATEST_LOOKBACK`.

A station is `offline` when none of its gauges has a recent reading, otherwise
it takes the worst state of its gauges: `alarm`, `poor`, `stale`, `ok`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | required | TimescaleDB; user and password through `PGUSER`, `PGPASSWORD` |
| `PREVIEW_URL` | `http://preview-svc:8080` | Where frames come from |
| `STALE_AFTER` | `30s` | Age after which a reading is stale (the `FLAG_STALE` threshold of the edge) |
| `LATEST_LOOKBACK` | `10m` | How far back the latest reading is searched; bounds the scan of the hypertable |
| `CORS_ALLOWED_ORIGIN` | `*` | Origin allowed to read the answers |
| `MQTT_BROKER` | unset | Broker of the live view; without it `live-frame` answers 503 and the rest works |
| `HTTP_ADDR` | `:8080` | Listen address; `/healthz` and `/metrics` as every service |

## Rules for readers of `gauge_reading` and `gauge_1m`

Every reader of these tables, this service included, must follow the two rules
of SPEC section 3.4:

1. **Order by `ts`, never by write order.** Rows are not written in `ts`
   order: data replayed from an edge buffer, resent on request, or overtaken
   during a broker or bridge failover arrives after newer rows. The
   continuous aggregate `gauge_1m` re-computes the last 2 hours, so it absorbs
   rows that are a few minutes late.
2. **Incremental readers use a cursor on `ingested_at`, not on `ts`, and
   deduplicate by primary key.** A reader that streams new rows (e.g. to
   Predict) and remembers the highest `ts` it has seen skips exactly the rows
   that arrive late. With a cursor on `ingested_at` it sees every row; because
   several rows can share one `ingested_at`, it re-reads the last instant and
   drops what it already has by `(machine_id, gauge_id, ts)`.

The `replayed` column marks rows that were late by design (buffer replay or
resend). A realtime row can still be late; `replayed = false` does not mean
"in order".

The streaming reader for Predict (rule 2) is not implemented yet.
