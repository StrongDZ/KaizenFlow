-- True for readings drained from the edge offline buffer or sent again after
-- a resend request. Lets consumers and the load tests tell late data apart.
ALTER TABLE gauge_reading ADD COLUMN replayed boolean NOT NULL DEFAULT false;
