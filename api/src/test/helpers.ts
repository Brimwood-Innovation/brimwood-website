/* Shared test fakes for the Brimwood API suite (Phase C).
 * In-memory stand-ins for Cloudflare bindings — no network, no real D1/KV.
 * Deterministic: tests drive behaviour through the programmable handler. */

export type SqlHandler = (
  sql: string,
  params: unknown[]
) => { results?: any[]; row?: any; changes?: number } | void;

export interface MockStatement {
  bind(...params: unknown[]): MockStatement;
  run(): Promise<{ meta: { changes: number } }>;
  all(): Promise<{ results: any[] }>;
  first<T = any>(): Promise<T | null>;
}

export interface MockD1 {
  prepare(sql: string): MockStatement;
  batch(stmts: MockStatement[]): Promise<unknown[]>;
  /** programmable query handler; recorded calls for assertions */
  handler: SqlHandler | null;
  calls: { sql: string; params: unknown[]; op: string }[];
  /** captured INSERT rows per table (table name -> rows) */
  inserts: Map<string, Record<string, unknown>[]>;
}

/** Parse the target table out of an INSERT/UPDATE/DELETE statement. */
function tableOf(sql: string): string {
  const m =
    sql.match(/insert\s+into\s+([a-z_]+)/i) ||
    sql.match(/update\s+([a-z_]+)/i) ||
    sql.match(/delete\s+from\s+([a-z_]+)/i);
  return (m?.[1] || "unknown").toLowerCase();
}

/** Column list for a simple `INSERT INTO t (a, b, c) VALUES ...` statement. */
function columnsOf(sql: string): string[] {
  const m = sql.match(/insert\s+into\s+[a-z_]+\s*\(([^)]+)\)/i);
  return m ? m[1].split(",").map((c) => c.trim().replace(/["`]/g, "")) : [];
}

/** Align bind params with `?` placeholders, resolving SQL literals inline.
 * e.g. `VALUES (?, ?, 'new')` with params [a,b] → {col0:a, col1:b, col2:'new'}. */
function rowOf(sql: string, params: unknown[]): Record<string, unknown> {
  const cols = columnsOf(sql);
  const vm = sql.match(/values\s*\(([^)]+)\)/i);
  const vals = vm ? vm[1].split(",").map((v) => v.trim()) : [];
  const row: Record<string, unknown> = {};
  let pi = 0;
  vals.forEach((v, i) => {
    const col = cols[i] || `col${i}`;
    if (v === "?") {
      row[col] = params[pi++];
    } else {
      const lit = v.match(/^'(.*)'$/);
      row[col] = lit ? lit[1] : v;
    }
  });
  return row;
}

export function mockD1(handler: SqlHandler | null = null): MockD1 {
  const db: MockD1 = {
    handler,
    calls: [],
    inserts: new Map(),
    prepare(sql: string): MockStatement {
      const stmt: MockStatement = {
        bind(...params: unknown[]) {
          const bound: MockStatement = {
            bind: (..._p: unknown[]) => bound,
            async run() {
              db.calls.push({ sql, params, op: "run" });
              const t = tableOf(sql);
              if (/^\s*insert/i.test(sql)) {
                if (!db.inserts.has(t)) db.inserts.set(t, []);
                db.inserts.get(t)!.push(rowOf(sql, params));
              }
              if (db.handler) {
                const r = db.handler(sql, params) as { changes?: number } | void;
                return { meta: { changes: r?.changes ?? 1 } };
              }
              return { meta: { changes: 1 } };
            },
            async all() {
              db.calls.push({ sql, params, op: "all" });
              if (db.handler) {
                const r = (db.handler(sql, params) as { results?: any[] } | void) || {};
                return { results: r.results ?? [] };
              }
              return { results: [] };
            },
            async first<T>() {
              db.calls.push({ sql, params, op: "first" });
              if (db.handler) {
                const r = (db.handler(sql, params) as { row?: any; results?: any[] } | void) || {};
                if (r.row !== undefined) return (r.row ?? null) as T | null;
                if (r.results) return ((r.results[0] ?? null) as T | null);
              }
              return null;
            },
          };
          return bound;
        },
        run: () => stmt.bind().run(),
        all: () => stmt.bind().all(),
        first: <T,>() => stmt.bind().first<T>(),
      };
      return stmt;
    },
    async batch(stmts: MockStatement[]) {
      return Promise.all(stmts.map((s) => s.run()));
    },
  };
  return db;
}

export interface MockKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  store: Map<string, string>;
}

