#!/usr/bin/env node
/**
 * Turn lychee's raw output into a small, curated report the ClickUp agent
 * can fetch in one call.
 *
 *   node scripts/build-report.mjs lychee-full.json
 *
 * Writes docs/latest.json, docs/latest.md, docs/history/<date>.json
 *
 * WHY THIS EXISTS
 * ---------------
 * A raw lychee run on this site produces ~4,500 errors. Almost none are real.
 * Three separate things have to be stripped out before an agent sees the list,
 * and each needed a different technique:
 *
 *   1. BOT PROTECTION - 401/403/405/429/999. Verified by hand that mrexcel.com
 *      (403) and linkedin.com (999) are both perfectly alive.
 *
 *   2. COMMENT SPAM - readers paste "n/a" or junk domains into the URL field
 *      of the comment form. Those become real <a> tags on the page but are not
 *      Jeff's to fix. Detected by comparing the link's line number against
 *      where the comments region starts, plus rel="ugc".
 *
 *   3. LOAD-INDUCED FALSE 404s - this is the nasty one. Vimeo and YouTube
 *      return 404 to HEAD requests and under concurrent load, then 200 when
 *      asked politely. A bulk scan flagged 29 such links as dead; on re-check
 *      nearly all were fine. So every dead candidate gets CONFIRMED by a second,
 *      slow, browser-like GET before it is reported.
 *
 * The bulk scan is fast and noisy; the confirmation pass is slow and careful
 * but only runs against ~100 candidates, so it costs seconds.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs");
const LATEST = join(DOCS, "latest.json");
const SITE = "https://www.excel-university.com";

const INTERNAL_HOSTS = new Set([
  "excel-university.com", "www.excel-university.com",
  "store.excel-university.com", "campus.excel-university.com",
  "help.excel-university.com",
]);

/** Statuses meaning "a robot was refused", NOT "this page is gone". */
const BLOCKED_CODES = new Set([401, 403, 405, 406, 429, 999]);
/** Statuses meaning the target is genuinely missing. */
const DEAD_CODES = new Set([404, 410]);

/** Never publish these, even though they appear in page HTML. */
const NEVER_PUBLISH = [
  /\/wp-admin/i,
  /\/wp-login/i,
  /[?&](token|key|auth|password|secret|nonce)=/i,
  /staging|\.local\b|localhost|127\.0\.0\.1/i,
];

/** A browser-ish UA. Several CDNs serve 404/403 to anything else. */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const shouldPublish = (url) => !NEVER_PUBLISH.some((re) => re.test(url));

const isInternal = (url) => {
  try { return INTERNAL_HOSTS.has(new URL(url).hostname.toLowerCase()); }
  catch { return false; }
};

/** Shorten our own URLs to paths so the report stays small and readable. */
const short = (url) => (url.startsWith(SITE) ? url.slice(SITE.length) || "/" : url);

/**
 * Reject things that were never links. Readers type "n/a" into the comment
 * URL field and WordPress dutifully renders http://n/a as an anchor.
 */
function isNotARealUrl(url) {
  if (url === "error:" || url.startsWith("error")) return true;
  let h;
  try { h = new URL(url).hostname; } catch { return true; }
  if (!h.includes(".")) return true;              // http://na/ , http://shortcutlist/
  if (/^(n\/?a|na|tbd|none|example|hostname)$/i.test(h)) return true;
  return false;
}

function classify(status) {
  const code = status?.code;
  if (typeof code === "number") {
    if (DEAD_CODES.has(code)) return { bucket: "dead", label: String(code) };
    if (BLOCKED_CODES.has(code)) return { bucket: "blocked", label: String(code) };
    if (code >= 500) return { bucket: "review", label: String(code) };
    if (code >= 200 && code < 400) return { bucket: "ok", label: String(code) };
    return { bucket: "review", label: String(code) };
  }
  const text = (status?.details ?? status?.text ?? "unreachable").toLowerCase();
  if (text.includes("timeout") || text.includes("timed out"))
    return { bucket: "dead", label: "timeout" };
  if (text.includes("dns") || text.includes("connection failed"))
    return { bucket: "dead", label: "no such host" };
  if (text.includes("refused")) return { bucket: "dead", label: "connection refused" };
  if (text.includes("tls") || text.includes("ssl"))
    return { bucket: "dead", label: "TLS failure" };
  return { bucket: "dead", label: "unreachable" };
}

