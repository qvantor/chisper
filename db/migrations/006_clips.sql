-- Clips of the track, kept apart from the presets. Apply once: psql "$DATABASE_URL" -f db/migrations/006_clips.sql
-- gen_random_uuid() is built in since Postgres 13.

-- a loop of notes at its tempo, opened only by its link (?clip=<id>): no list, no search, no scores
CREATE TABLE clips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hash text UNIQUE NOT NULL,   -- sha256 of the normalized clip without its name (clipHash): the same notes are one clip
  name text,                   -- optional, not unique
  data jsonb NOT NULL,         -- the normalized clip without its name
  ip_hash text NOT NULL,
  edit_token_hash text,        -- sha256 of the secret edit token given to the author on create
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  opened_at timestamptz        -- the last time its link was opened (at most once a day), cleanup counts from it
);
-- "10 clips per hour per IP"
CREATE INDEX ON clips (ip_hash, created_at);
