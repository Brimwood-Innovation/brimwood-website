/* Route tests: chat — membership enforcement, DMs/groups, threads, receipts. */
import { describe, it, expect } from "vitest";
import app from "./chat";
import { mockEnv, memberSession, postJSON } from "../test/helpers";
import type { MockEnv } from "../test/helpers";

interface FixtureUser {
  role: string;
  status: string;
  display_name?: string | null;
  name?: string | null;
  username?: string | null;
  avatar_key?: string | null;
}

interface Fixture {
  me: string;
  users: Record<string, FixtureUser>;
  /** "cid:uid" -> membership row */
  memberships: Record<string, { role: string; last_read_at: string | null; kind: string; title: string | null }>;
  /** existing DM id for the pair (me, other), or null */
  existingDm: string | null;
  convList: any[];
  participantRows: any[];
  messageRows: any[];
  receiptRows: { user_id: string; last_read_at: string | null }[];
  peopleRows: any[];
  storyTable: boolean;
  storyReplyRows: any[];
}

const USER = (over: Partial<FixtureUser> = {}): FixtureUser => ({
  role: "member",
  status: "active",
  display_name: "Ada",
  name: "Ada Lovelace",
  username: "ada",
  avatar_key: null,
  ...over,
});

function chatEnv(f: Partial<Fixture> = {}): { env: MockEnv; cookie: Record<string, string> } {
  const me = f.me ?? "member-1";
  const users: Record<string, FixtureUser> = f.users ?? {
    [me]: USER(),
    "member-2": USER({ display_name: "Bo", name: "Bo Chen", username: "bo" }),
    "member-3": USER({ display_name: "Cy", name: "Cy Rao", username: "cy" }),
  };
  const env = mockEnv();
  const cookie = memberSession(env, me);
  const prev = env.DB.handler;
  env.DB.handler = (sql: string, params: unknown[]) => {
    // readSession's users lookup (exact string from lib/auth).
    if (/^SELECT id, role, status FROM users WHERE id = \?$/.test(sql.trim())) {
      const u = users[params[0] as string];
      return u ? { row: { id: params[0], role: u.role, status: u.status } } : {};
    }
    // Conversation membership (every read/write gates on this).
    if (/FROM conversation_members cm\s+JOIN conversations/i.test(sql)) {
      const m = (f.memberships ?? {})[`${params[0]}:${params[1]}`];
      return m ? { row: m } : {};
    }
    // activeUser check.
    if (/SELECT id FROM users WHERE id = \? AND status = 'active'/i.test(sql)) {
      const u = users[params[0] as string];
      return u && u.status === "active" ? { row: { id: params[0] } } : {};
    }
    // Group member validation (users IN …).
    if (/FROM users WHERE id IN/i.test(sql)) {
      const rows = (params as string[])
        .filter((p) => users[p]?.status === "active")
        .map((p) => ({ id: p }));
      return { results: rows };
    }
    // Existing-DM lookup.
    if (/WHERE c\.kind = 'dm'/i.test(sql)) {
      return f.existingDm ? { row: { id: f.existingDm } } : {};
    }
    // Conversation list.
    if (/FROM conversations c/i.test(sql)) {
      return { results: f.convList ?? [] };
    }
    // Participants for listed conversations.
    if (/FROM conversation_members cm\s+JOIN users/i.test(sql)) {
      return { results: f.participantRows ?? [] };
    }
    // Cursor lookup for pagination.
    if (/SELECT created_at FROM messages WHERE id = \?/i.test(sql)) {
      return { row: { created_at: "2026-10-08T12:00:00.000Z" } };
    }
    // Thread messages.
    if (/FROM messages m/i.test(sql)) {
      return { results: f.messageRows ?? [] };
    }
    // Read receipts.
    if (/SELECT user_id, last_read_at FROM conversation_members/i.test(sql)) {
      return { results: f.receiptRows ?? [] };
    }
    // People directory search.
    if (/FROM users\s+WHERE status = 'active'/i.test(sql)) {
      return { results: f.peopleRows ?? [] };
    }
    // story_replies feature detection.
    if (/sqlite_master/i.test(sql)) {
      return f.storyTable ? { row: { name: "story_replies" } } : {};
    }
    if (/FROM story_replies/i.test(sql)) {
      return { results: f.storyReplyRows ?? [] };
    }
    return prev?.(sql, params);
  };
  return { env, cookie };
}

