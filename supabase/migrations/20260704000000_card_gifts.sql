-- Player-to-player card gifting (Wave 30).
--
-- Unlike a trade_offer (which is a swap that another player accepts), a gift
-- is a one-way transfer: the sender gives N copies of a card straight into a
-- named recipient's collection. We log every gift so both parties get a
-- history, and the recipient gets an unseen-count badge on their Gifts tab.
--
-- Every statement is idempotent (`if not exists`) so re-running is safe.

create table if not exists card_gifts (
  id                 uuid primary key default gen_random_uuid(),
  sender_user_id     uuid not null references users(id) on delete cascade,
  recipient_user_id  uuid not null references users(id) on delete cascade,
  pokemon_id         int  not null,
  quantity           int  not null default 1,
  message            text,
  seen               boolean not null default false,
  created_at         timestamptz not null default now(),
  check (quantity >= 1 and quantity <= 99),
  check (sender_user_id <> recipient_user_id)
);

-- Recipient inbox (newest first) + unseen-count badge.
create index if not exists card_gifts_recipient_idx on card_gifts (recipient_user_id, created_at desc);
create index if not exists card_gifts_unseen_idx    on card_gifts (recipient_user_id) where seen = false;
-- Sender's "sent" history.
create index if not exists card_gifts_sender_idx    on card_gifts (sender_user_id, created_at desc);
