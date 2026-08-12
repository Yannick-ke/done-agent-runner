(() => {
  const searchForm = document.querySelector('[data-project-search]');
  const searchInput = searchForm?.querySelector('input[name="q"]');
  if (searchForm && searchInput) {
    const initialQuery = searchInput.value.trim();
    let timer = null;
    let composing = false;
    const scheduleSearch = () => {
      clearTimeout(timer);
      if (searchInput.value.trim() === initialQuery) return;
      timer = setTimeout(() => searchForm.requestSubmit(), 300);
    };
    searchInput.addEventListener('compositionstart', () => { composing = true; });
    searchInput.addEventListener('compositionend', () => { composing = false; scheduleSearch(); });
    searchInput.addEventListener('input', () => { if (!composing) scheduleSearch(); });
  }

  document.querySelectorAll('.rename-control').forEach((control) => {
    const input = control.querySelector('.rename-form input');
    control.addEventListener('toggle', () => {
      if (!control.open || !input) return;
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    });
    input?.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      input.value = input.defaultValue;
      control.open = false;
    });
  });

  if (document.body.dataset.refresh !== 'true') return;

  const isRenaming = () => Boolean(document.querySelector('.rename-control[open]'));
  const id = location.pathname.match(/^\/tasks\/([^/]+)$/)?.[1];
  if (!id) {
    setInterval(() => { if (!isRenaming()) location.reload(); }, 5000);
    return;
  }

  let lastStatus = null;
  setInterval(async () => {
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (!response.ok) return;
      const task = await response.json();
      if (lastStatus && task.status !== lastStatus) {
        if (isRenaming()) return;
        location.reload();
      }
      lastStatus = task.status;
    } catch {}
  }, 3000);
})();
