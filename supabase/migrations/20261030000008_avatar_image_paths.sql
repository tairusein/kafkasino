-- =============================================================================
-- Kafkasino :: Step 2 / Migration 8 — avatar assets are shipped as JPG with the web app
-- =============================================================================
-- The registration screen renders avatars from the web app's /avatars/<id>.jpg (no network
-- dependency before sign-in). Keep the catalogue in sync with that.
update public.avatars
   set image_path = 'avatars/' || id || '.jpg';
