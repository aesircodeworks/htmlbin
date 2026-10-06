-- Global newest-first index for the homepage "recently published" feed.
--
-- drops already has (user_id, created_at DESC) for per-owner listings, but
-- nothing for a scan across every owner. The feed query is
--   WHERE title != '' AND password_hash IS NULL AND created_at >= ?
--   ORDER BY created_at DESC LIMIT 10
-- and runs at most once per 5-minute KV window.
--
-- Backward compatible and optional: the code works without it (just a
-- table scan), so this can be applied before or after the deploy.
--
-- Apply locally:  npm run db:migrate:local
-- Apply to prod:  npm run db:migrate:remote

CREATE INDEX IF NOT EXISTS idx_drops_created_at
  ON drops(created_at DESC);
