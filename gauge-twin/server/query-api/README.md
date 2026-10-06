# query-api

Read API over `gauge_reading` and `gauge_1m` (not implemented yet). Every
reader of these tables, this service included, must follow the two rules of
SPEC section 3.4:

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
