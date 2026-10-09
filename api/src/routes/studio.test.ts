/* Brimwood Studio API tests (Phase D3): path allowlist, admin gates,
 * GitHub commit SHA flow (mocked fetch), token-missing behaviour. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import app, { validContentPath, validContentDir, b64encode, b64decode } from "./studio";
import { mockEnv, adminSession, memberSession, stubFetch } from "../test/helpers";

describe("validContentPath", () => {
  it("accepts md/json under site/src/content/", () => {
    expect(validContentPath("site/src/content/blog/hello.md")).toBe(true);
    expect(validContentPath("site/src/content/pages/about.md")).toBe(true);
    expect(validContentPath("site/src/content/settings.json")).toBe(true);
    expect(validContentPath("site/src/content/testimonials/a.md")).toBe(true);
  });
  it("rejects traversal and trickery", () => {
    expect(validContentPath("site/src/content/../api/index.ts")).toBe(false);
    expect(validContentPath("site/src/content/blog/../../wrangler.toml")).toBe(false);
    expect(validContentPath("..\\site\\src\\content\\x.md")).toBe(false);
  });
  it("rejects absolute paths, wrong roots, wrong extensions", () => {
    expect(validContentPath("/site/src/content/blog/x.md")).toBe(false);
    expect(validContentPath("api/src/index.ts")).toBe(false);
    expect(validContentPath("site/src/content/blog/x.txt")).toBe(false);
    expect(validContentPath("site/src/content/blog/x.md ")).toBe(false);
    expect(validContentPath("site/src/content/")).toBe(false);
    expect(validContentPath("")).toBe(false);
    expect(validContentPath(null)).toBe(false);
    expect(validContentPath(42)).toBe(false);
  });
});

describe("validContentDir", () => {
  it("accepts content dirs", () => {
    expect(validContentDir("site/src/content/blog")).toBe(true);
    expect(validContentDir("site/src/content/blog/")).toBe(true);
    expect(validContentDir("site/src/content/")).toBe(true);
  });
  it("rejects traversal and outside dirs", () => {
    expect(validContentDir("site/src/content/../api")).toBe(false);
    expect(validContentDir("site/src")).toBe(false);
    expect(validContentDir("/etc")).toBe(false);
    expect(validContentDir("")).toBe(false);
  });
});

describe("b64 helpers", () => {
  it("round-trips unicode", () => {
    const s = "Héllo — Canadian spelling: behaviour ✓";
    expect(b64decode(b64encode(s))).toBe(s);
  });
});

describe("admin gates", () => {
  it("GET /file rejects anonymous (403)", async () => {
    const res = await app.request("/file?path=site/src/content/blog/x.md", {}, mockEnv() as any);
    expect(res.status).toBe(403);
  });
  it("GET /list rejects members (403)", async () => {
    const env = mockEnv();
    const h = memberSession(env);
    const res = await app.request("/list?dir=site/src/content/blog", { headers: h }, env as any);
    expect(res.status).toBe(403);
  });
  it("POST /commit rejects anonymous (403)", async () => {
    const res = await app.request(
      "/commit",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      mockEnv() as any
    );
    expect(res.status).toBe(403);
  });
});

describe("token not configured", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = stubFetch(async () => new Response("{}", { status: 200 }));
  });
  afterEach(() => restore());

  it("GET /file returns 500 without GITHUB_CONTENT_TOKEN", async () => {
    const env = mockEnv({ GITHUB_CONTENT_TOKEN: undefined });
    const h = adminSession(env);
    const res = await app.request("/file?path=site/src/content/blog/x.md", { headers: h }, env as any);
    expect(res.status).toBe(500);
    const d = (await res.json()) as any;
    expect(d.error).toMatch(/not configured/);
  });
  it("POST /commit returns 500 without GITHUB_CONTENT_TOKEN", async () => {
    const env = mockEnv({ GITHUB_CONTENT_TOKEN: undefined });
    const h = adminSession(env);
    const res = await app.request(
      "/commit",
      {
        method: "POST",
        headers: { ...h, "content-type": "application/json" },
        body: JSON.stringify({ path: "site/src/content/blog/x.md", content: "# hi" }),
      },
      env as any
    );
    expect(res.status).toBe(500);
  });
});

describe("editorial guardrails on /commit", () => {
  let restore: () => void;
  let githubCalls: number;
  beforeEach(() => {
    githubCalls = 0;
    restore = stubFetch(async (url: string, init?: RequestInit) => {
      if (url.includes("api.github.com")) githubCalls++;
      const method = (init?.method || "GET").toUpperCase();
      if (method === "GET") return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ commit: { sha: "x" } }), { status: 200 });
    });
  });
  afterEach(() => restore());

  function cleanBlogPost(): string {
    return (
      "---\n" +
      'title: "A solid post about building"\n' +
      'description: "A short summary for the cards."\n' +
      "---\n\nWhy build in public? " +
      "x".repeat(400) +
      "\n"
    );
  }

  async function commit(path: string, content: string) {
    const env = mockEnv({ GITHUB_CONTENT_TOKEN: "gh_test_token" });
    const h = adminSession(env);
    return app.request(
      "/commit",
      {
        method: "POST",
        headers: { ...h, "content-type": "application/json" },
        body: JSON.stringify({ path, content }),
      },
      env as any
    );
  }

  it("blocks banned hype phrases with 422 and never touches GitHub", async () => {
    const res = await commit(
      "site/src/content/blog/hype.md",
      "---\ntitle: \"A solid post about building\"\ndescription: \"A short summary.\"\n---\n\nGet rich with 10x passive income. " + "x".repeat(400)
    );
    expect(res.status).toBe(422);
    const d = (await res.json()) as any;
    expect(d.ok).toBe(false);
    expect(d.issues.some((i: string) => i.includes("Banned phrase"))).toBe(true);
    expect(githubCalls).toBe(0);
  });

  it("blocks US spelling with 422", async () => {
    const res = await commit(
      "site/src/content/blog/spelling.md",
      "---\ntitle: \"A solid post about building\"\ndescription: \"A short summary.\"\n---\n\nWe optimize and organize everything. " + "x".repeat(400)
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as any).issues.some((i: string) => i.includes("Canadian spelling"))).toBe(true);
    expect(githubCalls).toBe(0);
  });

  it("blocks full-name testimonial attribution with 422", async () => {
    const res = await commit(
      "site/src/content/testimonials/a.md",
      '---\nquote: "Great place."\nattribution: "John Smith"\n---\n'
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as any).issues.some((i: string) => i.includes("full name"))).toBe(true);
    expect(githubCalls).toBe(0);
  });

  it("allows a clean post through to GitHub", async () => {
    const res = await commit("site/src/content/blog/clean.md", cleanBlogPost());
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).ok).toBe(true);
    expect(githubCalls).toBeGreaterThan(0);
  });
});

describe("commit SHA flow (mocked GitHub)", () => {
  let restore: () => void;
  let calls: { method: string; url: string; body: any }[];
  // Editorially valid post content (frontmatter + 300-char body), so the
  // server-side guardrails do not interfere with the SHA-flow assertions.
  const validPost = (title: string) =>
    `---\ntitle: "${title}"\ndescription: "A short summary for the cards."\n---\n\nWhy build in public? ` +
    "x".repeat(400) +
    "\n";
  beforeEach(() => {
    calls = [];
    restore = stubFetch(async (url: string, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      let body: any = null;
      try {
        body = init?.body ? JSON.parse(String(init.body)) : null;
      } catch {
        body = null;
      }
      calls.push({ method, url, body });
      if (method === "GET" && url.includes("/contents/")) {
        return new Response(
          JSON.stringify({ sha: "abc123", content: b64encode("# existing"), type: "file" }),
          { status: 200 }
        );
      }
      // NOTE: commit content below must pass the server-side editorial
      // guardrails (valid frontmatter + 300-char body), like real posts.
      if (method === "PUT" && url.includes("/contents/")) {
        return new Response(JSON.stringify({ commit: { sha: "def456" } }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
  });
  afterEach(() => restore());

  function adminEnv() {
    const env = mockEnv({ GITHUB_CONTENT_TOKEN: "gh_test_token" });
    const h = adminSession(env);
    return { env, h };
  }

  it("update includes existing SHA and base64 content", async () => {
    const { env, h } = adminEnv();
    const res = await app.request(
      "/commit",
      {
        method: "POST",
        headers: { ...h, "content-type": "application/json" },
        body: JSON.stringify({ path: "site/src/content/blog/x.md", content: validPost("A valid updated post") }),
      },
      env as any
    );
    expect(res.status).toBe(200);
    const d = (await res.json()) as any;
    expect(d.ok).toBe(true);
    expect(d.commitSha).toBe("def456");
    const put = calls.find((c) => c.method === "PUT");
    expect(put).toBeTruthy();
    expect(put!.body.sha).toBe("abc123");
    expect(put!.body.branch).toBe("develop");
    expect(put!.body.committer.name).toBe("Brimwood Studio");
    expect(b64decode(put!.body.content)).toBe(validPost("A valid updated post"));
    expect(put!.url).toContain("Brimwood-Innovation/brimwood-website");
  });

  it("new file omits SHA when GET returns 404", async () => {
    restore();
    const seen: string[] = [];
    restore = stubFetch(async (url: string, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      seen.push(method + " " + url.split("?")[0]);
      if (method === "GET") return new Response("{}", { status: 404 });
      const body = JSON.parse(String(init?.body || "{}"));
      expect(body.sha).toBeUndefined();
      return new Response(JSON.stringify({ commit: { sha: "new789" } }), { status: 200 });
    });
    const { env, h } = adminEnv();
    const res = await app.request(
      "/commit",
      {
        method: "POST",
        headers: { ...h, "content-type": "application/json" },
        body: JSON.stringify({ path: "site/src/content/pages/new.md", content: validPost("A valid new page") }),
      },
      env as any
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).commitSha).toBe("new789");
  });

  it("rejects invalid path before touching GitHub", async () => {
    const { env, h } = adminEnv();
    const res = await app.request(
      "/commit",
      {
        method: "POST",
        headers: { ...h, "content-type": "application/json" },
        body: JSON.stringify({ path: "site/src/content/../wrangler.toml", content: "x" }),
      },
      env as any
    );
    expect(res.status).toBe(400);
    expect(calls.filter((c) => c.url.includes("api.github.com")).length).toBe(0);
  });

  it("GET /file decodes content from GitHub", async () => {
    const { env, h } = adminEnv();
    const res = await app.request(
      "/file?path=" + encodeURIComponent("site/src/content/blog/x.md"),
      { headers: h },
      env as any
    );
    expect(res.status).toBe(200);
    const d = (await res.json()) as any;
    expect(d.content).toBe("# existing");
    expect(d.sha).toBe("abc123");
  });

  it("GET /list filters the recursive tree to the dir", async () => {
    restore();
    restore = stubFetch(async (url: string) => {
      expect(url).toContain("/git/trees/develop?recursive=1");
      return new Response(
        JSON.stringify({
          tree: [
            { path: "site/src/content/blog/a.md", type: "blob" },
            { path: "site/src/content/blog/b.md", type: "blob" },
            { path: "site/src/content/pages/c.md", type: "blob" },
            { path: "site/src/content/blog/d.txt", type: "blob" },
            { path: "api/src/index.ts", type: "blob" },
          ],
        }),
        { status: 200 }
      );
    });
    const { env, h } = adminEnv();
    const res = await app.request(
      "/list?dir=" + encodeURIComponent("site/src/content/blog"),
      { headers: h },
      env as any
    );
    expect(res.status).toBe(200);
    const d = (await res.json()) as any;
    expect(d.files.map((f: any) => f.name)).toEqual(["a.md", "b.md"]);
  });
});
