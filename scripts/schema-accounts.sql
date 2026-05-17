-- Phase 3 schema additions: accounts, passkeys, collection, decks, matches.
-- Apply once, then never re-run unless wiping. All statements use IF NOT EXISTS
-- so re-applying is safe.

create extension if not exists "pgcrypto";

-- Users -------------------------------------------------------------------
create table if not exists users (
  id              uuid primary key default gen_random_uuid(),
  display_name    text not null,
  created_at      timestamptz not null default now(),
  last_seen       timestamptz not null default now(),
  trainer_ability text default 'brock'   -- the preferred Trainer ability
);
create index if not exists users_display_name_idx on users (lower(display_name));

-- Passkeys (WebAuthn credentials) -----------------------------------------
-- One user may register many passkeys (one per device). We store the raw
-- public key in cbor/cose form; libraries do the parsing.
create table if not exists passkeys (
  credential_id   text primary key,             -- base64url, from authenticator
  user_id         uuid not null references users(id) on delete cascade,
  public_key      text not null,                -- base64url encoded
  counter         bigint not null default 0,
  transports      text[],                       -- ["internal", "hybrid", ...]
  device_name     text,                         -- user-supplied label
  created_at      timestamptz not null default now(),
  last_used       timestamptz
);
create index if not exists passkeys_user_idx on passkeys (user_id);

-- Owned cards (collection) -------------------------------------------------
create table if not exists owned_cards (
  user_id     uuid not null references users(id) on delete cascade,
  pokemon_id  int  not null references pokemon(id) on delete cascade,
  quantity    int  not null default 1 check (quantity >= 0),
  acquired_at timestamptz not null default now(),
  primary key (user_id, pokemon_id)
);
create index if not exists owned_cards_user_idx on owned_cards (user_id);

-- Decks --------------------------------------------------------------------
-- card_ids is the literal 30-element list; duplicates allowed (≤2 each
-- enforced at the application layer).
create table if not exists decks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  name        text not null default 'Main Deck',
  card_ids    int[] not null,
  is_active   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists decks_user_idx on decks (user_id);
create unique index if not exists decks_one_active_per_user
  on decks (user_id) where is_active;

-- Matches ------------------------------------------------------------------
create table if not exists matches (
  id            uuid primary key default gen_random_uuid(),
  p1_user_id    uuid references users(id) on delete set null,  -- nullable for guest
  p2_user_id    uuid references users(id) on delete set null,
  winner_id     uuid references users(id) on delete set null,
  reason        text,                                          -- "ko" | "concede" | "disconnect"
  turns         int  not null default 0,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz
);
create index if not exists matches_p1_idx on matches (p1_user_id);
create index if not exists matches_p2_idx on matches (p2_user_id);

-- Aggregated stats view ----------------------------------------------------
create or replace view user_stats as
  select
    u.id                                                       as user_id,
    u.display_name,
    coalesce(played.cnt, 0)                                    as matches_played,
    coalesce(won.cnt, 0)                                       as wins,
    coalesce(played.cnt, 0) - coalesce(won.cnt, 0)             as losses,
    case when coalesce(played.cnt, 0) = 0 then 0.0
         else round(100.0 * coalesce(won.cnt, 0) / played.cnt, 1)
    end                                                        as win_pct,
    coalesce(owned.cnt, 0)                                     as cards_owned
  from users u
  left join (
    select user_id, count(*)::int as cnt from (
      select p1_user_id as user_id from matches where p1_user_id is not null
      union all
      select p2_user_id as user_id from matches where p2_user_id is not null
    ) m group by user_id
  ) played on played.user_id = u.id
  left join (
    select winner_id as user_id, count(*)::int as cnt
      from matches where winner_id is not null
      group by winner_id
  ) won on won.user_id = u.id
  left join (
    select user_id, count(*)::int as cnt
      from owned_cards group by user_id
  ) owned on owned.user_id = u.id;

-- Story-mode progress (Wave 20) -------------------------------------------
-- Tracks completed story chapters per user. Safe to add to existing users:
-- the column is nullable and defaults handled at app layer.
alter table users add column if not exists story_progress jsonb default '{"completed": []}'::jsonb;

-- Champion wins set (Wave 21+). Persists which champions a user has beaten.
-- Defaults to empty array. Used by achievements.js to gate champion_one /
-- champion_all unlocks.
alter table users add column if not exists champion_wins text[] default '{}';

-- Per-user per-day quest progress (Wave 23). Tracks solo + story match
-- counts since the matches table only covers multiplayer. Capped at the
-- last 14 days by the app layer to keep the row small.
alter table users add column if not exists quest_progress jsonb default '{}'::jsonb;

-- Player-to-player trading (Wave 25). One row per OPEN offer; closed
-- offers stay around as history but with status != 'open'. Atomic
-- accept-and-swap is gated by a SELECT FOR UPDATE in the route handler.
create table if not exists trade_offers (
  id                uuid primary key default gen_random_uuid(),
  offerer_user_id   uuid not null references users(id) on delete cascade,
  offered_pokemon_id int not null,
  wanted_pokemon_id  int not null,
  status            text not null default 'open',  -- open | accepted | cancelled | expired
  accepter_user_id  uuid references users(id) on delete set null,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null default now() + interval '24 hours',
  accepted_at       timestamptz,
  check (status in ('open', 'accepted', 'cancelled', 'expired')),
  check (offered_pokemon_id <> wanted_pokemon_id)
);
create index if not exists trade_offers_status_idx on trade_offers (status, created_at desc);
create index if not exists trade_offers_offerer_idx on trade_offers (offerer_user_id);
create index if not exists trade_offers_wanted_idx on trade_offers (wanted_pokemon_id) where status = 'open';