const getJSON = (app: any, path: string, env: MockEnv, cookie: Record<string, string>) =>
  app.request(path, { method: "GET", headers: { ...cookie } }, env);

describe("chat auth", () => {
  it("requires sign-in on the conversation list", async () => {
    const env = mockEnv();
    const res = await app.request("/conversations", { method: "GET" }, env);
    expect(res.status).toBe(401);
  });

  it("requires sign-in on story replies", async () => {
    const env = mockEnv();
    const res = await app.request("/story-replies", { method: "GET" }, env);
    expect(res.status).toBe(401);
  });
});

describe("GET /chat/conversations", () => {
  const convList = [
    {
      id: "c1",
      kind: "dm",
      title: null,
      last_body: "See you Friday",
      last_r2: null,
      last_at: "2026-10-08T14:00:00.000Z",
      last_sender_name: "Bo",
      last_sender_real: "Bo Chen",
      unread: 2,
    },
    {
      id: "c2",
      kind: "group",
      title: "Forge crew",
      last_body: null,
      last_r2: "chat-abc.mp4",
      last_at: "2026-10-07T09:00:00.000Z",
      last_sender_name: null,
      last_sender_real: null,
      unread: 0,
    },
  ];
  const participantRows = [
    { cid: "c1", id: "member-1", display_name: "Ada", name: "Ada Lovelace", username: "ada", avatar_key: null },
    { cid: "c1", id: "member-2", display_name: "Bo", name: "Bo Chen", username: "bo", avatar_key: "a1.png" },
    { cid: "c2", id: "member-1", display_name: "Ada", name: "Ada Lovelace", username: "ada", avatar_key: null },
    { cid: "c2", id: "member-2", display_name: "Bo", name: "Bo Chen", username: "bo", avatar_key: null },
    { cid: "c2", id: "member-3", display_name: null, name: "Cy Rao", username: "cy", avatar_key: null },
  ];

  it("lists conversations with participants, previews, and unread counts", async () => {
    const { env, cookie } = chatEnv({ convList, participantRows });
    const res = await getJSON(app, "/conversations", env, cookie);
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.ok).toBe(true);
    expect(d.conversations).toHaveLength(2);
    const dm = d.conversations[0];
    expect(dm.title).toBe("Bo"); // DM title derives from the other participant
    expect(dm.unread).toBe(2);
    expect(dm.last_message.preview).toBe("See you Friday");
    expect(dm.participants).toHaveLength(2);
    expect(dm.participants[1].avatar_url).toBe("/api/media/a1.png");
    const group = d.conversations[1];
    expect(group.title).toBe("Forge crew");
    expect(group.member_count).toBe(3);
    expect(group.last_message.preview).toBe("Sent a video.");
    // Anonymous by default: no emails, no real names in participant cards.
    for (const cv of d.conversations) {
      for (const p of cv.participants) {
        expect(p).not.toHaveProperty("email");
        expect(p).not.toHaveProperty("name");
      }
    }
    // Initials fallback when display_name is unset ("Cy Rao" -> "C.").
    expect(group.participants[2].display_name).toBe("C.");
  });

  it("returns an empty list when the member has no conversations", async () => {
    const { env, cookie } = chatEnv();
    const res = await getJSON(app, "/conversations", env, cookie);
    const d = await res.json();
    expect(d.conversations).toEqual([]);
  });
});

