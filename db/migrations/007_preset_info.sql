-- What a preset is, beside its data (its hash and its sound stay). Apply once, before the deploy of the code that
-- reads it: psql "$DATABASE_URL" -f db/migrations/007_preset_info.sql
-- The presets saved before get their flags and names by scripts/presets/flags.mjs, their categories, tags and
-- features by scripts/presets/categorize.mjs (each a dry run without --apply).

ALTER TABLE presets
  -- slugs of the closed lists of libs/preset-schema (taxonomy.ts), checked there: a list grows without a migration
  ADD COLUMN category text,
  ADD COLUMN subcategory text,              -- one of its category, never without it
  ADD COLUMN description text,              -- plain text of the author, up to 280 characters
  ADD COLUMN tags text[] NOT NULL DEFAULT '{}',      -- up to 3
  ADD COLUMN features text[] NOT NULL DEFAULT '{}',  -- worked out of the data as it is saved (presetFeatures)
  ADD COLUMN factory boolean NOT NULL DEFAULT false,      -- a preset of the synth: cleanup keeps it
  ADD COLUMN ai_generated boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT presets_subcategory_check CHECK (subcategory IS NULL OR category IS NOT NULL);

-- the lists of a category (new first, its Popular), the search in descriptions, the filters of tags and features
CREATE INDEX ON presets (category, subcategory, created_at DESC, id DESC);
CREATE INDEX ON presets USING gin (description gin_trgm_ops);
CREATE INDEX ON presets USING gin (tags);
CREATE INDEX ON presets USING gin (features);
