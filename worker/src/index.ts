interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  ALLOWED_ORIGIN: string;
  ALLOWED_ISSUES: string;
  SESSIONS: KVNamespace;
  RATE_LIMITS: KVNamespace;
}

interface OAuthState {
  verifier: string;
  returnTo: string;
}

interface Session {
  accessToken: string;
  login: string;
  csrfToken: string;
  expiresAt: number;
  supportedIssues: number[];
}

interface GitHubReaction {
  id: number;
  content: string;
  user: { login: string };
}

const OWNER = 'web-platform-dx';
const REPO = 'developer-signals';
const SESSION_SECONDS = 8 * 60 * 60;
const MAX_BODY_BYTES = 8_192;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export default {
  async fetch(request, env): Promise<Response> {
    try {
      validateConfiguration(env);
      const url = new URL(request.url);

      if (request.method === 'OPTIONS') return preflight(request, env);
      if (url.pathname === '/auth/login' && request.method === 'GET') {
        return startLogin(request, env);
      }
      if (url.pathname === '/auth/callback' && request.method === 'GET') {
        return finishLogin(request, env);
      }
      if (url.pathname === '/api/session' && request.method === 'GET') {
        requireAllowedOrigin(request, env);
        return withCors(await sessionStatus(request, env), env);
      }
      if (url.pathname === '/auth/logout' && request.method === 'POST') {
        requireAllowedOrigin(request, env);
        const { id, session } = await requireSession(request, env);
        requireCsrf(request, session);
        await enforceRateLimit(request, env, 'logout', 8);
        await env.SESSIONS.delete(`session:${id}`);
        return withCors(
          json(
            { ok: true },
            200,
            expiredSessionCookie(),
          ),
          env,
        );
      }
      if (url.pathname === '/api/vote' && request.method === 'POST') {
        requireAllowedOrigin(request, env);
        await enforceRateLimit(request, env, 'vote', 20);
        return withCors(await toggleVote(request, env), env);
      }
      if (url.pathname === '/api/comments' && request.method === 'POST') {
        requireAllowedOrigin(request, env);
        await enforceRateLimit(request, env, 'comment', 5);
        return withCors(await submitComment(request, env), env);
      }
      return json({ error: 'Not found.' }, 404);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message =
        error instanceof HttpError
          ? error.message
          : 'The secure GitHub action service failed.';
      return withCors(json({ error: message }, status), env);
    }
  },
} satisfies ExportedHandler<Env>;

async function startLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const returnTo = validateReturnTo(url.searchParams.get('return_to'), env);
  const state = randomToken();
  const verifier = randomToken();
  const challenge = await sha256Base64Url(verifier);
  await env.SESSIONS.put(
    `oauth:${state}`,
    JSON.stringify({ verifier, returnTo } satisfies OAuthState),
    { expirationTtl: 600 },
  );
  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', `${url.origin}/auth/callback`);
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  return Response.redirect(authorize.toString(), 302);
}

