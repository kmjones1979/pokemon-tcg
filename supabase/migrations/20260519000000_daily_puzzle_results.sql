-- Daily Puzzle results (Wave 27). One row per user per UTC day, like
-- daily_results. Leaderboard query: solved-first, then ascending moves.

create table if not exists daily_puzzle_results (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  challenge_date date not null,
  solved         boolean not null,
  moves_used     int not null default 0,
  created_at     timestamptz not null default now(),
  unique (user_id, challenge_date)
);

create index if not exists daily_puzzle_results_day_idx on daily_puzzle_results (challenge_date, solved desc, moves_used asc);
create index if not exists daily_puzzle_results_user_idx on daily_puzzle_results (user_id, challenge_date desc);
