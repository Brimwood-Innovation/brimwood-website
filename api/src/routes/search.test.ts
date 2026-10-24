/* Route tests: search - query bounds, LIKE escaping, and the Phase 1
 * item 15 search_documents read rules (visibility, group, blocks). */
import { describe, it, expect } from "vitest";
import app from "./search";
import { mockEnv, memberSession } from "../test/helpers";

describe("GET / query bounds", () => {
  it("returns empty results for queries under 2 chars", async () => {
    const env = mockEnv();
    for (const q of ["", "a"]) {
      const res = await app.request("/?q=" + encodeURIComponent(q), {}, env as any);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, results: [] });
    }
    expect(env.DB.calls.filter((c) => !/rate_limits/i.test(c.sql))).toHaveLength(0); // no search DB hit
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

describe("search_documents read rules (Phase 1 item 15)", () => {
  it("anonymous search queries search_documents with visibility = 'public' only", async () => {
    const env = mockEnv();
    const seen: string[] = [];
    env.DB.handler = (sql) => {
      seen.push(sql);
      return { results: [] };
    };
    await app.request("/?q=brimwood", {}, env as any);
    const docsSql = seen.find((s) => /from\s+search_documents/i.test(s))!;
    expect(docsSql).toMatch(/visibility\s*=\s*'public'/);
    expect(docsSql).not.toMatch(/group_members|block_pairs/);
  });

  it("member search adds visibility, group membership, and block rules", async () => {
    const env = mockEnv();
    const h = memberSession(env);
    const seen: { sql: string; params: unknown[] }[] = [];
    env.DB.handler = (sql, params) => {
      seen.push({ sql, params });
      if (/from\s+users/i.test(sql))
        return { row: { id: "member-1", role: "member", status: "active" } };
      return { results: [] };
    };
    await app.request("/?q=brimwood", { headers: h }, env as any);
    const docs = seen.find((c) => /from\s+search_documents/i.test(c.sql))!;
    expect(docs.sql).toMatch(/visibility\s+in\s*\('public',\s*'members'\)/i);
    expect(docs.sql).toMatch(/group_members/);
    expect(docs.sql).toMatch(/state\s*=\s*'active'/);
    expect(docs.sql).toMatch(/block_pairs/);
    expect(docs.params.filter((p) => p === "member-1")).toHaveLength(2);
  });

  it("only published posts are searched", async () => {
    const env = mockEnv();
    const seen: string[] = [];
    env.DB.handler = (sql) => {
      seen.push(sql);
      return { results: [] };
    };
    await app.request("/?q=brimwood", {}, env as any);
    expect(seen.find((s) => /from\s+posts/i.test(s))).toMatch(/status\s*=\s*'published'/);
  });

  it("merges posts and every document type with correct URLs, skipping unresolvable rows", async () => {
    const env = mockEnv();
    const h = memberSession(env);
    env.DB.handler = (sql) => {
      if (/from\s+users/i.test(sql))
        return { row: { id: "member-1", role: "member", status: "active" } };
      if (/from\s+posts/i.test(sql))
        return { results: [{ slug: "p1", title: "Post", excerpt: "ex" }] };
      if (/from\s+search_documents/i.test(sql))
        return {
          results: [
            { doc_type: "feed_post", doc_id: "fp1", title: "", body: "# Hello world post", visibility: "members", group_id: null, author_id: "other-1" },
            { doc_type: "event", doc_id: "e1", title: "Demo Night", body: "Demos", visibility: "public", group_id: null, author_id: null },
            { doc_type: "event", doc_id: "e-missing", title: "Gone", body: "Gone", visibility: "public", group_id: null, author_id: null },
            { doc_type: "page", doc_id: "pg1", title: "Team", body: "People", visibility: "public", group_id: null, author_id: null },
            { doc_type: "course", doc_id: "c1", title: "Foundations", body: "Start here", visibility: "public", group_id: null, author_id: null },
            { doc_type: "lesson", doc_id: "l1", title: "Lesson One", body: "# Hi there", visibility: "public", group_id: null, author_id: null },
            { doc_type: "bogus", doc_id: "b1", title: "Bogus", body: "Bogus", visibility: "public", group_id: null, author_id: null },
          ],
        };
      if (/from\s+events/i.test(sql)) return { results: [{ id: "e1", slug: "demo-night" }] };
      if (/from\s+pages/i.test(sql)) return { results: [{ id: "pg1", slug: "about/team" }] };
      if (/from\s+courses/i.test(sql)) return { results: [{ id: "c1", slug: "foundations" }] };
      if (/from\s+lessons/i.test(sql)) return { results: [{ id: "l1", course_slug: "foundations" }] };
      return undefined;
    };
    const res = await app.request("/?q=brimwood", { headers: h }, env as any);
    const data = (await res.json()) as any;
    expect(data.results).toHaveLength(6);
    expect(data.results[0]).toEqual({ type: "post", title: "Post", excerpt: "ex", url: "/blog/p1" });
    expect(data.results[1]).toEqual({
      type: "feed_post",
      title: "Hello world post",
      excerpt: "",
      url: "/hub/post/?id=fp1",
    });
    expect(data.results[2]).toEqual({
      type: "event",
      title: "Demo Night",
      excerpt: "Demos",
      url: "/events/demo-night",
    });
    expect(data.results[3]).toEqual({ type: "page", title: "Team", excerpt: "People", url: "/about/team" });
    expect(data.results[4]).toEqual({
      type: "course",
      title: "Foundations",
      excerpt: "Start here",
      url: "/academy/foundations",
    });
    const lesson = data.results[5];
    expect(lesson.type).toBe("lesson");
    expect(lesson.url).toBe("/academy/foundations/l1");
    expect(lesson.excerpt).not.toMatch(/[#>*`]/); // markdown stripped
    expect(data.results.map((r: any) => r.url)).not.toContain("/events/e-missing");
  });
});