async function finishLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!state || !code || state.length > 256 || code.length > 512) {
    throw new HttpError(400, 'Invalid OAuth callback.');
  }
  const stored = await env.SESSIONS.get(`oauth:${state}`);
  await env.SESSIONS.delete(`oauth:${state}`);
  if (!stored) throw new HttpError(400, 'OAuth state expired or was reused.');
  const oauth = JSON.parse(stored) as OAuthState;

  const tokenResponse = await fetch(
    'https://github.com/login/oauth/access_token',
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'developer-signals-analysis-worker',
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${url.origin}/auth/callback`,
        code_verifier: oauth.verifier,
      }),
    },
  );
  const tokenPayload = (await tokenResponse.json()) as {
    access_token?: string;
    error_description?: string;
  };
  if (!tokenResponse.ok || !tokenPayload.access_token) {
    throw new HttpError(
      502,
      tokenPayload.error_description ?? 'GitHub token exchange failed.',
    );
  }
  const userResponse = await github(
    '/user',
    tokenPayload.access_token,
    'GET',
  );
  const user = (await userResponse.json()) as { login?: string };
  if (!user.login) throw new HttpError(502, 'GitHub identity response was invalid.');

  const sessionId = randomToken();
  const session: Session = {
    accessToken: tokenPayload.access_token,
    login: user.login,
    csrfToken: randomToken(),
    expiresAt: Date.now() + SESSION_SECONDS * 1000,
    supportedIssues: [],
  };
  await env.SESSIONS.put(`session:${sessionId}`, JSON.stringify(session), {
    expirationTtl: SESSION_SECONDS,
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: validateReturnTo(oauth.returnTo, env),
      'set-cookie': await sessionCookie(sessionId, env),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

async function sessionStatus(request: Request, env: Env): Promise<Response> {
  const current = await optionalSession(request, env);
  if (!current) {
    return json({ authenticated: false }, 200, noStore());
  }
  return json(
    {
      authenticated: true,
      login: current.session.login,
      csrfToken: current.session.csrfToken,
      supportedIssues: current.session.supportedIssues,
    },
    200,
    noStore(),
  );
}

async function toggleVote(request: Request, env: Env): Promise<Response> {
  const current = await requireSession(request, env);
  requireCsrf(request, current.session);
  const payload = await readJson(request);
  const issueNumber = allowedIssue(payload.issueNumber, env);
  if (typeof payload.active !== 'boolean') {
    throw new HttpError(400, 'active must be a boolean.');
  }

  const reactions = await listIssueReactions(
    issueNumber,
    current.session.accessToken,
  );
  const existing = reactions.find(
    (reaction) =>
      reaction.content === '+1' &&
      reaction.user.login.toLowerCase() ===
        current.session.login.toLowerCase(),
  );
  let active = payload.active;
  if (active && !existing) {
    const response = await github(
      `/repos/${OWNER}/${REPO}/issues/${issueNumber}/reactions`,
      current.session.accessToken,
      'POST',
      { content: '+1' },
    );
    if (!response.ok) await throwGitHubError(response);
  } else if (!active && existing) {
    const response = await github(
      `/repos/${OWNER}/${REPO}/reactions/${existing.id}`,
      current.session.accessToken,
      'DELETE',
    );
    if (!response.ok) await throwGitHubError(response);
  }

  const supported = new Set(current.session.supportedIssues);
  if (active) supported.add(issueNumber);
  else supported.delete(issueNumber);
  current.session.supportedIssues = [...supported].slice(-100);
  await saveSession(current.id, current.session, env);
  return json({ active }, 200, noStore());
}

async function submitComment(request: Request, env: Env): Promise<Response> {
  const current = await requireSession(request, env);
  requireCsrf(request, current.session);
  const payload = await readJson(request);
  const issueNumber = allowedIssue(payload.issueNumber, env);
  const goal = validateText(payload.goal, 'goal', 30, 3_000, true);
  const workaround = validateText(
    payload.workaround,
    'workaround',
    0,
    3_000,
    false,
  );
  const body = `## What I want to do with this feature\n\n${goal}\n\n## What I'm having to do in the meantime\n\n${workaround || 'No workaround described.'}`;
  if ((body.match(/https?:\/\//g) ?? []).length > 10) {
    throw new HttpError(400, 'Too many links in one contribution.');
  }
  if ((body.match(/(^|\s)@[a-z0-9-]+/gi) ?? []).length > 5) {
    throw new HttpError(400, 'Too many user mentions in one contribution.');
  }

  const response = await github(
    `/repos/${OWNER}/${REPO}/issues/${issueNumber}/comments`,
    current.session.accessToken,
    'POST',
    { body },
  );
  if (!response.ok) await throwGitHubError(response);
  const result = (await response.json()) as { html_url?: string };
  if (!result.html_url) {
    throw new HttpError(502, 'GitHub returned no comment URL.');
  }
  return json({ url: result.html_url }, 201, noStore());
}

async function listIssueReactions(
  issueNumber: number,
  accessToken: string,
): Promise<GitHubReaction[]> {
  const reactions: GitHubReaction[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await github(
      `/repos/${OWNER}/${REPO}/issues/${issueNumber}/reactions?content=%2B1&per_page=100&page=${page}`,
      accessToken,
      'GET',
    );
    if (!response.ok) await throwGitHubError(response);
    const items = (await response.json()) as GitHubReaction[];
    if (!Array.isArray(items)) {
      throw new HttpError(502, 'GitHub reaction response was invalid.');
    }
    reactions.push(...items);
    if (items.length < 100) return reactions;
  }
  throw new HttpError(502, 'GitHub reaction pagination exceeded its limit.');
}

async function github(
  path: string,
  accessToken: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: unknown,
): Promise<Response> {
  if (
    !path.startsWith(`/repos/${OWNER}/${REPO}/`) &&
    path !== '/user'
  ) {
    throw new HttpError(500, 'Blocked non-allowlisted GitHub route.');
  }
  return fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'user-agent': 'developer-signals-analysis-worker',
      'x-github-api-version': '2022-11-28',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function optionalSession(
  request: Request,
  env: Env,
): Promise<{ id: string; session: Session } | undefined> {
  const signed = readCookie(request, '__Host-developer-signals');
  if (!signed) return undefined;
  const [id, signature] = signed.split('.');
  if (!id || !signature || !(await verify(id, signature, env.SESSION_SECRET))) {
    return undefined;
  }
  const stored = await env.SESSIONS.get(`session:${id}`);
  if (!stored) return undefined;
  const session = JSON.parse(stored) as Session;
  if (session.expiresAt <= Date.now()) {
    await env.SESSIONS.delete(`session:${id}`);
    return undefined;
  }
  return { id, session };
}

async function requireSession(
  request: Request,
  env: Env,
): Promise<{ id: string; session: Session }> {
  const current = await optionalSession(request, env);
  if (!current) throw new HttpError(401, 'GitHub sign-in is required.');
  return current;
}

function requireCsrf(request: Request, session: Session): void {
  const token = request.headers.get('x-csrf-token');
  if (!token || !timingSafeEqual(token, session.csrfToken)) {
    throw new HttpError(403, 'CSRF validation failed.');
  }
}

function requireAllowedOrigin(request: Request, env: Env): void {
  const origin = request.headers.get('origin');
  if (origin !== new URL(env.ALLOWED_ORIGIN).origin) {
    throw new HttpError(403, 'Origin is not allowed.');
  }
}

function validateReturnTo(value: string | null, env: Env): string {
  const allowed = new URL(env.ALLOWED_ORIGIN);
  const candidate = new URL(value ?? '/', allowed);
  if (candidate.origin !== allowed.origin) {
    throw new HttpError(400, 'Return URL is not allowed.');
  }
  return candidate.toString();
}

function allowedIssue(value: unknown, env: Env): number {
  if (!Number.isInteger(value)) {
    throw new HttpError(400, 'issueNumber must be an integer.');
  }
  const issueNumber = Number(value);
  const allowed = new Set(
    env.ALLOWED_ISSUES.split(',')
      .map((item) => Number(item.trim()))
      .filter(Number.isInteger),
  );
  if (!allowed.has(issueNumber)) {
    throw new HttpError(403, 'Issue is not allowlisted.');
  }
  return issueNumber;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json.');
  }
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    throw new HttpError(413, 'Request payload is too large.');
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new HttpError(413, 'Request payload is too large.');
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error();
    }
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Request body must be a JSON object.');
  }
}

