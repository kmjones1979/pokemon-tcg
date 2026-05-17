-- Card Mastery (Wave 30b). Per-user per-Pokémon kill-count + derived
-- mastery level. Level thresholds live in app code so they can be
-- retuned without a migration:
--   level 0:    0 KOs  (no badge)
--   level 1:    1 KO
--   level 2:    5 KOs
--   level 3:   15 KOs  (permanent +1 ATK on every instance of this card)

create table if not exists card_mastery (
  user_id     uuid not null references users(id) on delete cascade,
  pokemon_id  int  not null,
  kos         int  not null default 0,
  level       int  not null default 0,
  last_ko_at  timestamptz,
  primary key (user_id, pokemon_id)
);

create index if not exists card_mastery_user_idx on card_mastery (user_id, level desc, kos desc);
