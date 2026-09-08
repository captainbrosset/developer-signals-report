interface SessionPayload {
  authenticated: boolean;
  csrfToken?: string;
  login?: string;
  supportedIssues?: number[];
}

interface ContributionResponse {
  url?: string;
  active?: boolean;
  error?: string;
}

export {};

const panels = document.querySelectorAll<HTMLElement>('[data-contribution]');

for (const panel of panels) {
  const workerUrl = panel.dataset.workerUrl?.replace(/\/$/, '') ?? '';
  const issueNumber = Number(panel.dataset.issueNumber);
  const issueUrl = panel.dataset.issueUrl ?? '';
  const authStatus = panel.querySelector<HTMLElement>('[data-auth-status]');
  const login = panel.querySelector<HTMLAnchorElement>('[data-login]');
  const vote = panel.querySelector<HTMLButtonElement>('[data-vote]');
  const form = panel.querySelector<HTMLFormElement>('[data-use-case-form]');
  const preview = panel.querySelector<HTMLElement>(
    '[data-markdown-preview] code',
  );
  const submitStatus =
    panel.querySelector<HTMLElement>('[data-submit-status]');
  const submit = panel.querySelector<HTMLButtonElement>('[data-submit]');
  if (
    !authStatus ||
    !login ||
    !vote ||
    !form ||
    !preview ||
    !submitStatus ||
    !submit
  ) {
    continue;
  }
  const voteButton = vote;

  let session: SessionPayload = { authenticated: false };
  const goal = form.elements.namedItem('goal') as HTMLTextAreaElement;
  const workaround = form.elements.namedItem(
    'workaround',
  ) as HTMLTextAreaElement;

  const markdown = () =>
    `## What I want to do with this feature\n\n${goal.value.trim() || '…'}\n\n## What I'm having to do in the meantime\n\n${workaround.value.trim() || 'No workaround described.'}`;

  const updatePreview = () => {
    preview.textContent = markdown();
  };
  form.addEventListener('input', updatePreview);
  updatePreview();

  if (!workerUrl) {
    authStatus.textContent =
      'Secure write actions are not configured on this deployment. GitHub fallback links remain available.';
    submit.textContent = 'Open GitHub to submit';
    continue;
  }

  login.href = `${workerUrl}/auth/login?return_to=${encodeURIComponent(location.href)}`;

  try {
    const response = await fetch(`${workerUrl}/api/session`, {
      credentials: 'include',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    session = (await response.json()) as SessionPayload;
  } catch {
    authStatus.textContent =
      'The secure action service is unavailable. Use the GitHub fallback.';
    submit.textContent = 'Open GitHub to submit';
    continue;
  }

  if (!session.authenticated) {
    authStatus.textContent = 'Sign in with GitHub to vote or post from this report.';
    login.hidden = false;
    submit.textContent = 'Sign in to submit';
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      location.href = login.href;
    });
    continue;
  }

  const supported = new Set<number>(session.supportedIssues ?? []);
  persistSupported(supported);
  authStatus.textContent = `Signed in as @${session.login}.`;
  voteButton.hidden = false;
  renderVote();
  submit.textContent = 'Post use case to GitHub';

  voteButton.addEventListener('click', async () => {
    const active = !supported.has(issueNumber);
    voteButton.disabled = true;
    voteButton.textContent = active ? 'Adding +1…' : 'Removing +1…';
    try {
      const response = await mutate('/api/vote', {
        issueNumber,
        active,
      });
      if (response.active) supported.add(issueNumber);
      else supported.delete(issueNumber);
      persistSupported(supported);
      authStatus.textContent = response.active
        ? 'Your +1 was added on GitHub.'
        : 'Your +1 was removed on GitHub.';
    } catch (error) {
      authStatus.textContent =
        error instanceof Error ? error.message : 'Vote update failed.';
    } finally {
      voteButton.disabled = false;
      renderVote();
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    submit.disabled = true;
    submitStatus.textContent = 'Posting the exact preview to GitHub…';
    try {
      const response = await mutate('/api/comments', {
        issueNumber,
        goal: goal.value.trim(),
        workaround: workaround.value.trim(),
      });
      submitStatus.replaceChildren(
        document.createTextNode('Posted successfully. '),
        linkTo(response.url ?? issueUrl, 'View the GitHub comment'),
        document.createTextNode(
          ' The report will reconcile on the next ingestion.',
        ),
      );
      addOptimisticEvidence(
        goal.value.trim(),
        session.login ?? 'signed-in user',
        response.url ?? issueUrl,
      );
      form.reset();
      updatePreview();
    } catch (error) {
      submitStatus.textContent =
        error instanceof Error ? error.message : 'Comment submission failed.';
    } finally {
      submit.disabled = false;
    }
  });

  function renderVote() {
    const active = supported.has(issueNumber);
    voteButton.textContent = active ? 'Remove my +1' : 'Add my +1';
    voteButton.setAttribute('aria-pressed', String(active));
  }

  async function mutate(
    path: string,
    body: Record<string, unknown>,
  ): Promise<ContributionResponse> {
    const response = await fetch(`${workerUrl}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': session.csrfToken ?? '',
      },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as ContributionResponse;
    if (!response.ok) {
      throw new Error(
        payload.error ??
          `GitHub action failed with HTTP ${response.status}. Use the fallback link.`,
      );
    }
    return payload;
  }
}

function persistSupported(supported: Set<number>) {
  localStorage.setItem(
    'developer-signals-supported',
    JSON.stringify([...supported]),
  );
}

function linkTo(url: string, label: string): HTMLAnchorElement {
  const link = document.createElement('a');
  link.href = url;
  link.textContent = label;
  link.target = '_blank';
  link.rel = 'noreferrer';
  return link;
}

function addOptimisticEvidence(goal: string, login: string, url: string) {
  const list = document.querySelector<HTMLUListElement>('[data-use-case-list]');
  if (!list) return;
  const item = document.createElement('li');
  item.className = 'evidence';
  const label = document.createElement('span');
  label.className = 'generated-label';
  label.textContent = 'Pending next ingestion';
  const summary = document.createElement('p');
  summary.textContent = goal;
  const meta = document.createElement('p');
  meta.className = 'evidence__meta';
  meta.append(
    document.createTextNode(`@${login} · `),
    linkTo(url, 'View new source comment'),
  );
  item.append(label, summary, meta);
  list.prepend(item);
}
