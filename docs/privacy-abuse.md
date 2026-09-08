# Provenance, privacy, and abuse handling

## Public provenance

The report republishes a limited, derived view of already public data:

- feature IDs and vote totals from `web-features-signals.json`;
- public GitHub issue/comment identities, URLs, timestamps, authors, and `+1`
  reaction counts;
- names, descriptions, groups, and Baseline support from `web-features`;
- version-controlled human overrides and optional labeled enrichment.

Every use case and workaround links to its source. Generated summaries never
replace the source, and fixture metadata distinguishes representative synthetic
comments from live evidence.

## Data minimization

The static report does not use analytics, advertising, fingerprinting, or
third-party fonts. It does not publish email addresses, access tokens, session
identifiers, IP addresses, or private GitHub data.

The Worker stores:

- a random session ID in a signed secure cookie;
- GitHub login, user access token, CSRF token, expiry, and issue numbers changed
  during that session in session KV;
- an HMAC of the connecting IP, action name, minute bucket, and count in
  rate-limit KV.

Sessions expire after eight hours. Rate keys expire after two minutes. Logs
should contain route, status, latency, and a random request ID only—never
authorization headers, cookies, comment bodies, OAuth codes, raw IP addresses,
or GitHub tokens.

## Moderation and classification

Deterministic qualification excludes bots, minimized content, thread
management, moderation, template-only text, generic support, and debate without
a concrete developer scenario. Deduplication limits each author to their
strongest contribution per feature.

Moderators may add a documented override for false positives/negatives. An
override must identify the public source, rationale, reviewer, and date. Never
use an override to hide disagreement merely because it is inconvenient.
Moderation remains the responsibility of the GitHub source repository.

## Abuse controls

The Worker accepts only two fixed mutations: toggling a `+1` reaction and
posting a two-section comment to an allowlisted issue. It checks exact origin,
session, CSRF token, JSON content type, payload byte size, text lengths,
control/dangerous HTML, excessive links, excessive mentions, and per-action
rate limits.

For an incident:

1. remove `PUBLIC_WORKER_URL` and redeploy the static site;
2. revoke/rotate the GitHub App client secret and `SESSION_SECRET`;
3. clear session KV;
4. inspect GitHub’s audit trail and moderate source comments/reactions there;
5. tighten issue allowlists or payload/rate rules before re-enabling.

Users can always bypass the optional Worker and act directly on GitHub. GitHub
is the final authority for identity, rate limits, abuse handling, deletion, and
content state.