describe("POST /chat/conversations", () => {
  it("creates a DM between two members", async () => {
    const { env, cookie } = chatEnv();
    const res = await postJSON(app, "/conversations", { kind: "dm", user_id: "member-2" }, env, cookie);
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.ok).toBe(true);
    expect(d.conversation.kind).toBe("dm");
    const convs = env.DB.inserts.get("conversations") ?? [];
    expect(convs).toHaveLength(1);
    expect(convs[0].kind).toBe("dm");
    // The two-row INSERT is one statement; both members must be bound.
    const ins = env.DB.calls.find(
      (cl) => cl.op === "run" && /INSERT INTO conversation_members/i.test(cl.sql)
    );
    expect(ins?.params).toContain("member-1");
    expect(ins?.params).toContain("member-2");
  });

  it("returns the existing DM instead of duplicating it", async () => {
    const { env, cookie } = chatEnv({ existingDm: "dm-9" });
    const res = await postJSON(app, "/conversations", { kind: "dm", user_id: "member-2" }, env, cookie);
    const d = await res.json();
    expect(d.ok).toBe(true);
    expect(d.conversation.id).toBe("dm-9");
    expect(d.existing).toBe(true);
    expect(env.DB.inserts.get("conversations") ?? []).toHaveLength(0);
  });

  it("rejects a DM with yourself or an unavailable member", async () => {
    const { env, cookie } = chatEnv();
    const self = await postJSON(app, "/conversations", { kind: "dm", user_id: "member-1" }, env, cookie);
    expect(self.status).toBe(400);
    const gone = await postJSON(app, "/conversations", { kind: "dm", user_id: "member-9" }, env, cookie);
    expect(gone.status).toBe(400);
  });

  it("rejects a DM with a suspended member", async () => {
    const users = { "member-1": USER(), "member-2": USER({ status: "suspended" }) };
    const { env, cookie } = chatEnv({ users });
    const res = await postJSON(app, "/conversations", { kind: "dm", user_id: "member-2" }, env, cookie);
    expect(res.status).toBe(400);
  });

  it("creates a group with the creator as admin", async () => {
    const { env, cookie } = chatEnv();
    const res = await postJSON(
      app,
      "/conversations",
      { kind: "group", user_ids: ["member-2", "member-3"], title: "Forge crew" },
      env,
      cookie
    );
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.conversation.kind).toBe("group");
    expect(d.conversation.title).toBe("Forge crew");
    const members = env.DB.inserts.get("conversation_members") ?? [];
    const admin = members.find((m) => m.user_id === "member-1");
    expect(admin?.role).toBe("admin");
  });

  it("rejects a group with fewer than two others", async () => {
    const { env, cookie } = chatEnv();
    const res = await postJSON(app, "/conversations", { kind: "group", user_ids: ["member-2"] }, env, cookie);
    expect(res.status).toBe(400);
  });

  it("rejects an unknown kind", async () => {
    const { env, cookie } = chatEnv();
    const res = await postJSON(app, "/conversations", { kind: "channel", user_ids: ["member-2", "member-3"] }, env, cookie);
    expect(res.status).toBe(400);
  });
});

describe("GET /chat/conversations/:id/messages", () => {
  const mem = {
    "c1:member-1": { role: "member", last_read_at: "2026-10-08T13:00:00.000Z", kind: "dm", title: null },
  };
  const messageRows = [
    // D1 returns ORDER BY created_at DESC; the route reverses to chronological.
    {
      id: "m2", sender_id: "member-1", body: "", r2_key: "chat-x.jpg",
      created_at: "2026-10-08T13:35:00.000Z",
      display_name: "Ada", name: "Ada Lovelace", username: "ada", avatar_key: null,
    },
    {
      id: "m1", sender_id: "member-2", body: "Hey", r2_key: null,
      created_at: "2026-10-08T13:30:00.000Z",
      display_name: "Bo", name: "Bo Chen", username: "bo", avatar_key: null,
    },
  ];
  const receiptRows = [
    { user_id: "member-1", last_read_at: "2026-10-08T13:00:00.000Z" },
    { user_id: "member-2", last_read_at: "2026-10-08T13:40:00.000Z" },
  ];

  it("returns the thread with sender cards, media urls, and read receipts", async () => {
    const { env, cookie } = chatEnv({ memberships: mem, messageRows, receiptRows });
    const res = await getJSON(app, "/conversations/c1/messages", env, cookie);
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.ok).toBe(true);
    expect(d.messages).toHaveLength(2);
    expect(d.messages[0].mine).toBe(false);
    expect(d.messages[0].sender.display_name).toBe("Bo");
    expect(d.messages[1].media_url).toBe("/api/media/chat-x.jpg");
    expect(d.messages[1].is_video).toBe(false);
    // Bo read everything (last_read_at after my latest message) → "Seen".
    expect(d.read_receipts["member-2"]).toBe("2026-10-08T13:40:00.000Z");
  });

  it("returns 404 for a non-member (no leak)", async () => {
    const { env, cookie } = chatEnv({ messageRows, receiptRows });
    const res = await getJSON(app, "/conversations/c1/messages", env, cookie);
    expect(res.status).toBe(404);
    const d = await res.json();
    expect(d.error).toBe("Conversation not found.");
  });

  it("rejects an invalid cursor", async () => {
    const { env, cookie } = chatEnv({ memberships: mem, messageRows, receiptRows });
    const prev = env.DB.handler;
    env.DB.handler = (sql: string, params: unknown[]) => {
      if (/SELECT created_at FROM messages WHERE id = \?/i.test(sql)) return {};
      return prev?.(sql, params);
    };
    const res = await getJSON(app, "/conversations/c1/messages?cursor=nope", env, cookie);
    expect(res.status).toBe(400);
  });
});

