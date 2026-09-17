#!/usr/bin/env node
/**
 * Expand a sitemap index into a flat list of page URLs, one per line.
 *
 * lychee is not a spider - it only checks links on pages you hand it. Since
 * the sitemap already enumerates every page, one level is all we need.
 *
 *   node scripts/collect-urls.mjs > urls.txt
 */

const SITEMAP_INDEX = process.env.SITEMAP_INDEX
  ?? "https://www.excel-university.com/sitemap_index.xml";

const UA = "ExcelUniversity-LinkChecker/1.0 (+https://github.com/excela1/eu-link-checker)";

async function getText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

const locs = (xml) =>
  [...xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)].map((m) => m[1].trim());

const indexXml = await getText(SITEMAP_INDEX);
const children = locs(indexXml);

if (children.length === 0) {
  console.error("No child sitemaps found - is the sitemap index valid?");
  process.exit(1);
}
console.error(`Found ${children.length} child sitemaps`);

const pages = new Set();
for (const child of children) {
  try {
    const found = locs(await getText(child));
    found.forEach((u) => pages.add(u));
    console.error(`  ${child.split("/").pop().padEnd(28)} ${found.length}`);
  } catch (err) {
    // A child sitemap we cannot read means pages we would silently skip.
    // Fail loudly rather than quietly reporting a clean scan of half the site.
    console.error(`FATAL: could not read ${child}: ${err.message}`);
    process.exit(1);
  }
}

console.error(`\nTotal unique pages: ${pages.size}`);
for (const u of pages) console.log(u);
