#!/usr/bin/env node
/**
 * Turn lychee's raw output into a small, curated report the ClickUp agent
 * can fetch in one call.
 *
 *   node scripts/build-report.mjs lychee-raw.json
 *
 * Writes docs/latest.json, docs/latest.md, docs/history/<date>.json
 *
 * WHY THIS EXISTS: a raw lychee run on this site flags ~20 "errors" per 3
 * pages, of which roughly 1 is a real dead link. Handing that to an agent
 * produces thousands of junk tasks. Everything below is about separating
 * "this link is gone" from "this server dislikes robots".
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

/** Statuses that mean "a robot was refused", NOT "this page is gone". */
const BLOCKED_CODES = new Set([401, 403, 405, 406, 429, 999]);
/** Statuses that mean the target is genuinely missing. */
const DEAD_CODES = new Set([404, 410]);

/** Never publish these, even though they appear in page HTML. */
const NEVER_PUBLISH = [
  /\/wp-admin/i,
  /\/wp-login/i,
  /[?&](token|key|auth|password|secret|nonce)=/i,
  /staging|\.local\b|localhost|127\.0\.0\.1/i,
];

const shouldPublish = (url) => !NEVER_PUBLISH.some((re) => re.test(url));

const isInternal = (url) => {
  try { return INTERNAL_HOSTS.has(new URL(url).hostname.toLowerCase()); }
  catch { return false; }
};

/** Shorten our own URLs to paths so the report stays small and readable. */
const short = (url) => url.startsWith(SITE) ? (url.slice(SITE.length) || "/") : url;

function classify(status) {
  const code = status?.code;
  if (typeof code === "number") {
    if (DEAD_CODES.has(code)) return { bucket: "dead", label: String(code) };
    if (BLOCKED_CODES.has(code)) return { bucket: "blocked", label: String(code) };
    if (code >= 500) return { bucket: "review", label: String(code) };
    if (code >= 200 && code < 400) return { bucket: "ok", label: String(code) };
    return { bucket: "review", label: String(code) };
  }
  // No status code at all: DNS failure, connection refused, TLS error, timeout.
  // These are the strongest dead signals we get.
  const text = (status?.text ?? "unknown error").toLowerCase();
  if (text.includes("timeout") || text.includes("timed out"))
    return { bucket: "dead", label: "timeout" };
  return { bucket: "dead", label: status?.text ?? "unreachable" };
}

// ---------------------------------------------------------------------------

const rawPath = process.argv[2] ?? join(ROOT, "lychee-raw.json");
if (!existsSync(rawPath)) {
  console.error(`No lychee output at ${rawPath}`);
  process.exit(1);
}
const raw = JSON.parse(readFileSync(rawPath, "utf8"));

// Merge every map lychee gives us that represents a problem.
const sources = { ...(raw.error_map ?? {}) };
for (const [page, items] of Object.entries(raw.timeout_map ?? {})) {
  sources[page] = (sources[page] ?? []).concat(items);
}

/** url -> { url, status, internal, found_on:Set } */
const findings = new Map();

for (const [page, items] of Object.entries(sources)) {
  for (const item of items) {
    const url = item.url;
    if (!url || !shouldPublish(url)) continue;
    const { bucket, label } = classify(item.status);
    if (bucket === "ok") continue;

    let rec = findings.get(url);
    if (!rec) {
      rec = { url, status: label, bucket, internal: isInternal(url), found_on: new Set() };
      findings.set(url, rec);
    }
    rec.found_on.add(short(page));
  }
}

const bucketed = { dead: [], blocked: [], review: [] };
for (const rec of findings.values()) {
  const pages = [...rec.found_on].sort();
  bucketed[rec.bucket]?.push({
    url: rec.url,
    status: rec.status,
    internal: rec.internal,
    pages_affected: pages.length,
    // Cap the list: one footer link can appear on all 1,459 pages and would
    // otherwise balloon the file the agent has to read.
    found_on: pages.slice(0, 10),
  });
}

const byImpact = (a, b) =>
  (b.internal - a.internal) || (b.pages_affected - a.pages_affected)
  || a.url.localeCompare(b.url);
for (const k of Object.keys(bucketed)) bucketed[k].sort(byImpact);

// --- diff against the previous run -----------------------------------------
// The report is a file in git, so "what changed" needs no database.
let prev = null;
if (existsSync(LATEST)) {
  try { prev = JSON.parse(readFileSync(LATEST, "utf8")); } catch { /* first run */ }
}
const prevDead = new Set((prev?.all_dead ?? []).map((d) => d.url));
const prevReview = new Set((prev?.needs_review ?? []).map((d) => d.url));

// A 5xx on one run is often transient. Only promote to `dead` if it was
// failing last week too - that turns a flaky blip into a real signal.
const promoted = bucketed.review.filter((d) => prevReview.has(d.url));
const allDead = [...bucketed.dead, ...promoted].sort(byImpact);

const newSince = allDead.filter((d) => !prevDead.has(d.url));
const resolved = [...prevDead].filter(
  (u) => !allDead.some((d) => d.url === u)
);

const scannedAt = new Date().toISOString();
const report = {
  scanned_at: scannedAt,
  previous_scan: prev?.scanned_at ?? null,
  pages_crawled: raw.total != null ? (prev?.pages_crawled ?? null) : null,
  links_checked: raw.total ?? 0,
  unique_links: raw.unique ?? 0,
  confirmed_dead: allDead.length,
  new_since_last_run: newSince,
  resolved_since_last_run: resolved,
  all_dead: allDead,
  // Informational only. The agent should NOT open tasks for these.
  blocked_by_bot_protection: bucketed.blocked.length,
  needs_review: bucketed.review,
};

mkdirSync(join(DOCS, "history"), { recursive: true });
writeFileSync(LATEST, JSON.stringify(report, null, 2) + "\n");
writeFileSync(
  join(DOCS, "history", `${scannedAt.slice(0, 10)}.json`),
  JSON.stringify(report, null, 2) + "\n"
);

// --- human-readable ---------------------------------------------------------
const table = (rows) => rows.length === 0 ? "_None._\n"
  : "| Status | Link | On | Example page |\n|---|---|---|---|\n" +
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
${bucketed.blocked.length} link(s) returned bot-protection codes (401/403/405/429/999).
These are almost always alive; they are counted but not listed.
`);

console.log(`dead=${allDead.length} new=${newSince.length} resolved=${resolved.length} ` +
            `review=${bucketed.review.length} blocked=${bucketed.blocked.length}`);
