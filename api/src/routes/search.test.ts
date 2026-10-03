/* Route tests: search — query bounds, LIKE escaping, members-only exclusion. */
import { describe, it, expect } from "vitest";
import app from "./search";
import { mockEnv } from "../test/helpers";

describe("GET / query bounds", () => {
  it("returns empty results for queries under 2 chars", async () => {
    const env = mockEnv();
    for (const q of ["", "a"]) {
      const res = await app.request("/?q=" + encodeURIComponent(q), {}, env as any);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, results: [] });
    }
    expect(env.DB.calls).toHaveLength(0); // no DB hit at all
  });

  it("truncates queries to 100 chars", async () => {
    const env = mockEnv();
    const binds: unknown[][] = [];
    env.DB.handler = (sql, params) => {
      binds.push(params);
      return { results: [] };
    };
    const q = "x".repeat(150);
    await app.request("/?q=" + q, {}, env as any);
    expect(binds.length).toBeGreaterThan(0);
    for (const b of binds) {
      for (const p of b) {
        if (typeof p === "string" && p.includes("%")) {
          expect(p.replace(/%/g, "").length).toBeLessThanOrEqual(100);
        }
      }
    }
  });

  it("escapes LIKE wildcards so % and _ match literally", async () => {
    const env = mockEnv();
    const binds: unknown[][] = [];
    env.DB.handler = (sql, params) => {
      binds.push(params);
      return { results: [] };
    };
    await app.request("/?q=" + encodeURIComponent("100%_sure"), {}, env as any);
    const likeParam = binds[0].find((p) => typeof p === "string" && (p as string).includes("100"));
    expect(likeParam).toBe("%100\\%\\_sure%");
  });

  it("rate-limits at 30/min per IP", async () => {
    const env = mockEnv();
    env.DB.handler = () => ({ results: [] });
    for (let i = 0; i < 30; i++) {
      const res = await app.request("/?q=hello", {}, env as any);
      expect(res.status).toBe(200);
    }
    const res = await app.request("/?q=hello", {}, env as any);
    expect(res.status).toBe(429);
  });
});

describe("members-only exclusion", () => {
  it("lesson query requires is_preview = 1 (never leaks members-only)", async () => {
    const env = mockEnv();
    const seen: string[] = [];
    env.DB.handler = (sql) => {
      seen.push(sql);
      return { results: [] };
    };
    await app.request("/?q=brimwood", {}, env as any);
    const lessonSql = seen.find((s) => /from\s+lessons/i.test(s))!;
    expect(lessonSql).toMatch(/is_preview\s*=\s*1/);
  });

  it("only published posts and published courses are searched", async () => {
    const env = mockEnv();
    const seen: string[] = [];
    env.DB.handler = (sql) => {
      seen.push(sql);
      return { results: [] };
    };
    await app.request("/?q=brimwood", {}, env as any);
    expect(seen.find((s) => /from\s+posts/i.test(s))).toMatch(/status\s*=\s*'published'/);
    expect(seen.find((s) => /from\s+lessons/i.test(s))).toMatch(/co\.status\s*=\s*'published'/);
  });

  it("merges post and lesson results with type/url shape", async () => {
    const env = mockEnv();
    env.DB.handler = (sql) => {
      if (/from\s+posts/i.test(sql))
        return { results: [{ slug: "p1", title: "Post", excerpt: "ex" }] };
      if (/from\s+lessons/i.test(sql))
        return {
          results: [{ id: "l1", title: "Lesson", body_md: "# Hi", course_slug: "foundations" }],
        };
    };
    const res = await app.request("/?q=brimwood", {}, env as any);
    const data = (await res.json()) as any;
    expect(data.results).toHaveLength(2);
    expect(data.results[0]).toEqual({ type: "post", title: "Post", excerpt: "ex", url: "/blog/p1" });
    expect(data.results[1].type).toBe("lesson");
    expect(data.results[1].url).toBe("/academy/foundations/l1");
    expect(data.results[1].excerpt).not.toMatch(/[#>*`]/); // markdown stripped
  });
});
