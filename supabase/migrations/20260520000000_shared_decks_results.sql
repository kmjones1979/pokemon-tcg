-- Friend Challenge result loop (Phase 2 / Wave 30).
--
-- shared_decks: when a user clicks "Share" on a deck, the encoded code +
-- their user id get registered so we can attribute results back to
-- them. Idempotent — same code from the same user is a no-op.
--
-- shared_deck_results: every time someone plays against a /v/<code>
-- challenge, the result lands here. Challengers can be anonymous; we
-- still record the row, just with NULL challenger_user_id.

create table if not exists shared_decks (
  code             text primary key,
  creator_user_id  uuid not null references users(id) on delete cascade,
  card_ids         int[] not null,
  created_at       timestamptz not null default now(),
  challenges_count int  not null default 0,
  wins_against     int  not null default 0,  -- creator's deck won → challenger lost
  losses_against   int  not null default 0   -- creator's deck lost → challenger won
);

create index if not exists shared_decks_creator_idx on shared_decks (creator_user_id, created_at desc);

create table if not exists shared_deck_results (
  id                   uuid primary key default gen_random_uuid(),
  deck_code            text not null references shared_decks(code) on delete cascade,
  challenger_user_id   uuid references users(id) on delete set null,
  challenger_anon_id   text,        -- best-effort anonymous id from localStorage
  challenger_name      text,        -- snapshot of challenger's display name at time of play
  won                  boolean not null,  -- did the challenger win?
  turns                int not null default 0,
  hp_left              int not null default 0,
  played_at            timestamptz not null default now()
);

create index if not exists shared_deck_results_code_idx on shared_deck_results (deck_code, played_at desc);
create index if not exists shared_deck_results_challenger_idx on shared_deck_results (challenger_user_id, played_at desc);
