# Developer Signals report

A static-first, source-linked report for open
[`feature` issues](https://github.com/web-platform-dx/developer-signals/issues?q=is%3Aissue+state%3Aopen+label%3Afeature)
in `web-platform-dx/developer-signals`.

The Astro site publishes a top-25 priority report, full browsing, search,
filters, alternate sorts, score disclosure, feature evidence pages, methodology,
history, stale-data state, and GitHub fallback links. JavaScript progressively
enhances filtering and optional write actions; the report remains readable
without it.

## Local setup

Requirements: Node.js 22.12 or newer (CI uses Node 24).

```powershell
npm install
npm run dev
```

The checked-in `src/data/report.json` and `public/data/report.json` are a
source-linked public API sample of the 30 most-reacted open feature issues.
Votes and comments come from GitHub; no synthetic use-case evidence is included.
No token or network is needed to build from the checked-in snapshot:

```powershell
npm run test
npm run check
npm run worker:check
npm run build
```

`npm run validate` runs all four checks. `npm run generate:fixture` refreshes
the public sample from GitHub. It works without a token within GitHub's public
API rate limit, and uses `GITHUB_TOKEN` when one is available.
`npm run rebuild:report` reapplies current qualification and scoring rules to
the source comments already stored in the checked-in report without using the
network.

## Architecture

- `src/lib/signals/` — Zod model, deterministic qualification, scoring,
  formula constants, web-features join, and optional AI adapter.
- `scripts/ingest.ts` — authenticated GitHub REST ingestion with schema checks,
  bounded pagination, vote cross-checks, snapshot retention, and incomplete-data
  failure.
- `data/overrides.json` — reviewed manual corrections. These win over optional
  AI output.
- `src/pages/` — static Astro report, browse, methodology, and generated feature
  detail routes.
- `worker/` — separate Cloudflare Worker BFF; never required for reading.
- `.github/workflows/` — validation, daily ingestion/Pages deployment, and
  manually triggered optional enrichment.

The generated public JSON is also available at `data/report.json` in the built
site. GitHub and `web-features` remain the systems of record.

## Live ingestion

Create a GitHub token that can read public issues, comments, and reactions, then:

```powershell
$env:GITHUB_TOKEN = "..."
npm run ingest
```

The script joins:

1. `https://web-platform-dx.github.io/developer-signals/web-features-signals.json`
2. GitHub issue/comment/reaction data for the allowlisted source repository
3. the installed `web-features` package
4. optional reviewed enrichment and manual overrides
5. previously generated snapshots

It rejects malformed source records, GitHub schema changes, API errors,
pagination beyond its safety bound, fewer than 25 eligible open features, and an
invalid existing report. It does not silently publish partial results.

## Scoring and governance

Formula and qualification versions are defined in
`src/lib/signals/constants.ts`; the methodology page imports the same values so
documentation cannot drift. Formula `1.0.0` is:

```text
priority = 0.50 × vote demand
         + 0.35 × distinct qualified use-case evidence
         + 0.15 × workaround burden
```

Components use bounded logarithmic normalization. Authors are deduplicated.
Bots, minimized/template-only/moderation/generic-support/debate-only comments
are excluded. Comment-reaction evidence is capped per author and relative to
qualified author count. Workaround severity has fixed public weights.

To change a weight, reference, workaround weight, or qualification rule:

1. update the shared constants/rules;
2. increment `FORMULA_VERSION` or `QUALIFICATION_VERSION`;
3. update sensitivity and edge-case tests;
4. regenerate reports and comparison snapshots;
5. add the change to the methodology history.

Overrides require a stable source ID, rationale, reviewer, and review date. Keep
them narrow; never copy source text when a source-linked excerpt is sufficient.

## Optional AI enrichment

AI is disabled by default and not needed for ingestion or builds.
`src/lib/signals/ai-adapter.ts` requires strict JSON-schema output and permits
only classification, themes, summary, and workaround severity. It cannot
produce an opaque numeric quality score. Source IDs are retained and summaries
must be labeled “AI-generated”.

To run manually:

```powershell
$env:ENABLE_AI_ENRICHMENT = "true"
$env:AI_ENDPOINT = "https://provider.example/v1/chat/completions"
$env:AI_API_KEY = "..."
$env:AI_MODEL = "..."
npm run enrich
```

Review `data/ai-enrichment.json` before merging. Manual
`data/overrides.json` fields are applied last.

## Deployment

See [deployment and Worker operations](docs/deployment.md) for GitHub Pages,
custom domains, GitHub App configuration, Cloudflare bindings, secrets,
permissions, and rollback. See [privacy and abuse](docs/privacy-abuse.md) for
data handling, moderation, rate-limit caveats, and incident response.

## Fallback behavior

Reading is always static. If `PUBLIC_WORKER_URL` is absent, unreachable, or
authentication fails, vote/comment controls explain the failure and preserve an
“Open on GitHub” link. The frontend never asks users to paste tokens and never
stores GitHub credentials. Until a same-site custom-domain deployment is
available, direct GitHub actions are the recommended production path.
