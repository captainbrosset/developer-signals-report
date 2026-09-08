# Deployment and operations

## GitHub Pages

The `pages.yml` workflow runs daily and on demand. It installs locked
dependencies, performs authenticated ingestion, runs tests/typechecks/build,
commits the refreshed snapshots on `main`, and deploys the `dist` artifact only
after every check succeeds.

Repository variables:

| Variable | Purpose |
| --- | --- |
| `SITE_URL` | Origin, for example `https://signals.example.com` |
| `PUBLIC_BASE_PATH` | `/` for a custom domain or `/repository-name` for project Pages |
| `PUBLIC_WORKER_URL` | Optional Worker origin, for example `https://actions.signals.example.com` |
| `AI_MODEL` | Optional model identifier for the manual enrichment workflow |

The built-in `GITHUB_TOKEN` is used only by the scheduled workflow to read the
public source repository and persist generated snapshots. If organization policy
blocks cross-repository public API reads, provide a fine-grained token as a
separate secret and update the workflow reference. Do not expose it through an
Astro `PUBLIC_` variable.

For a custom domain, configure Pages DNS/HTTPS, set `SITE_URL`, and set
`PUBLIC_BASE_PATH=/`. Custom domains are strongly preferred when enabling the
Worker so the frontend and API can be same-site.

## GitHub App

Create a GitHub App owned or approved by the source repository organization.
Prefer these narrow repository permissions:

- **Issues: read and write** — read the issue, add/remove the user’s `+1`
  reaction, and create a structured issue comment.
- **Metadata: read** — GitHub’s required baseline permission.

No contents, administration, actions, pull request, organization, or email
permission is needed. Install the App only on
`web-platform-dx/developer-signals`. Set the callback URL to:

```text
https://<worker-origin>/auth/callback
```

The Worker uses the GitHub App OAuth user flow, state, and PKCE. It exchanges
the code server-side and stores the user access token only in an opaque,
short-lived KV session. If the repository owners cannot approve App
installation, do not silently switch to a broader OAuth App; use GitHub deep
links until broader permissions receive explicit review.

## Cloudflare Worker

The Worker is deliberately separate in `worker/` and exposes only:

- `GET /auth/login`
- `GET /auth/callback`
- `POST /auth/logout`
- `GET /api/session`
- `POST /api/vote`
- `POST /api/comments`

It is not a generic proxy. Repository owner/name are compile-time constants.
Every mutable issue must also appear in `ALLOWED_ISSUES`.

1. Copy `worker/wrangler.toml.example` to `worker/wrangler.toml`.
2. Create two KV namespaces and fill in `SESSIONS` and `RATE_LIMITS`.
3. Set:

   ```powershell
   wrangler secret put GITHUB_CLIENT_SECRET
   wrangler secret put SESSION_SECRET
   ```

   `SESSION_SECRET` must be at least 32 random characters.

4. Set `GITHUB_CLIENT_ID`, the exact HTTPS `ALLOWED_ORIGIN`, and a comma-separated
   `ALLOWED_ISSUES` list. Regenerate this list from the published report during
   operations; never accept an issue number supplied by the browser without
   checking it.
5. Route the Worker to a same-site API subdomain and deploy with your approved
   Cloudflare tooling.
6. Set the Pages `PUBLIC_WORKER_URL` variable and rebuild.

The implementation enforces exact Origin/CORS checks, signed opaque session
cookies (`HttpOnly`, `Secure`, `SameSite=Strict`), CSRF headers, OAuth state,
PKCE, session expiry, request/content-type/length constraints, link and mention
limits, fixed Markdown headings, action and repository allowlists, and
best-effort KV rate limits.

Cloudflare KV counters are eventually consistent. For a high-abuse deployment,
replace rate counting with a Durable Object or the Cloudflare Rate Limiting
product while retaining the same per-action limits. Runtime deployment cannot
be fully exercised by the static project; `npm run worker:check` keeps the code
type-safe.

## Rollback and failure behavior

- Pages never deploys if ingestion, schema validation, tests, typecheck, Worker
  typecheck, or production build fails.
- Revert the generated report commit to restore the previous snapshot, then
  rerun the workflow.
- Remove `PUBLIC_WORKER_URL` and rebuild to disable embedded actions instantly;
  all GitHub fallback links remain.
- Revoke the GitHub App client secret and delete session KV entries after a
  credential or session incident.
- Formula rollbacks require restoring the matching formula version and snapshots
  together so historical scores remain interpretable.
