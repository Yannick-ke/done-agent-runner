const DEFAULT_PAGE_SIZE = 10;

function requestedProjectLimit(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed < DEFAULT_PAGE_SIZE) return DEFAULT_PAGE_SIZE;
  return Math.ceil(parsed / DEFAULT_PAGE_SIZE) * DEFAULT_PAGE_SIZE;
}

export function paginateProjects(projects = [], selectedProjectId = '', requestedLimit = DEFAULT_PAGE_SIZE) {
  const totalCount = projects.length;
  let visibleCount = Math.min(totalCount, requestedProjectLimit(requestedLimit));
  const selectedIndex = projects.findIndex((project) => project.id === selectedProjectId);
  if (selectedIndex >= visibleCount) {
    visibleCount = Math.min(totalCount, Math.ceil((selectedIndex + 1) / DEFAULT_PAGE_SIZE) * DEFAULT_PAGE_SIZE);
  }

  return {
    projects: projects.slice(0, visibleCount),
    visibleCount,
    totalCount,
    hasMore: visibleCount < totalCount,
    nextLimit: Math.min(totalCount, visibleCount + DEFAULT_PAGE_SIZE),
  };
}

export function projectListMeta(url, projects, selectedProjectId = '') {
  const query = String(url.searchParams.get('q') || '').trim();
  const page = paginateProjects(projects, selectedProjectId, url.searchParams.get('project_limit'));
  const nextUrl = new URL(url);
  nextUrl.searchParams.set('project_limit', String(page.nextLimit));
  const clearUrl = new URL(url);
  clearUrl.searchParams.delete('q');
  clearUrl.searchParams.delete('project_limit');
  return {
    ...page,
    query,
    isSearching: Boolean(query),
    searchAction: url.pathname,
    clearHref: `${clearUrl.pathname}${clearUrl.search}`,
    nextHref: `${nextUrl.pathname}${nextUrl.search}`,
  };
}
