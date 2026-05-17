-- Cumulative migration covering schema added during Waves 20-25.
-- Every statement is idempotent (`if not exists`) so re-running is safe.
--
-- Adds:
--   users.story_progress    (Wave 20) — completed story chapters per user
--   users.champion_wins     (Wave 21) — set of champion ids the user has beaten
--   users.quest_progress    (Wave 23) — per-day match/win/ko tallies for solo+story
--   trade_offers table      (Wave 25) — player-to-player card trading

-- Story-mode progress -----------------------------------------------------
alter table users add column if not exists story_progress jsonb default '{"completed": []}'::jsonb;

-- Champion wins set -------------------------------------------------------
alter table users add column if not exists champion_wins text[] default '{}';

-- Daily quest progress ----------------------------------------------------
-- jsonb keyed by UTC date string: { "2026-05-17": { matches, wins, kos } }
-- 14-day rolling window enforced in the app layer (server-modules/quests.js).
alter table users add column if not exists quest_progress jsonb default '{}'::jsonb;

-- Player-to-player trading ------------------------------------------------
create table if not exists trade_offers (
  id                 uuid primary key default gen_random_uuid(),
  offerer_user_id    uuid not null references users(id) on delete cascade,
  offered_pokemon_id int  not null,
  wanted_pokemon_id  int  not null,
  status             text not null default 'open',
  accepter_user_id   uuid references users(id) on delete set null,
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null default now() + interval '24 hours',
  accepted_at        timestamptz,
  check (status in ('open', 'accepted', 'cancelled', 'expired')),
  check (offered_pokemon_id <> wanted_pokemon_id)
);

create index if not exists trade_offers_status_idx   on trade_offers (status, created_at desc);
create index if not exists trade_offers_offerer_idx  on trade_offers (offerer_user_id);
create index if not exists trade_offers_wanted_idx   on trade_offers (wanted_pokemon_id) where status = 'open';
