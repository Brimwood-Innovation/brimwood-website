/* Brimwood contrast audit (F10).
 * Verifies WCAG 2.2 AA contrast for every colour pair touched by the F10
 * fix, by reading the real values out of the stylesheets (not hardcoded
 * copies). Text needs 4.5:1, non-text UI components (focus outlines) 3:1.
 * Exit 0 when every pair passes, 1 otherwise.
 *
 * Run: node site/scripts/contrast-check.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const brandCss = readFileSync(join(root, "src/styles/brand.css"), "utf8");
const tokensCss = readFileSync(join(root, "src/styles/tokens.css"), "utf8");
const adminAstro = readFileSync(join(root, "src/pages/admin.astro"), "utf8");
const lessonAstro = readFileSync(
  join(root, "src/pages/academy/[slug].astro"),
  "utf8"
);

/* ---- palette: resolve --var chains to hex ---- */
const raw = {};
for (const css of [tokensCss, brandCss]) {
  for (const m of css.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    raw[m[1]] = m[2].trim();
  }
}
function resolve(value) {
  let v = value.trim();
  const seen = new Set();
  let m;
  while ((m = v.match(/^var\(\s*--([\w-]+)\s*\)$/)) && !seen.has(m[1])) {
    seen.add(m[1]);
    v = (raw[m[1]] || "").trim();
  }
  return v;
}
function toHex(value) {
  const v = resolve(value);
  const m = v.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!m) throw new Error(`cannot resolve colour: ${value} -> ${v}`);
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return `#${h.toLowerCase()}`;
}

/* ---- WCAG relative luminance ---- */
function luminance(hex) {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i + 1, i + 3), 16));
  const f = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(fg, bg) {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/* ---- pull a declaration block for an exact selector ---- */
function block(css, selectorRe) {
  const m = css.match(new RegExp(`${selectorRe}\\s*\\{([^}]*)\\}`, "s"));
  if (!m) throw new Error(`selector not found: ${selectorRe}`);
  return m[1];
}
function prop(blk, name) {
  const m = blk.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  if (!m) throw new Error(`property ${name} not found in block`);
  return m[1].trim();
}

const PAPER = "#f6f8f7";

/* [label, source css, selector regex, fg source, bg source, threshold] */
const checks = [
  ["Primary button (.btn) text", brandCss, "\\.btn", "color", "background", 4.5],
  [".btn-primary text", brandCss, "\\.btn-primary", "color", "background", 4.5],
  ["Announcement bar text", brandCss, "\\.announcement-bar", "color", "background", 4.5],
  ["Step number (.step .num)", brandCss, "\\.step \\.num", "color", "background", 4.5],
  ["Kicker text (.kicker)", brandCss, "\\.kicker", "color", PAPER, 4.5],
  ["Card number (.card .n)", brandCss, "\\.card \\.n", "color", "#ffffff", 4.5],
  ["Step arrow (.step .arrow)", brandCss, "\\.step \\.arrow", "color", PAPER, 4.5],
  ["Base link (a)", brandCss, "(?<![\\w).\\]-])a", "color", PAPER, 4.5],
  ["Link hover (a:hover)", brandCss, "(?<![a-zA-Z])a:hover", "color", PAPER, 4.5],
  ["Hero button (.hero .btn)", brandCss, "\\.hero \\.btn", "color", "background", 4.5],
  ["Intro form button", brandCss, "form\\.intro \\.btn", "color", "background", 4.5],
  ["Admin tab active (.tab-btn.active)", adminAstro, "\\.tab-btn\\.active", "color", "background", 4.5],
  ["Done checkmark (lesson page)", lessonAstro, "\\.done-mark", "color", PAPER, 4.5],
  [":focus-visible outline (UI, 3:1)", brandCss, ":focus-visible", "outline-color", PAPER, 3.0],
];

let failures = 0;
for (const [label, css, sel, fgSrc, bgSrc, min] of checks) {
  try {
    let fgVal;
    if (sel === "\\.done-mark") {
      const im = css.match(/class="done-mark"[^>]*style="([^"]*)"/);
      if (!im) throw new Error("done-mark inline style not found");
      const sm = im[1].match(/color\s*:\s*([^;"']+)/);
      if (!sm) throw new Error("inline colour not found");
      fgVal = sm[1].trim();
    } else {
      var blk = block(css, sel);
      if (fgSrc === "outline-color") {
        const o = prop(blk, "outline");
        const cm = o.match(/#[0-9a-fA-F]{3,6}|var\(--[\w-]+\)/);
        if (!cm) throw new Error("outline colour not found");
        fgVal = cm[0];
      } else {
        fgVal = prop(blk, fgSrc);
      }
    }
    const bgVal = bgSrc.startsWith("#") ? bgSrc : prop(blk, bgSrc);
    const fg = toHex(fgVal);
    const bg = toHex(bgVal);
    const r = ratio(fg, bg);
    const ok = r >= min;
    if (!ok) failures++;
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${r.toFixed(2)}:1  (needs ${min}:1)  ${label}  [${fg} on ${bg}]`
    );
  } catch (e) {
    failures++;
    console.log(`ERROR  ${label}: ${e.message}`);
  }
}

console.log(failures === 0 ? "\nAll contrast checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
