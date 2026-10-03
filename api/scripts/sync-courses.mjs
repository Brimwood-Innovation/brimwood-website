#!/usr/bin/env node
/* CMS → D1 course sync.
 *
 * Reads Decap CMS course Markdown (site/src/content/courses/*.md), parses the
 * frontmatter, and POSTs the payload to the worker sync endpoint:
 *
 *   POST {WORKER_URL}/api/admin/sync/courses
 *   Authorization: Bearer {SYNC_SECRET}
 *
 * Usage:
 *   WORKER_URL=https://brimwood-api.adamsayani.workers.dev \
 *   SYNC_SECRET=... \
 *   node api/scripts/sync-courses.mjs
 *
 * Flags:
 *   --dry-run   Parse the Markdown and print the payload without POSTing.
 *
 * No dependencies beyond the Node standard library.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COURSES_DIR = join(REPO_ROOT, "site", "src", "content", "courses");
const DRY_RUN = process.argv.includes("--dry-run");

/* --- Minimal YAML-subset parser -------------------------------------------
 * Handles exactly what Decap CMS writes for the courses collection:
 * string/number/boolean/null scalars, nested maps, nested lists, and literal
 * blocks (| or >). Two-space indentation. Fails loudly on anything else.
 */
function parseFrontmatter(md, filename) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) throw new Error(`${filename}: missing YAML frontmatter`);
  return parseYaml(m[1], filename);
}

