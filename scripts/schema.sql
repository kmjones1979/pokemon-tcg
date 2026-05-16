-- Pokémon TCG — Pokédex schema.
-- Paste this into your Supabase project's SQL editor (Project → SQL Editor → New query)
-- and click "Run" before running scripts/seed-pokedex.js.

create table if not exists pokemon (
  id           int primary key,           -- national dex number
  name         text not null,
  slug         text not null unique,
  types        text[] not null,           -- ["fire", "flying"]
  hp           int not null,
  attack       int not null,
  defense      int not null,
  sp_attack    int not null,
  sp_defense   int not null,
  speed        int not null,
  height_m     numeric,
  weight_kg    numeric,
  abilities    text[],
  sprite_front text,                      -- official artwork URL
  sprite_back  text,                      -- back sprite for animations
  cry_url      text,                      -- audio
  flavor_text  text,
  generation   int not null,
  is_legendary boolean default false,
  is_mythical  boolean default false
);

create index if not exists pokemon_generation_idx on pokemon (generation);
create index if not exists pokemon_types_gin on pokemon using gin (types);
