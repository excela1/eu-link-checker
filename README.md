# eu-link-checker

Weekly dead-link scan of **excel-university.com**, published as a small JSON
file that a ClickUp agent can fetch in a single request.

## The report

| | |
|---|---|
| Agent endpoint | `https://raw.githubusercontent.com/excela1/eu-link-checker/main/docs/latest.json` |
| Human version | [`docs/latest.md`](docs/latest.md) |
| History | [`docs/history/`](docs/history/) |

The agent should read **`new_since_last_run`** and open one task per entry.
Reading `all_dead` every week would re-open tasks for links you already know about.

```jsonc
{
  "scanned_at": "2026-09-20T08:00:00Z",
  "confirmed_dead": 12,
  "new_since_last_run": [
    { "url": "http://excelhow.net/", "status": "timeout",
      "internal": false, "pages_affected": 2,
      "found_on": ["/flashfill-meets-get-transform/", "/excel-breakout-puzzles/"] }
  ],
  "resolved_since_last_run": ["..."],
  "all_dead": ["..."],
  "needs_review": ["..."],
  "suppressed": {
    "bot_protection": 38,
    "reader_comments": 22,
    "not_real_urls": 9,
    "failed_confirmation": 28
  }
}
```

## Why it is built this way

**The agent never triggers the scan.** A 1,459-page crawl takes minutes; no
agent tool call survives that. GitHub Actions runs the scan on a cron and
commits the result. The agent only ever reads a finished file, so there is
nothing to time out.

**The exclusion list is the actual product.** An untuned run of this site
flags ~20 "errors" per 3 pages, of which about 1 is real. The rest are
Cloudflare email obfuscation, WordPress form endpoints, and sites that return
403/999 to anything that looks like a robot. Without the filtering in
`scripts/build-report.mjs` the agent would create thousands of junk tasks and
you would stop reading them.

**Git is the database.** Because the report is a committed file, "what is new
since last week" is a diff against the previous commit. No state table.

## Classification

| Bucket | What it is | Agent acts? |
|---|---|---|
| `dead` | 404/410/DNS/refused/timeout **that survived a confirmation re-check** | **Yes** |
| `review` | 5xx and odd 4xx | Only if still failing next week |
| `blocked` | 401, 403, 405, 406, 429, 999 - robot refused | No |
| `user_generated` | Link pasted by a reader in a comment | No |
| `false_positive` | Failed the bulk scan, passed the careful re-check | No |

### The confirmation pass matters more than anything else here

The first full run flagged 71 dead links. On re-check, **28 of the 45 external
candidates were alive** - a 62% false-positive rate. Vimeo and YouTube return
404 to `HEAD` requests and under concurrent load, then 200 when asked politely
one at a time with a browser user-agent.

So the scan runs in two stages: a fast, noisy bulk pass over ~197,000 links,
then a slow, browser-like `GET` against only the ~45 candidates that looked
dead. The second stage costs seconds and is the difference between a report
you trust and one you stop reading.

5xx gets a second chance because a one-off 502 is usually the far end having a
bad day, not a dead link. It is promoted to `dead` only if it fails twice in a
row.

## Tuning

When something shows up that is noise, fix it in one of two places:

- **Not a real link at all** (tracking pixels, form endpoints, machine
  discovery tags) -> add a regex to `exclude` in `lychee.toml`.
- **A real link whose host dislikes robots** -> add the status code to
  `BLOCKED_CODES` in `scripts/build-report.mjs`.

Both are version controlled, so the filter gets better over time and you can
see why any given rule exists.

## Running locally

```bash
node scripts/collect-urls.mjs > urls.txt
lychee --config lychee.toml --format json --output lychee-full.json \
       --no-progress --cache --files-from urls.txt
node scripts/build-report.mjs lychee-full.json
```

## Safety

`scripts/build-report.mjs` drops any URL matching `/wp-admin`, `/wp-login`,
staging/localhost hostnames, or query strings containing a token/key/secret
before writing the report. This repo is public; that filter is what keeps the
published file to URLs that are already in the public sitemap.
