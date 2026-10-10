-- The machines each edge reads. config-api publishes the list retained on
-- denso/edges/{edge_id}/assignment; the edge follows it, so adding a machine
-- needs no change on the edge (EDGE_MACHINES is no longer required).
CREATE TABLE edge_assignment (
  edge_id     text        PRIMARY KEY,
  machine_ids text[]      NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL DEFAULT now()
);