function validateText(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  required: boolean,
): string {
  if (typeof value !== 'string') {
    throw new HttpError(400, `${name} must be text.`);
  }
  const cleaned = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/<\s*\/?\s*(?:script|iframe|object|embed)\b[^>]*>/gi, '')
    .trim();
  if ((required || cleaned.length > 0) && cleaned.length < minimum) {
    throw new HttpError(400, `${name} is too short.`);
  }
  if (cleaned.length > maximum) {
    throw new HttpError(400, `${name} is too long.`);
  }
  return cleaned;
}

async function enforceRateLimit(
  request: Request,
  env: Env,
  action: string,
  limit: number,
): Promise<void> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const identity = await hmac(ip, env.SESSION_SECRET);
  const minute = Math.floor(Date.now() / 60_000);
  const key = `rate:${action}:${identity}:${minute}`;
  const count = Number((await env.RATE_LIMITS.get(key)) ?? 0);
  if (count >= limit) {
    throw new HttpError(429, 'Rate limit exceeded. Try again shortly.');
  }
  await env.RATE_LIMITS.put(key, String(count + 1), { expirationTtl: 120 });
}

async function saveSession(id: string, session: Session, env: Env) {
  const ttl = Math.max(60, Math.floor((session.expiresAt - Date.now()) / 1000));
  await env.SESSIONS.put(`session:${id}`, JSON.stringify(session), {
    expirationTtl: ttl,
  });
}