function parseYaml(src, filename) {
  const lines = src.split(/\r?\n/);
  let pos = 0;
  const indentOf = (l) => l.length - l.trimStart().length;

  function fail(msg) {
    throw new Error(`${filename}: line ${pos + 1}: ${msg}`);
  }
  function skipBlanks() {
    while (
      pos < lines.length &&
      (lines[pos].trim() === "" || lines[pos].trimStart().startsWith("#"))
    )
      pos++;
  }
  function parseScalar(raw) {
    const t = raw.trim();
    if (t === "" || t === "null" || t === "~") return null;
    if (t === "true") return true;
    if (t === "false") return false;
    if (/^-?\d+$/.test(t)) return parseInt(t, 10);
    if (/^-?\d*\.\d+$/.test(t)) return parseFloat(t);
    const q = t.match(/^(['"])([\s\S]*)\1$/);
    if (q) return q[2];
    return t;
  }
  function parseLiteral(parentIndent) {
    const buf = [];
    let litIndent = null;
    while (pos < lines.length) {
      const line = lines[pos];
      if (line.trim() === "") {
        buf.push("");
        pos++;
        continue;
      }
      const ind = indentOf(line);
      if (litIndent === null) {
        if (ind <= parentIndent) break;
        litIndent = ind;
      }
      if (ind < litIndent) break;
      buf.push(line.slice(litIndent));
      pos++;
    }
    return buf.join("\n").replace(/\n+$/, "");
  }
  function parseBlock(minIndent) {
    skipBlanks();
    if (pos >= lines.length) return undefined;
    const ind = indentOf(lines[pos]);
    if (ind < minIndent) return undefined;
    const t = lines[pos].trim();
    if (t.startsWith("- ") || t === "-") return parseList(ind);
    return parseMap(ind);
  }
  // Parse map entries at exactly `indent`, stopping at anything else.
  function parseMapAt(indent) {
    const obj = {};
    for (;;) {
      skipBlanks();
      if (pos >= lines.length) break;
      const line = lines[pos];
      const ind = indentOf(line);
      if (ind !== indent) break;
      const t = line.trim();
      if (t.startsWith("- ") || t === "-") break;
      const cm = t.match(/^([^:#]+):\s*(.*)$/);
      if (!cm) fail(`cannot parse "${line.trim()}"`);
      const key = cm[1].trim();
      const rest = cm[2];
      pos++;
      obj[key] = parseValue(key, rest, indent);
    }
    return obj;
  }
  function parseValue(key, rest, indent) {
    if (rest === "|" || rest === ">") return parseLiteral(indent);
    if (rest !== "") return parseScalar(rest);
    const v = parseBlock(indent + 1);
    return v === undefined ? null : v;
  }
  function parseList(indent) {
    const arr = [];
    for (;;) {
      skipBlanks();
      if (pos >= lines.length) break;
      const line = lines[pos];
      if (indentOf(line) !== indent) break;
      const t = line.trim();
      if (!(t.startsWith("- ") || t === "-")) break;
      pos++;
      const after = t === "-" ? "" : t.slice(2).trim();
      if (after === "") {
        // Nested block on the following lines.
        arr.push(parseBlock(indent + 1));
        continue;
      }
      const cm = after.match(/^([^:#]+):\s*(.*)$/);
      if (!cm) {
        arr.push(parseScalar(after));
        continue;
      }
      // Inline "- key: value" starts a map; continuation lines extend it.
      const obj = {};
      const key = cm[1].trim();
      obj[key] = parseValue(key, cm[2], indent);
      skipBlanks();
      if (pos < lines.length && indentOf(lines[pos]) > indent) {
        parseMapInto(obj, indentOf(lines[pos]));
      }
      arr.push(obj);
    }
    return arr;
  }
  function parseMapInto(obj, indent) {
    for (;;) {
      skipBlanks();
      if (pos >= lines.length) break;
      const line = lines[pos];
      if (indentOf(line) !== indent) break;
      const t = line.trim();
      if (t.startsWith("- ") || t === "-") break;
      const cm = t.match(/^([^:#]+):\s*(.*)$/);
      if (!cm) fail(`cannot parse "${line.trim()}"`);
      const key = cm[1].trim();
      const rest = cm[2];
      pos++;
      obj[key] = parseValue(key, rest, indent);
    }
    return obj;
  }
  const out = parseMapAt(0);
  return out;
}

/* --- Load courses ---------------------------------------------------------- */
function loadCourses() {
  let files;
  try {
    files = readdirSync(COURSES_DIR)
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    console.error(`courses directory not found: ${COURSES_DIR}`);
    console.error("Create course Markdown in the CMS first (Content Studio → Courses).");
    process.exit(1);
  }
  if (files.length === 0) {
    console.error(`no course Markdown files in ${COURSES_DIR} — nothing to sync.`);
    process.exit(1);
  }
  return files.map((f) => {
    const raw = readFileSync(join(COURSES_DIR, f), "utf8");
    const fm = parseFrontmatter(raw, f);
    const slug = basename(f, ".md").toLowerCase();
    const modules = Array.isArray(fm.modules) ? fm.modules : [];
    return {
      slug,
      title: fm.title ?? "",
      tagline: fm.tagline ?? "",
      description_md: fm.description ?? "",
      level: fm.level ?? "foundations",
      visibility: fm.visibility ?? "members",
      status: fm.status ?? "draft",
      cover_r2_key: fm.cover_r2_key ?? null,
      modules: modules.map((m) => ({
        title: m?.title ?? "",
        lessons: (Array.isArray(m?.lessons) ? m.lessons : []).map((l) => ({
          title: l?.title ?? "",
          body_md: l?.body ?? "",
          is_preview: l?.is_preview === true,
          status: l?.status ?? "published",
          duration_minutes: l?.duration_minutes ?? null,
          video_r2_key: l?.video_r2_key ?? null,
        })),
      })),
    };
  });
}

/* --- Main ------------------------------------------------------------------ */
async function main() {
  const courses = loadCourses();
  const payload = { courses };

  if (DRY_RUN) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const workerUrl = (process.env.WORKER_URL || "").replace(/\/$/, "");
  const secret = process.env.SYNC_SECRET || "";
  if (!workerUrl) {
    console.error("WORKER_URL is required (e.g. https://brimwood-api.adamsayani.workers.dev)");
    process.exit(1);
  }
  if (!secret) {
    console.error("SYNC_SECRET is required (GitHub secret / worker secret)");
    process.exit(1);
  }

  const res = await fetch(`${workerUrl}/api/admin/sync/courses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    console.error(`sync failed (HTTP ${res.status}): ${data.error || "unknown error"}`);
    process.exit(1);
  }
  console.log(
    `synced ${data.courses} course(s), ${data.modules} module(s), ${data.lessons} lesson(s)`
  );
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
