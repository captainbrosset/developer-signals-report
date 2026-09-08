const explorers = document.querySelectorAll<HTMLElement>('[data-feature-explorer]');

for (const explorer of explorers) {
  const form = explorer.querySelector<HTMLFormElement>('[data-filter-form]');
  const list = explorer.querySelector<HTMLOListElement>('[data-feature-list]');
  const summary =
    explorer.querySelector<HTMLElement>('[data-result-summary]');
  const empty = explorer.querySelector<HTMLElement>('[data-empty-state]');
  if (!form || !list || !summary || !empty) continue;

  const controls = {
    q: form.elements.namedItem('q') as HTMLInputElement,
    category: form.elements.namedItem('category') as HTMLSelectElement,
    browser: form.elements.namedItem('browser') as HTMLSelectElement,
    confidence: form.elements.namedItem('confidence') as HTMLSelectElement,
    supported: form.elements.namedItem('supported') as HTMLSelectElement,
    sort: form.elements.namedItem('sort') as HTMLSelectElement,
  };
  const cards = [...list.querySelectorAll<HTMLElement>('[data-feature-card]')];
  const supported = readSupportedIssues();
  const params = new URLSearchParams(location.search);

  for (const [name, control] of Object.entries(controls)) {
    const value = params.get(name);
    if (value) control.value = value;
  }

  function readSupportedIssues(): Set<number> {
    try {
      const value = JSON.parse(
        localStorage.getItem('developer-signals-supported') ?? '[]',
      );
      if (!Array.isArray(value)) return new Set();
      return new Set(value.filter((item) => Number.isInteger(item)));
    } catch {
      return new Set();
    }
  }

  const apply = () => {
    const query = controls.q.value.trim().toLowerCase();
    const category = controls.category.value;
    const browser = controls.browser.value;
    const confidence = controls.confidence.value;
    const mine = controls.supported.value === 'mine';
    const visible: HTMLElement[] = [];

    for (const card of cards) {
      const matches =
        (!query || card.dataset.search?.includes(query)) &&
        (!category ||
          card.dataset.categories?.split('|').includes(category)) &&
        (!browser ||
          (browser.startsWith('engine:')
            ? card.dataset.engines
                ?.split('|')
                .includes(browser.replace('engine:', ''))
            : card.dataset.browsers?.split('|').includes(browser))) &&
        (!confidence || card.dataset.confidence === confidence) &&
        (!mine || supported.has(Number(card.dataset.issue)));
      card.hidden = !matches;
      if (matches) visible.push(card);
    }

    const numericSorts = new Set([
      'priority',
      'votes',
      'use-cases',
      'workarounds',
      'momentum',
    ]);
    visible.sort((a, b) => {
      const sort = controls.sort.value;
      if (numericSorts.has(sort)) {
        const key =
          sort === 'use-cases'
            ? 'useCases'
            : sort === 'priority'
              ? 'priority'
              : sort;
        return Number(b.dataset[key]) - Number(a.dataset[key]);
      }
      return (a.dataset.name ?? '').localeCompare(b.dataset.name ?? '');
    });
    for (const card of visible) list.append(card);

    summary.textContent = `Showing ${visible.length} of ${cards.length} features.`;
    empty.hidden = visible.length !== 0;

    const nextParams = new URLSearchParams();
    for (const [name, control] of Object.entries(controls)) {
      if (control.value && !(name === 'sort' && control.value === 'priority')) {
        nextParams.set(name, control.value);
      }
    }
    history.replaceState(
      null,
      '',
      `${location.pathname}${nextParams.size ? `?${nextParams}` : ''}`,
    );
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    apply();
  });
  form.addEventListener('input', apply);
  form.addEventListener('change', apply);
  apply();
}