describe("POST /chat/conversations/:id/messages", () => {
  const mem = {
    "c1:member-1": { role: "member", last_read_at: null, kind: "dm", title: null },
  };

  it("sends a text message as a member", async () => {
    const { env, cookie } = chatEnv({ memberships: mem });
    const res = await postJSON(app, "/conversations/c1/messages", { body: "Hello there" }, env, cookie);
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.ok).toBe(true);
    expect(d.message.body).toBe("Hello there");
    const msgs = env.DB.inserts.get("messages") ?? [];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].conversation_id).toBe("c1");
    expect(msgs[0].sender_id).toBe("member-1");
  });

  it("returns 404 when a non-member tries to send", async () => {
    const { env, cookie } = chatEnv();
    const res = await postJSON(app, "/conversations/c1/messages", { body: "Hello there" }, env, cookie);
    expect(res.status).toBe(404);
    expect(env.DB.inserts.get("messages") ?? []).toHaveLength(0);
  });

  it("rejects empty messages", async () => {
    const { env, cookie } = chatEnv({ memberships: mem });
    const res = await postJSON(app, "/conversations/c1/messages", { body: "   " }, env, cookie);
    expect(res.status).toBe(400);
  });

  it("uploads media to R2 and stores the key", async () => {
    const { env, cookie } = chatEnv({ memberships: mem });
    const form = new FormData();
    form.set("body", "");
    form.set("file", new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" }));
    const res = await app.request(
      "/conversations/c1/messages",
      { method: "POST", headers: { ...cookie }, body: form },
      env
    );
    expect(res.status).toBe(200);
    const d: any = await res.json();
    expect(d.message.media_url).toMatch(/^\/api\/media\/chat-.*\.png$/);
    const msgs = env.DB.inserts.get("messages") ?? [];
    expect(String(msgs[0].r2_key)).toMatch(/^chat-.*\.png$/);
  });

  it("rejects disallowed file types", async () => {
    const { env, cookie } = chatEnv({ memberships: mem });
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1])], "run.exe", { type: "application/x-msdownload" }));
    const res = await app.request(
      "/conversations/c1/messages",
      { method: "POST", headers: { ...cookie }, body: form },
      env
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /chat/conversations/:id/read", () => {
  it("bumps last_read_at for a member", async () => {
    const mem = {
      "c1:member-1": { role: "member", last_read_at: null, kind: "dm", title: null },
    };
    const { env, cookie } = chatEnv({ memberships: mem });
    const res = await postJSON(app, "/conversations/c1/read", {}, env, cookie);
    expect(res.status).toBe(200);
    const updates = env.DB.calls.filter((cl) => cl.op === "run" && /UPDATE conversation_members/i.test(cl.sql));
    expect(updates).toHaveLength(1);
    expect(updates[0].params).toContain("c1");
    expect(updates[0].params).toContain("member-1");
  });

  it("returns 404 for a non-member", async () => {
    const { env, cookie } = chatEnv();
    const res = await postJSON(app, "/conversations/c1/read", {}, env, cookie);
    expect(res.status).toBe(404);
  });
});

