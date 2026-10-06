-- Monotonic per-drop version counter.
--
-- Before this, PUT minted `latest_version + 1`. Deleting the latest version
-- lowered latest_version, so the next PUT reused the deleted number: old
-- `?v=N` links silently showed new content and the per-version OG cache key
-- served a stale card. version_seq only ever grows.
--
-- PUT also uses it as an optimistic lock (UPDATE … WHERE version_seq = ?),
-- so two concurrent PUTs can no longer mint the same version number.
--
-- Backward compatible: code that predates this column ignores it, so this
-- can be applied before the code that uses it is deployed.
--
-- Apply locally:  npm run db:migrate:local
-- Apply to prod:  npm run db:migrate:remote

ALTER TABLE drops ADD COLUMN version_seq INTEGER NOT NULL DEFAULT 0;

UPDATE drops
   SET version_seq = MAX(
         latest_version,
         COALESCE((SELECT MAX(version) FROM versions v WHERE v.slug = drops.slug), 0)
       );