export function mockKV(initial: Record<string, string> = {}): MockKV {
  const store = new Map(Object.entries(initial));
  // Structural extras (list/getWithMetadata) satisfy the KVNamespace type;
  // routes under test only use get/put/delete.
  const kv: MockKV = {
    store,
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
  return kv;
}

export interface MockEnv {
  DB: MockD1;
  NEWSLETTER_KV: MockKV;
  RATE_LIMIT_KV: MockKV;
  SESSIONS_KV: MockKV;
  MEDIA: { put(): Promise<void>; get(): Promise<null>; delete(): Promise<void> };
  RESEND_API_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  SITE_URL: string;
  SESSION_SECRET: string;
  SYNC_SECRET: string;
  GITHUB_CONTENT_TOKEN?: string;
}

/** Full fake Bindings for route tests. */
export function mockEnv(overrides: Partial<MockEnv> = {}): MockEnv {
  return {
    DB: mockD1(),
    NEWSLETTER_KV: mockKV(),
    RATE_LIMIT_KV: mockKV(),
    SESSIONS_KV: mockKV(),
    MEDIA: {
      async put() {},
      async get() {
        return null;
      },
      async delete() {},
    },
    RESEND_API_KEY: "re_test_key",
    TURNSTILE_SECRET_KEY: "ts_test_secret",
    SITE_URL: "https://brimwoodinnovation.com",
    SESSION_SECRET: "test-session-secret",
    SYNC_SECRET: "test-sync-secret",
    ...overrides,
  };
}

/** Logged-in admin session: cookie + KV entry + users row via the D1 handler. */
export function adminSession(env: MockEnv, userId = "admin-1", email = "admin@example.com") {
  // Sessions are keyed by SHA-256 of the token (F5).
  env.SESSIONS_KV.store.set(
    "sess:df6adb0b23fa33235f4aee6a0d62c118b00d71c07c81be87067b4f5892e66dbc",
    JSON.stringify({ userId, role: "admin" })
  );
  const prev = env.DB.handler;
  env.DB.handler = (sql, params) => {
    if (/from\s+users/i.test(sql)) return { row: { id: userId, email, role: "admin", status: "active" } };
    return prev?.(sql, params);
  };
  return { Cookie: "brimwood_sess=tok-admin" };
}

/** Logged-in non-admin member session. */
export function memberSession(env: MockEnv, userId = "member-1") {
  // Sessions are keyed by SHA-256 of the token (F5).
  env.SESSIONS_KV.store.set(
    "sess:1f01ccd79fa83611b7efefef57e9f6fca2f70f5fa6f3fb943c6bf7733dccaea4",
    JSON.stringify({ userId, role: "member" })
  );
  return { Cookie: "brimwood_sess=tok-member" };
}

export type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

const realFetch = globalThis.fetch;

/** Stub global fetch; returns a restore function. Route by URL substring. */
export function stubFetch(handler: FetchHandler): () => void {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input?.url || input);
    return handler(url, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Turnstile siteverify → success / failure. */
export function turnstileStub(success: boolean): () => void {
  return stubFetch((url) => {
    if (url.includes("challenges.cloudflare.com")) return json({ success });
    throw new Error("unexpected fetch: " + url);
  });
}

/** Resend → ok; Turnstile → success. Records sent emails. */
export function mailStub(sent: { to: string; subject: string }[]): () => void {
  return stubFetch((url, init) => {
    if (url.includes("challenges.cloudflare.com")) return json({ success: true });
    if (url.includes("api.resend.com")) {
      const body = JSON.parse(String(init?.body || "{}")) as { to?: string[]; subject?: string };
      sent.push({ to: body.to?.[0] || "", subject: body.subject || "" });
      return json({ id: "msg_test" });
    }
    throw new Error("unexpected fetch: " + url);
  });
}

/** Resend throws (outage); Turnstile → success. */
export function mailFailStub(): () => void {
  return stubFetch((url) => {
    if (url.includes("challenges.cloudflare.com")) return json({ success: true });
    if (url.includes("api.resend.com")) throw new Error("resend down");
    throw new Error("unexpected fetch: " + url);
  });
}

/** POST JSON helper for Hono app.request. */
export function postJSON(app: { request: Function }, path: string, body: unknown, env: unknown, headers: Record<string, string> = {}) {
  return app.request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    env as any
  );
}

/** Raw (possibly malformed) POST body helper. */
export function postRaw(app: { request: Function }, path: string, raw: string, env: unknown, headers: Record<string, string> = {}) {
  return app.request(
    path,
    { method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw },
    env as any
  );
}
