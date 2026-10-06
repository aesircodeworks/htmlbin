-- Owner-only drops.
--
-- 'public'  — anyone with the URL can view (the behavior before this column).
-- 'private' — only the owner, signed in with the GitHub account that owns
--             the drop, can view /p/<slug>, /raw and the per-drop OG card.
--             Private drops never appear in the homepage feed.
--
-- Backward compatible: every existing row becomes 'public', and code that
-- predates this column ignores it, so apply this BEFORE merging the code
-- that reads it (PR previews share production D1).
--
-- Apply locally:  npm run db:migrate:local
-- Apply to prod:  npm run db:migrate:remote

ALTER TABLE drops ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
