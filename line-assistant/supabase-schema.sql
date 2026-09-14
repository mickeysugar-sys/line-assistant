-- Conversation history: every message in either direction, for context on
-- both the webhook (replying) and future scheduled runs.
create table conversation_log (
  id uuid primary key default gen_random_uuid(),
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  line_user_id text not null,
  created_at timestamptz not null default now()
);

-- Items the scheduled check has flagged, so a later reply from Mark
-- ("did you handle X?") has something concrete to reference and close out.
create table flagged_items (
  id uuid primary key default gen_random_uuid(),
  summary text not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index idx_conversation_log_created_at on conversation_log (created_at desc);
create index idx_flagged_items_status on flagged_items (status);
