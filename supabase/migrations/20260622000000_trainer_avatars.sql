-- Trainer-avatar persistence (added 2026-06-22).
-- Players pick an avatar that follows them across the leaderboard,
-- profile, battle screen, and Math Mode header. New avatars unlock
-- every 10 trainer levels (see server-modules/avatars.js for the
-- roster + tier math).
--
-- Idempotent — safe to re-run on environments that already have one
-- or both columns.

-- Selected avatar key (matches `key` in server-modules/avatars.js
-- ROSTER). Defaults to 'red' so existing rows render the Gen 1
-- starter without an extra round-trip.
alter table users add column if not exists selected_avatar text default 'red';

-- Set of avatar keys the user has unlocked. App layer is the source
-- of truth for what each key means; we don't constrain to enum here
-- because the roster expands over time.
alter table users add column if not exists unlocked_avatars text[] default '{red,leaf}';
