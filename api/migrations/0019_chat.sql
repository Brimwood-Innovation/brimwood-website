-- 0019_chat.sql — audit/social/chat: member conversations (DMs + groups).
-- Conversations are members-only; every read/write enforces membership in
-- conversation_members. Read receipts are derived from last_read_at — no
-- per-message receipt rows. DMs have NULL title (the title is derived from
-- the other participant); group titles are member-set. message media lives in
-- the brimwood-media R2 bucket and is referenced by r2_key.
-- Additive: safe to apply on preview/prod via wrangler.

CREATE TABLE conversations (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('dm', 'group')),
  title       TEXT,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_conversations_created_by ON conversations(created_by);

CREATE TABLE conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  last_read_at    TEXT,
  joined_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (conversation_id, user_id)
);
CREATE INDEX idx_conversation_members_user ON conversation_members(user_id);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       TEXT NOT NULL REFERENCES users(id),
  body            TEXT NOT NULL DEFAULT '',
  r2_key          TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