describe("POST /chat/conversations/:id/members", () => {
  const adminMem = {
    "g1:member-1": { role: "admin", last_read_at: null, kind: "group", title: "Forge crew" },
  };
  const plainMem = {
    "g1:member-1": { role: "member", last_read_at: null, kind: "group", title: "Forge crew" },
  };
  const dmMem = {
    "c1:member-1": { role: "member", last_read_at: null, kind: "dm", title: null },
  };

  it("lets a group admin add a member", async () => {
    const { env, cookie } = chatEnv({ memberships: adminMem });
    const res = await postJSON(app, "/conversations/g1/members", { action: "add", user_id: "member-3" }, env, cookie);
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.added).toBe("member-3");
  });

  it("lets a group admin remove a member", async () => {
    const { env, cookie } = chatEnv({ memberships: adminMem });
    const res = await postJSON(app, "/conversations/g1/members", { action: "remove", user_id: "member-2" }, env, cookie);
    expect(res.status).toBe(200);
    const dels = env.DB.calls.filter((cl) => cl.op === "run" && /DELETE FROM conversation_members/i.test(cl.sql));
    expect(dels).toHaveLength(1);
  });

  it("blocks a non-admin from managing members", async () => {
    const { env, cookie } = chatEnv({ memberships: plainMem });
    const res = await postJSON(app, "/conversations/g1/members", { action: "add", user_id: "member-3" }, env, cookie);
    expect(res.status).toBe(403);
  });

  it("blocks member changes on DMs", async () => {
    const { env, cookie } = chatEnv({ memberships: dmMem });
    const res = await postJSON(app, "/conversations/c1/members", { action: "add", user_id: "member-3" }, env, cookie);
    expect(res.status).toBe(400);
  });

  it("stops admins from removing themselves (a group always keeps an admin)", async () => {
    const { env, cookie } = chatEnv({ memberships: adminMem });
    const res = await postJSON(app, "/conversations/g1/members", { action: "remove", user_id: "member-1" }, env, cookie);
    expect(res.status).toBe(400);
  });

  it("returns 404 for a non-member", async () => {
    const { env, cookie } = chatEnv();
    const res = await postJSON(app, "/conversations/g1/members", { action: "add", user_id: "member-3" }, env, cookie);
    expect(res.status).toBe(404);
  });
});

describe("GET /chat/people", () => {
  it("searches members without exposing emails or real names", async () => {
    const peopleRows = [
      { id: "member-2", display_name: "Bo", name: "Bo Chen", username: "bo", avatar_key: null },
    ];
    const { env, cookie } = chatEnv({ peopleRows });
    const res = await getJSON(app, "/people?q=bo", env, cookie);
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.people).toHaveLength(1);
    expect(d.people[0].display_name).toBe("Bo");
    expect(d.people[0]).not.toHaveProperty("email");
    expect(d.people[0]).not.toHaveProperty("name");
  });

  it("ignores one-letter queries", async () => {
    const { env, cookie } = chatEnv();
    const res = await getJSON(app, "/people?q=b", env, cookie);
    const d = await res.json();
    expect(d.people).toEqual([]);
  });
});

describe("GET /chat/story-replies", () => {
  it("reports unavailable when the stories migration is absent", async () => {
    const { env, cookie } = chatEnv({ storyTable: false });
    const res = await getJSON(app, "/story-replies", env, cookie);
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.ok).toBe(true);
    expect(d.feature).toBe("unavailable");
    expect(d.replies).toEqual([]);
  });

  it("lists replies to the caller's stories when the table exists", async () => {
    const storyReplyRows = [
      {
        id: "sr1", story_id: "s1", from_user_id: "member-2",
        body: "This is inspiring!", created_at: "2026-10-08T15:00:00.000Z",
        display_name: "Bo", name: "Bo Chen", username: "bo", avatar_key: null,
      },
    ];
    const { env, cookie } = chatEnv({ storyTable: true, storyReplyRows });
    const res = await getJSON(app, "/story-replies", env, cookie);
    const d = await res.json();
    expect(d.feature).toBe("available");
    expect(d.replies).toHaveLength(1);
    expect(d.replies[0].from.display_name).toBe("Bo");
    expect(d.replies[0]).not.toHaveProperty("email");
  });
});
