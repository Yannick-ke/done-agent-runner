import test from 'node:test';
import assert from 'node:assert/strict';
import { paginateProjects, projectListMeta } from '../src/project-pagination.js';

function makeProjects(count) {
  return Array.from({ length: count }, (_, index) => ({ id: `project_${index + 1}`, name: `项目 ${index + 1}` }));
}

test('project pagination shows ten projects by default and adds ten more', () => {
  const page = paginateProjects(makeProjects(25));
  assert.equal(page.visibleCount, 10);
  assert.equal(page.projects.length, 10);
  assert.equal(page.projects.at(-1).id, 'project_10');
  assert.equal(page.totalCount, 25);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextLimit, 20);

  const nextPage = paginateProjects(makeProjects(25), '', page.nextLimit);
  assert.equal(nextPage.visibleCount, 20);
  assert.equal(nextPage.projects.length, 20);
  assert.equal(nextPage.projects.at(-1).id, 'project_20');
  assert.equal(nextPage.nextLimit, 25);

  const finalPage = paginateProjects(makeProjects(25), '', nextPage.nextLimit);
  assert.equal(finalPage.visibleCount, 25);
  assert.equal(finalPage.hasMore, false);
});

test('project pagination rounds requested limits to ten-item batches', () => {
  const page = paginateProjects(makeProjects(25), '', 15);
  assert.equal(page.visibleCount, 20);
  assert.equal(page.projects.length, 20);
});

test('project pagination does not add a load-more page for short lists', () => {
  const page = paginateProjects(makeProjects(8));
  assert.equal(page.visibleCount, 8);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextLimit, 8);
});

test('selected project remains visible by expanding to its batch', () => {
  const page = paginateProjects(makeProjects(25), 'project_16');
  assert.equal(page.visibleCount, 20);
  assert.equal(page.projects.at(-1).id, 'project_20');
  assert.equal(page.projects.some((project) => project.id === 'project_16'), true);
});

test('project list link preserves existing query parameters', () => {
  const page = projectListMeta(
    new URL('http://127.0.0.1:4173/projects/project_1?task_sync_added=1&task_sync_existing=2'),
    makeProjects(25),
    'project_1',
  );
  assert.equal(page.nextHref, '/projects/project_1?task_sync_added=1&task_sync_existing=2&project_limit=20');
});

test('project list metadata carries search through pagination and provides a clear URL', () => {
  const page = projectListMeta(
    new URL('http://127.0.0.1:4173/projects/project_1?q=claude%20code&project_limit=10&task_sync_added=1'),
    makeProjects(25),
    'project_1',
  );
  assert.equal(page.query, 'claude code');
  assert.equal(page.isSearching, true);
  assert.equal(page.searchAction, '/projects/project_1');
  assert.equal(page.nextHref, '/projects/project_1?q=claude+code&project_limit=20&task_sync_added=1');
  assert.equal(page.clearHref, '/projects/project_1?task_sync_added=1');
});

test('project list metadata treats whitespace-only search as empty', () => {
  const page = projectListMeta(new URL('http://127.0.0.1:4173/projects?q=%20%20'), makeProjects(3));
  assert.equal(page.query, '');
  assert.equal(page.isSearching, false);
});