function preflight(request: Request, env: Env): Response {
  requireAllowedOrigin(request, env);
  const requestedMethod =
    request.headers.get('access-control-request-method') ?? '';
  if (!['GET', 'POST'].includes(requestedMethod)) {
    throw new HttpError(405, 'CORS method is not allowed.');
  }
  return withCors(new Response(null, { status: 204 }), env);
}

function withCors(response: Response, env: Env): Response {
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', new URL(env.ALLOWED_ORIGIN).origin);
  headers.set('access-control-allow-credentials', 'true');
  headers.set(
    'access-control-allow-headers',
    'content-type, x-csrf-token',
  );
  headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
  headers.set('vary', 'Origin');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(
  value: unknown,
  status: number,
  extraHeaders?: HeadersInit,
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...JSON_HEADERS, ...Object.fromEntries(new Headers(extraHeaders)) },
  });
}

function noStore(): HeadersInit {
  return { 'cache-control': 'no-store' };
}

async function sessionCookie(id: string, env: Env): Promise<string> {
  const signature = await hmac(id, env.SESSION_SECRET);
  return `__Host-developer-signals=${id}.${signature}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
}

function expiredSessionCookie(): HeadersInit {
  return {
    'set-cookie':
      '__Host-developer-signals=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
    'cache-control': 'no-store',
  };
}

function readCookie(request: Request, name: string): string | undefined {
  const cookies = request.headers.get('cookie')?.split(';') ?? [];
  for (const cookie of cookies) {
    const [key, ...parts] = cookie.trim().split('=');
    if (key === name) return parts.join('=');
  }
  return undefined;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64Url(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return base64Url(new Uint8Array(digest));
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(value),
  );
  return base64Url(new Uint8Array(signature));
}

async function verify(
  value: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  return timingSafeEqual(await hmac(value, secret), signature);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function throwGitHubError(response: Response): Promise<never> {
  const payload = (await response.json().catch(() => ({}))) as {
    message?: string;
  };
  const status =
    response.status === 401
      ? 401
      : response.status === 403
        ? 403
        : response.status === 422
          ? 400
          : 502;
  throw new HttpError(
    status,
    payload.message
      ? `GitHub rejected the action: ${payload.message}`
      : `GitHub action failed with HTTP ${response.status}.`,
  );
}

function validateConfiguration(env: Env): void {
  if (
    !env.GITHUB_CLIENT_ID ||
    !env.GITHUB_CLIENT_SECRET ||
    !env.SESSION_SECRET ||
    !env.ALLOWED_ORIGIN ||
    !env.ALLOWED_ISSUES
  ) {
    throw new HttpError(503, 'Worker configuration is incomplete.');
  }
  if (env.SESSION_SECRET.length < 32) {
    throw new HttpError(503, 'SESSION_SECRET must be at least 32 characters.');
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