/** Small concurrency-limited map. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    })
  );
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Re-check one candidate carefully: real GET, browser UA, generous timeout,
 * retries with backoff. Returns true if the link is actually dead.
 */
async function confirmDead(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(1500 * attempt);
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(25_000),
      });
      if (res.status < 400) return false;                 // alive
      if (BLOCKED_CODES.has(res.status)) return false;    // refused a robot, not dead
      if (res.status >= 500) continue;                    // maybe transient, retry
      if (DEAD_CODES.has(res.status)) return true;        // genuinely gone
      return true;
    } catch {
      // network-level failure; retry, and if it never succeeds treat as dead
    }
  }
  return true;
}

/** Work out which findings sit inside the comments region of their page. */
async function findUserGenerated(occurrences) {
  const byPage = {};
  for (const o of occurrences) (byPage[o.page] ??= []).push(o);

  const ugc = new Set();
  const pages = Object.keys(byPage);
  await pool(pages, 6, async (page) => {
    let html;
    try {
      const res = await fetch(page, { headers: { "User-Agent": BROWSER_UA },
                                      signal: AbortSignal.timeout(25_000) });
      html = await res.text();
    } catch { return; }

    const lines = html.split("\n");
    let cstart = Infinity;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.includes('id="comments"') || l.includes("id='comments'") ||
          l.includes("comment-list") || l.includes('id="respond"')) {
        cstart = i + 1;
        break;
      }
    }

    for (const o of byPage[page]) {
      if (o.line >= cstart) { ugc.add(o.url); continue; }
      // Also honour rel="ugc" for themes that do not use a #comments wrapper.
      const line = lines[o.line - 1] ?? "";
      const at = line.indexOf(o.url);
      if (at >= 0) {
        const open = line.lastIndexOf("<a", at);
        const close = line.indexOf(">", at);
        if (open >= 0) {
          const tag = line.slice(open, close < 0 ? undefined : close + 1);
          if (/rel=["'][^"']*ugc/i.test(tag)) ugc.add(o.url);
        }
      }
    }
  });
  return ugc;
}

// ---------------------------------------------------------------------------

const rawPath = process.argv[2] ?? join(ROOT, "lychee-full.json");
if (!existsSync(rawPath)) {
  console.error(`No lychee output at ${rawPath}`);
  process.exit(1);
}
const raw = JSON.parse(readFileSync(rawPath, "utf8"));

const sources = { ...(raw.error_map ?? {}) };
for (const [page, items] of Object.entries(raw.timeout_map ?? {})) {
  sources[page] = (sources[page] ?? []).concat(items);
}

/** url -> { url, status, bucket, internal, found_on:Set } */
const findings = new Map();
/** flat list of {url,page,line} for the comment-region check */
const occurrences = [];
let notRealCount = 0;

for (const [page, items] of Object.entries(sources)) {
  for (const item of items) {
    const url = item.url;
    if (!url || !shouldPublish(url)) continue;
    if (isNotARealUrl(url)) { notRealCount++; continue; }

    const { bucket, label } = classify(item.status);
    if (bucket === "ok") continue;

    let rec = findings.get(url);
    if (!rec) {
      rec = { url, status: label, bucket, internal: isInternal(url), found_on: new Set() };
      findings.set(url, rec);
    }
    rec.found_on.add(short(page));
    if (item.span?.line) occurrences.push({ url, page, line: item.span.line });
  }
}

// --- stage 2: strip reader-submitted links ---------------------------------
const candidates = [...findings.values()].filter(
  (r) => r.bucket === "dead" || r.bucket === "review"
);
const ugcUrls = await findUserGenerated(
  occurrences.filter((o) => candidates.some((c) => c.url === o.url))
);
let ugcCount = 0;
for (const rec of candidates) {
  if (ugcUrls.has(rec.url) && !rec.internal) { rec.bucket = "user_generated"; ugcCount++; }
}

// --- stage 3: confirm every remaining dead candidate ------------------------
const toConfirm = [...findings.values()].filter((r) => r.bucket === "dead");
console.error(`Confirming ${toConfirm.length} dead candidates...`);
const verdicts = await pool(toConfirm, 4, async (r) => confirmDead(r.url));
let demoted = 0;
toConfirm.forEach((r, i) => {
  if (!verdicts[i]) { r.bucket = "false_positive"; demoted++; }
});
console.error(`  confirmed dead: ${toConfirm.length - demoted}, demoted: ${demoted}`);

