-- Daily-boss results (Wave 26). One row per user per UTC day.
-- Composite unique constraint enforces "one attempt per day" at the
-- database level — the app layer relies on this for anti-cheat.

create table if not exists daily_results (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  challenge_date  date not null,
  won             boolean not null,
  turns           int  not null default 0,
  hp_left         int  not null default 0,
  kos             int  not null default 0,
  created_at      timestamptz not null default now(),
  unique (user_id, challenge_date)
);

-- Leaderboard query path: winners first, fewer turns, more HP.
create index if not exists daily_results_day_idx on daily_results (challenge_date, won desc, turns asc, hp_left desc);
create index if not exists daily_results_user_idx on daily_results (user_id, challenge_date desc);