// ---------------------------------------------------------------------------
const bucketed = { dead: [], blocked: [], review: [], user_generated: [], false_positive: [] };
for (const rec of findings.values()) {
  const pages = [...rec.found_on].sort();
  bucketed[rec.bucket]?.push({
    url: rec.url,
    status: rec.status,
    internal: rec.internal,
    pages_affected: pages.length,
    // One footer link can appear on all 1,459 pages; cap the list so the file
    // the agent reads stays small.
    found_on: pages.slice(0, 10),
  });
}

const byImpact = (a, b) =>
  (b.internal - a.internal) || (b.pages_affected - a.pages_affected) ||
  a.url.localeCompare(b.url);
for (const k of Object.keys(bucketed)) bucketed[k].sort(byImpact);

// --- diff against the previous run -----------------------------------------
let prev = null;
if (existsSync(LATEST)) {
  try { prev = JSON.parse(readFileSync(LATEST, "utf8")); } catch { /* first run */ }
}
const prevDead = new Set((prev?.all_dead ?? []).map((d) => d.url));
const prevReview = new Set((prev?.needs_review ?? []).map((d) => d.url));

// A 5xx on one run is often transient. Promote to dead only if it also failed
// last week - that turns a blip into a signal.
const promoted = bucketed.review.filter((d) => prevReview.has(d.url));
const allDead = [...bucketed.dead, ...promoted].sort(byImpact);

const newSince = allDead.filter((d) => !prevDead.has(d.url));
const resolved = [...prevDead].filter((u) => !allDead.some((d) => d.url === u));

const scannedAt = new Date().toISOString();
const report = {
  scanned_at: scannedAt,
  previous_scan: prev?.scanned_at ?? null,
  links_checked: raw.total ?? 0,
  unique_links: raw.unique ?? 0,
  confirmed_dead: allDead.length,

  // What the agent should act on.
  new_since_last_run: newSince,
  resolved_since_last_run: resolved,
  all_dead: allDead,

  // Everything below is informational. The agent must NOT open tasks for these.
  needs_review: bucketed.review,
  suppressed: {
    bot_protection: bucketed.blocked.length,
    reader_comments: ugcCount,
    not_real_urls: notRealCount,
    failed_confirmation: demoted,
  },
};

mkdirSync(join(DOCS, "history"), { recursive: true });
writeFileSync(LATEST, JSON.stringify(report, null, 2) + "\n");
writeFileSync(join(DOCS, "history", `${scannedAt.slice(0, 10)}.json`),
              JSON.stringify(report, null, 2) + "\n");

// --- human-readable ---------------------------------------------------------
const table = (rows) =>
  rows.length === 0
    ? "_None._\n"
    : "| Status | Link | Pages | Example |\n|---|---|---|---|\n" +
      rows.map((d) =>
        `| ${d.status} | ${d.internal ? "**(internal)** " : ""}${d.url} | ${d.pages_affected} | ${d.found_on[0] ?? ""} |`
      ).join("\n") + "\n";

writeFileSync(join(DOCS, "latest.md"), `# Dead link report

**Scanned:** ${scannedAt}
**Links checked:** ${report.links_checked} (${report.unique_links} unique)
**Confirmed dead:** ${report.confirmed_dead}

## New since last run (${newSince.length})

${table(newSince)}
## All confirmed dead (${allDead.length})

${table(allDead)}
## Needs review - 5xx, promoted if still failing next run (${bucketed.review.length})

${table(bucketed.review)}
---

### Suppressed as noise

| Reason | Count |
|---|---|
| Bot protection (401/403/405/429/999) | ${bucketed.blocked.length} |
| Reader comment links | ${ugcCount} |
| Not real URLs (\`http://n/a\` etc.) | ${notRealCount} |
| Failed confirmation re-check | ${demoted} |
`);

console.log(`dead=${allDead.length} new=${newSince.length} resolved=${resolved.length} ` +
            `review=${bucketed.review.length} | suppressed: bot=${bucketed.blocked.length} ` +
            `ugc=${ugcCount} fake=${notRealCount} unconfirmed=${demoted}`);
