import { claudeFailureInfo } from './utils.js';
import { config } from './config.js';

const statusMeta = {
  queued: ['等待执行', 'muted'],
  running: ['执行中', 'running'],
  needs_input: ['需要补充', 'warning'],
  completed: ['已完成', 'success'],
  accepted: ['已接受', 'success'],
  failed: ['未完成', 'danger'],
  canceled: ['已取消', 'muted'],
};

export function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
}

function renderInlineMarkdown(value = '') {
  const codeSpans = [];
  let source = String(value ?? '').replace(/`([^`\n]+)`/g, (_, code) => {
    const token = `\u0000CODE_${codeSpans.length}\u0000`;
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  source = escapeHtml(source)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');

  return source.replace(/\u0000CODE_(\d+)\u0000/g, (_, index) => codeSpans[Number(index)]);
}

/**
 * Render the small, safe Markdown subset commonly returned by Claude.
 * Raw HTML is always escaped; links are restricted to http(s) URLs.
 */
export function renderMarkdown(value = '') {
  const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  let paragraph = [];
  let listType = null;
  let listItems = [];
  let inFence = false;
  let fenceLines = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    output.push(`<p>${paragraph.map(renderInlineMarkdown).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!listType || !listItems.length) return;
    output.push(`<${listType}>${listItems.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</${listType}>`);
    listType = null;
    listItems = [];
  };
  const flushBlocks = () => {
    flushParagraph();
    flushList();
  };

  for (const line of lines) {
    const fence = line.match(/^\s*```(?:[\w+-]+)?\s*$/);
    if (inFence) {
      if (fence) {
        output.push(`<pre><code>${escapeHtml(fenceLines.join('\n'))}</code></pre>`);
        inFence = false;
        fenceLines = [];
      } else {
        fenceLines.push(line);
      }
      continue;
    }
    if (fence) {
      flushBlocks();
      inFence = true;
      continue;
    }
    if (!line.trim()) {
      flushBlocks();
      continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushBlocks();
      const level = heading[1].length;
      output.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushBlocks();
      output.push('<hr>');
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const nextType = unordered ? 'ul' : 'ol';
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      listItems.push((unordered || ordered)[1].trim());
      continue;
    }
    if (listType) flushList();

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      output.push(`<blockquote>${renderInlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }
    paragraph.push(line.trim());
  }

  if (inFence) output.push(`<pre><code>${escapeHtml(fenceLines.join('\n'))}</code></pre>`);
  flushBlocks();
  return output.join('');
}

function layout(title, content, options = {}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Done</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body data-refresh="${options.refresh ? 'true' : 'false'}" class="${options.workspace ? 'workspace-body' : 'page-body'}">
  ${options.workspace ? '' : `<header class="simple-topbar">
    <a href="/" class="brand"><span class="brand-mark">✓</span><span>Done</span></a>
    <a class="simple-topbar-back" href="/">返回工作台</a>
  </header>`}
  <main class="shell${options.workspace ? ' workspace-shell' : ''}">${content}</main>
  ${options.workspace ? '' : '<footer>任务在本机后台执行。过程默认隐藏，结果和代码差异完整保留。</footer>'}
  ${options.workspace || options.refresh ? '<script src="/app.js"></script>' : ''}
</body>
</html>`;
}

function badge(status) {
  const [label, tone] = statusMeta[status] || [status, 'muted'];
  return `<span class="badge ${tone}">${escapeHtml(label)}</span>`;
}

function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function workspaceHref(pathname, projectListMeta = null) {
  const query = String(projectListMeta?.query || '').trim();
  if (!query) return pathname;
  const params = new URLSearchParams({ q: query });
  return `${pathname}?${params}`;
}

const boardColumns = [
  { status: 'queued', label: '等待执行', tone: 'muted', empty: '暂无待执行任务' },
  { status: 'running', label: '执行中', tone: 'running', empty: '暂无执行中的任务' },
  { status: 'needs_input', label: '需要补充', tone: 'warning', empty: '暂无待补充任务' },
  { status: 'completed', label: '已完成', tone: 'success', empty: '暂无已完成任务' },
  { status: 'accepted', label: '已接受', tone: 'success', empty: '暂无已接受任务' },
  { status: 'failed', label: '未完成', tone: 'danger', empty: '暂无未完成任务' },
  { status: 'canceled', label: '已取消', tone: 'muted', empty: '暂无已取消任务' },
];

function workspaceNavigation({ projects, selectedProject, syncNotice = null, projectListMeta = null }) {
  const query = String(projectListMeta?.query || '');
  const isSearching = Boolean(projectListMeta?.isSearching);
  const projectItems = projects.length ? projects.map((project) => `
    <a class="sidebar-project${selectedProject?.id === project.id ? ' active' : ''}" href="${escapeHtml(workspaceHref(`/projects/${encodeURIComponent(project.id)}`, projectListMeta))}">
      <span class="sidebar-project-icon">${escapeHtml(project.name.slice(0, 1).toUpperCase())}</span>
      <span class="sidebar-project-copy">
        <strong>${escapeHtml(project.name)}</strong>
        <small title="${escapeHtml(project.path || '')}">${Number(project.active_count || 0) ? `${Number(project.active_count)} 个执行中` : `${Number(project.task_count || 0)} 个任务`} · 更新 ${escapeHtml(formatDate(project.updated_at || project.last_task_updated_at || project.created_at))}</small>
      </span>
      ${Number(project.attention_count || 0) ? `<span class="attention-dot" title="有任务需要处理">${Number(project.attention_count)}</span>` : ''}
    </a>`).join('') : isSearching ? `
      <div class="sidebar-empty compact search-empty"><p>没有找到相关项目</p><span>试试项目名称或本地路径。</span><a href="${escapeHtml(projectListMeta.clearHref)}">清空搜索</a></div>` : `
      <div class="sidebar-empty compact"><p>还没有项目</p><span>添加一个本地 Git 仓库。</span></div>`;

  return `
    <aside class="workspace-column project-sidebar">
      <div class="column-head project-column-head">
        <div>
          <a class="workspace-brand" href="/" aria-label="Done 工作台"><span>✓</span><strong>Done</strong></a>
          <h1>项目</h1>
        </div>
        <a class="icon-button" href="/projects/new" title="添加项目" aria-label="添加项目">＋</a>
      </div>
      <form class="project-search" method="get" action="${escapeHtml(projectListMeta?.searchAction || '/projects')}" data-project-search>
        <span class="project-search-icon" aria-hidden="true">⌕</span>
        <input type="search" name="q" value="${escapeHtml(query)}" placeholder="搜索项目名称或路径" autocomplete="off" aria-label="搜索项目名称或路径">
        ${isSearching ? `<a class="project-search-clear" href="${escapeHtml(projectListMeta.clearHref)}" aria-label="清空项目搜索">×</a>` : ''}
      </form>
      ${isSearching ? `<div class="project-search-meta">找到 ${Number(projectListMeta.totalCount || 0)} 个项目</div>` : ''}
      <div class="sidebar-project-list">${projectItems}
        ${projectListMeta?.hasMore ? `<a class="load-more-projects" href="${escapeHtml(projectListMeta.nextHref)}">加载更多 <span>（已显示 ${projectListMeta.visibleCount}/${projectListMeta.totalCount}）</span></a>` : ''}
      </div>
      <div class="project-sync-area">
        ${syncNotice ? `<div class="sync-notice ${syncNotice.added ? 'success' : ''}">${escapeHtml(syncNotice.message)}</div>` : ''}
        <form method="post" action="/projects/sync">
          <input type="hidden" name="return_to" value="${escapeHtml(selectedProject?.id || '')}">
          <button class="sync-projects-button" type="submit"><span>↻</span>同步历史项目</button>
        </form>
        <p>仅新增项目，不覆盖已有任务和沟通。</p>
      </div>
    </aside>`;
}

function conversationCard(conversation) {
  return `<a class="conversation-card" href="/projects/${encodeURIComponent(conversation.projectId || '')}/conversations/${encodeURIComponent(conversation.sessionId)}">
    <div class="conversation-card-top"><strong>${escapeHtml(conversation.title)}</strong><span>${escapeHtml(conversation.source || 'Claude Code')}</span></div>
    <p>${escapeHtml(conversation.preview || '查看这次会话的沟通内容')}</p>
    <div class="conversation-card-meta"><span>${Number(conversation.messageCount || 0)} 条消息</span><time>${formatDate(conversation.modifiedAt || conversation.createdAt)}</time></div>
  </a>`;
}

function conversationPanel(project, conversations) {
  if (!conversations.length) return `<section class="conversation-section">
    <div class="conversation-section-head"><div><p class="eyebrow">历史沟通</p><h2>还没有找到 Claude Code 会话</h2><p>这个项目还没有可关联的本机会话记录。</p></div></div>
  </section>`;
  const items = conversations.map((conversation) => conversationCard({ ...conversation, projectId: project.id })).join('');
  return `<section class="conversation-section">
    <div class="conversation-section-head"><div><p class="eyebrow">历史沟通</p><h2>之前和 Claude Code 的沟通</h2><p>按项目路径自动匹配，只展示对话内容，不展示工具调用过程。</p></div><span class="conversation-count">${conversations.length} 个会话</span></div>
    <div class="conversation-grid">${items}</div>
  </section>`;
}

function conversationDetailContent(project, conversation) {
  const messages = conversation.messages || [];
  return `<section class="conversation-detail">
    <a class="back" href="/projects/${encodeURIComponent(project.id)}">← 返回项目看板</a>
    <div class="conversation-detail-head"><div><p class="eyebrow">历史沟通</p><h1>${escapeHtml(conversation.title)}</h1><p>${escapeHtml(project.name)} · ${escapeHtml(conversation.sessionId)}</p></div><span class="badge">${Number(conversation.messageCount || messages.length)} 条消息</span></div>
    <div class="conversation-messages">
      ${messages.length ? messages.map((message) => `<article class="conversation-message ${message.role === 'assistant' ? 'assistant' : 'user'}"><div class="conversation-role">${message.role === 'assistant' ? 'Claude Code' : '用户'}</div><div class="conversation-bubble markdown-body">${renderMarkdown(message.text)}</div>${message.timestamp ? `<time>${formatDate(message.timestamp)}</time>` : ''}</article>`).join('') : '<p class="status-empty">没有可显示的对话内容。</p>'}
    </div>
  </section>`;
}

function boardTask(task, selectedTask, projectListMeta = null) {
  return `
    <a class="board-task${selectedTask?.id === task.id ? ' active' : ''}" href="${escapeHtml(workspaceHref(`/tasks/${encodeURIComponent(task.id)}`, projectListMeta))}">
      <strong>${escapeHtml(task.title)}</strong>
      <p>${escapeHtml(task.phase || statusMeta[task.status]?.[0] || '')}</p>
      <time title="最后更新：${escapeHtml(formatDate(task.updated_at || task.created_at))}">更新 ${formatDate(task.updated_at || task.created_at)}${Number(task.run_count || 0) > 1 ? ` · ${Number(task.run_count)} 轮` : ''}</time>
    </a>`;
}

function renameControl({ target, id, value }) {
  const isProject = target === 'project';
  const label = isProject ? '项目' : '任务';
  const field = isProject ? 'name' : 'title';
  const maxLength = isProject ? 80 : 160;
  const action = isProject
    ? `/projects/${encodeURIComponent(id)}/rename`
    : `/tasks/${encodeURIComponent(id)}/rename`;
  return `<details class="rename-control">
    <summary class="rename-trigger" title="重命名${label}" aria-label="重命名${label}">✎</summary>
    <form class="rename-form" method="post" action="${action}">
      <input type="text" name="${field}" value="${escapeHtml(value)}" maxlength="${maxLength}" required aria-label="新的${label}名称">
      <button class="button small" type="submit">保存</button>
    </form>
  </details>`;
}

function renameFeedback(notice, target) {
  if (!notice || notice.target !== target) return '';
  return `<div class="rename-notice ${notice.error ? 'error' : 'success'}" role="${notice.error ? 'alert' : 'status'}">${escapeHtml(notice.message)}</div>`;
}

function taskBoard({ selectedProject, tasks, selectedTask, conversations = [], taskSyncNotice = null, renameNotice = null, projectListMeta = null }) {
  if (!selectedProject) return `<section class="board-area">
    <div class="board-empty"><div class="empty-icon">✓</div><p class="eyebrow">面向结果</p><h1>从左侧选择一个项目。</h1><p>当前项目的任务会按状态平铺在这里。</p></div>
  </section>`;

  const newTaskHref = `/tasks/new?project=${encodeURIComponent(selectedProject.id)}`;
  const columns = boardColumns.map((column) => {
    const columnTasks = tasks.filter((task) => task.status === column.status);
    return `<section class="status-column" data-status="${column.status}">
      <header class="status-column-head">
        <div><span class="status-dot ${column.tone}"></span><h2>${column.label}</h2></div>
        <span>${columnTasks.length}</span>
      </header>
      <div class="status-task-list">
        ${columnTasks.length ? columnTasks.map((task) => boardTask(task, selectedTask, projectListMeta)).join('') : `<p class="status-empty">${column.empty}</p>`}
      </div>
    </section>`;
  }).join('');

  return `<section class="board-area">
    <header class="board-head">
      <div class="board-title-block"><p class="eyebrow">当前项目</p><div class="title-edit-row"><h1>${escapeHtml(selectedProject.name)}</h1>${renameControl({ target: 'project', id: selectedProject.id, value: selectedProject.name })}</div>${renameFeedback(renameNotice, 'project')}<p>任务按照更新时间倒序平铺；项目更新于 ${escapeHtml(formatDate(selectedProject.updated_at || selectedProject.created_at))}。</p></div>
      <div class="board-actions">
        ${taskSyncNotice ? `<div class="task-sync-notice ${taskSyncNotice.added ? 'success' : ''}">${escapeHtml(taskSyncNotice.message)}</div>` : ''}
        <div class="board-action-buttons">
          <form method="post" action="/projects/${encodeURIComponent(selectedProject.id)}/sync-tasks">
            <button class="button small ghost" type="submit">同步历史任务</button>
          </form>
          <a class="button small" href="${newTaskHref}">新建任务</a>
        </div>
        <p class="board-action-hint">仅补充新会话，不覆盖已有任务、沟通和结果。</p>
      </div>
    </header>
    <div class="task-board" aria-label="${escapeHtml(selectedProject.name)} 的任务看板">${columns}</div>
    ${conversationPanel(selectedProject, conversations)}
  </section>`;
}

export function workbenchPage({ projects = [], selectedProject = null, tasks = [], selectedTask = null, conversations = [], syncNotice = null, taskSyncNotice = null, renameNotice = null, projectListMeta = null } = {}) {
  const hasActiveTask = projects.some((project) => Number(project.active_count || 0) > 0)
    || tasks.some((task) => ['queued', 'running'].includes(task.status));
  return layout(selectedTask?.title || selectedProject?.name || '工作台', `
    <section class="task-workbench">
      ${workspaceNavigation({ projects, selectedProject, syncNotice, projectListMeta })}
      ${taskBoard({ selectedProject, tasks, selectedTask, conversations, taskSyncNotice, renameNotice, projectListMeta })}
      ${selectedTask ? `<a class="detail-backdrop" href="${escapeHtml(workspaceHref(`/projects/${encodeURIComponent(selectedTask.project_id)}`, projectListMeta))}" aria-label="关闭任务详情"></a>
        <aside class="task-detail-panel" aria-label="任务详情">
          <a class="detail-close" href="${escapeHtml(workspaceHref(`/projects/${encodeURIComponent(selectedTask.project_id)}`, projectListMeta))}" aria-label="关闭任务详情">×</a>
          ${taskDetailContent(selectedTask, projectListMeta, renameNotice)}
        </aside>` : ''}
    </section>`, { refresh: hasActiveTask, workspace: true });
}

export function homePage(options = {}) {
  return workbenchPage(options);
}

export function projectsPage(options = {}) {
  return workbenchPage(options);
}

export function projectPage(project, tasks = [], projects = [project]) {
  return workbenchPage({ projects, selectedProject: project, tasks, selectedTask: null });
}

export function newProjectPage(error = '', values = {}) {
  return layout('添加项目', `
    <section class="narrow">
      <a class="back" href="/projects">← 返回项目</a>
      <p class="eyebrow">项目</p><h1>添加本地 Git 项目</h1>
      <p class="lead">只保存项目路径。每个任务会在独立 Git Worktree 中执行，不直接修改当前目录。</p>
      ${error ? `<div class="alert danger">${escapeHtml(error)}</div>` : ''}
      <form class="form panel" method="post" action="/projects">
        <label>项目名称<input name="name" required maxlength="80" placeholder="例如：广州联通项目数据抓取" value="${escapeHtml(values.name || '')}"></label>
        <label>项目绝对路径<input name="path" required placeholder="/Users/you/Projects/my-app" value="${escapeHtml(values.path || '')}"></label>
        <p class="hint">目前只支持已有 Git 仓库，并要求仓库位于普通分支。</p>
        <button class="button" type="submit">保存项目</button>
      </form>
    </section>`);
}

export function newTaskPage(projects, error = '', values = {}) {
  if (!projects.length) return newProjectPage('请先添加一个项目。');
  return layout('新建任务', `
    <section class="narrow">
      <a class="back" href="/">← 返回任务</a>
      <p class="eyebrow">委托任务</p><h1>希望完成什么？</h1>
      <p class="lead">写清目标和验收标准即可。提交后可以关闭页面，Claude Code 会在后台执行。</p>
      ${error ? `<div class="alert danger">${escapeHtml(error)}</div>` : ''}
      <form class="form panel" method="post" action="/tasks">
        <label>项目<select name="project_id" required>${projects.map((p) => `<option value="${escapeHtml(p.id)}" ${values.project_id === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select></label>
        <label>任务与验收要求<textarea name="prompt" required minlength="5" maxlength="20000" rows="12" placeholder="例如：修复公告日期解析错误。要求支持中文日期格式、补充测试，并确保现有测试全部通过。">${escapeHtml(values.prompt || '')}</textarea></label>
        <button class="button" type="submit">开始执行</button>
      </form>
    </section>`);
}

function resultBlock(task) {
  const result = task.result;
  const failure = task.status === 'failed'
    ? claudeFailureInfo(result?.summary, task.error_message, task.raw_result)
    : null;

  if (!result) {
    if (task.status === 'running' || task.status === 'queued') {
      return `<section class="panel waiting"><div class="spinner"></div><div><h2>${escapeHtml(task.phase || '正在执行')}</h2><p>可以关闭页面，稍后再回来。任务会继续在本机后台运行。</p></div></section>`;
    }
    return `<section class="panel${task.status === 'failed' ? ' failure-panel' : ''}">
      <h2>${failure?.title || '暂无结构化结果'}</h2>
      <div class="markdown-body">${renderMarkdown(failure?.message || task.error_message || task.raw_result || '任务尚未生成结果。')}</div>
    </section>`;
  }

  const completed = (result.completed_items || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  const validations = (result.validation || []).map((item) => `<li class="validation ${item.passed ? 'pass' : 'fail'}"><span>${item.passed ? '✓' : '×'}</span><div><strong>${escapeHtml(item.name)}</strong><p>${escapeHtml(item.details)}</p></div></li>`).join('');
  const risks = (result.risks || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  return `
    <section class="result-hero ${task.status === 'failed' ? 'failed' : ''}">
      <p class="eyebrow">执行结果</p><h1>${escapeHtml(failure?.title || task.title)}</h1>${result.summary ? `<div class="markdown-body result-summary">${renderMarkdown(result.summary)}</div>` : ''}
    </section>
    ${failure ? `<section class="panel failure-panel"><h2>为什么没有完成</h2><p>${escapeHtml(failure.message)}</p><p class="hint">这不是页面故障。任务执行记录已保留，可以在下方补充更具体的要求后继续。</p></section>` : ''}
    ${completed ? `<section class="panel"><h2>完成内容</h2><ul class="clean-list">${completed}</ul></section>` : ''}
    ${validations ? `<section class="panel"><h2>验证结果</h2><ul class="validation-list">${validations}</ul></section>` : ''}
    ${risks && !failure ? `<section class="panel"><h2>注意事项</h2><ul class="clean-list risks">${risks}</ul></section>` : ''}
    ${result.question ? `<section class="panel question"><h2>需要你补充</h2><div class="markdown-body">${renderMarkdown(result.question)}</div></section>` : ''}`;
}

function runResultSummary(run) {
  const result = run.result;
  const failure = run.status === 'failed' ? claudeFailureInfo(result?.summary, run.error_message, run.raw_result) : null;
  if (run.status === 'queued' || run.status === 'running') {
    return `<div class="run-waiting"><span class="spinner small"></span>${run.status === 'running' ? 'Claude 正在处理这一轮' : '等待执行'}</div>`;
  }
  if (!result) return `<p class="run-empty">${escapeHtml(failure?.message || run.error_message || run.raw_result || '这一轮没有可显示的结果。')}</p>`;
  const completed = (result.completed_items || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  const validations = (result.validation || []).map((item) => `<li>${item.passed ? '✓' : '×'} ${escapeHtml(item.name)}：${escapeHtml(item.details)}</li>`).join('');
  const risks = (result.risks || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  return `<div class="run-result">
    <strong>${escapeHtml(failure?.title || '这一轮已经结束')}</strong>${result.summary ? `<div class="markdown-body run-summary">${renderMarkdown(result.summary)}</div>` : ''}
    ${failure ? `<p>${escapeHtml(failure.message)}</p>` : ''}
    ${completed ? `<ul>${completed}</ul>` : ''}
    ${validations ? `<div class="run-subtitle">验证</div><ul>${validations}</ul>` : ''}
    ${risks && !failure ? `<div class="run-subtitle">注意</div><ul>${risks}</ul>` : ''}
    ${result.question ? `<div class="run-question"><strong>Claude 需要你补充</strong><p>${escapeHtml(result.question)}</p></div>` : ''}
  </div>`;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function formatTokenCount(value) {
  const tokens = numberOrZero(value);
  if (!tokens) return '0';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(Math.round(tokens));
}

function runUsage(run) {
  const payload = run.usage;
  if (!payload) return null;
  const apiUsage = payload.usage || {};
  const modelEntries = Object.entries(payload.modelUsage || {});
  const modelValues = modelEntries.map(([, value]) => value || {});
  const sumModel = (key) => modelValues.reduce((total, value) => total + numberOrZero(value[key]), 0);
  const inputTokens = numberOrZero(apiUsage.input_tokens) || sumModel('inputTokens');
  const cacheReadTokens = numberOrZero(apiUsage.cache_read_input_tokens) || sumModel('cacheReadInputTokens');
  const cacheCreationTokens = numberOrZero(apiUsage.cache_creation_input_tokens) || sumModel('cacheCreationInputTokens');
  const outputTokens = numberOrZero(apiUsage.output_tokens) || sumModel('outputTokens');
  const contextEstimate = inputTokens + cacheReadTokens + cacheCreationTokens;
  const contextWindow = Math.max(...modelValues.map((value) => numberOrZero(value.contextWindow)), 0);
  const percentage = contextWindow ? Math.min(100, Math.round((contextEstimate / contextWindow) * 100)) : null;
  const modelNames = modelEntries.map(([name]) => name).filter(Boolean);
  const cost = numberOrZero(payload.totalCostUsd)
    || modelValues.reduce((total, value) => total + numberOrZero(value.costUSD), 0);
  const turns = numberOrZero(payload.numTurns) || modelValues.reduce((total, value) => total + numberOrZero(value.numTurns), 0);
  return {
    inputTokens, cacheReadTokens, cacheCreationTokens, outputTokens, contextEstimate,
    contextWindow, percentage, modelNames, cost, turns,
  };
}

function usageInline(run) {
  const usage = runUsage(run);
  if (!usage) return '';
  const context = usage.contextWindow
    ? `上下文估算 ${formatTokenCount(usage.contextEstimate)} / ${formatTokenCount(usage.contextWindow)}${usage.percentage === null ? '' : ` · ${usage.percentage}%`}`
    : `本轮输入约 ${formatTokenCount(usage.contextEstimate)} tokens`;
  return `<div class="run-usage-inline">${context}${usage.cost ? ` · $${usage.cost.toFixed(3)}` : ''}</div>`;
}

function contextUsagePanel(task) {
  const runs = task.runs?.length ? task.runs : [];
  const usageRuns = runs.map((run) => ({ run, usage: runUsage(run) })).filter(({ usage }) => usage);
  const latest = usageRuns.at(-1);
  const autocompactEnabled = config.claudeAutocompact !== 'off';
  const autocompact = autocompactEnabled
    ? `自动压缩已开启（${config.claudeAutocompact === 'auto' ? 'Claude Code 自动判断' : `阈值 ${escapeHtml(config.claudeAutocompact)} tokens`}）`
    : '自动压缩未启用';
  const autocompactClass = autocompactEnabled ? '' : ' disabled';
  if (!latest) {
    return `<section class="panel context-usage-panel">
      <div class="panel-head"><div><p class="eyebrow">上下文使用</p><h2>暂时没有用量数据</h2></div><span class="context-autocompact${autocompactClass}">${autocompact}</span></div>
      <p class="hint">完成一轮 Claude Code 执行后，这里会显示本轮 token、缓存、成本和上下文估算。历史轮次没有保存用量时不会补写。</p>
    </section>`;
  }
  const { run, usage } = latest;
  const totalCost = usageRuns.reduce((sum, item) => sum + item.usage.cost, 0);
  const tokenParts = [
    `输入 ${formatTokenCount(usage.inputTokens)}`,
    `缓存读取 ${formatTokenCount(usage.cacheReadTokens)}`,
    `缓存写入 ${formatTokenCount(usage.cacheCreationTokens)}`,
    `输出 ${formatTokenCount(usage.outputTokens)}`,
  ];
  return `<section class="panel context-usage-panel">
    <div class="panel-head"><div><p class="eyebrow">上下文使用</p><h2>第 ${run.sequence} 轮 · ${usage.contextWindow ? `${formatTokenCount(usage.contextEstimate)} / ${formatTokenCount(usage.contextWindow)}` : `约 ${formatTokenCount(usage.contextEstimate)} tokens`}</h2></div><span class="context-autocompact${autocompactClass}">${autocompact}</span></div>
    <div class="context-meter" role="img" aria-label="${escapeHtml(usage.percentage === null ? '无法计算上下文百分比' : `估算使用 ${usage.percentage}%`)}"><span style="width:${usage.percentage || 0}%"></span></div>
    <div class="context-usage-meta"><span>${usage.percentage === null ? '无法精确计算上下文百分比' : `估算使用 ${usage.percentage}%`}</span><span>${escapeHtml(tokenParts.join(' · '))}</span></div>
    <p class="hint">这是 Claude Code 返回的本轮 API 用量估算，不等同于内部精确上下文快照。${usage.cost ? ` 本轮成本 $${usage.cost.toFixed(3)}。` : ''}${usage.turns ? ` 本轮 ${usage.turns} 次工具/模型轮次。` : ''}${usageRuns.length > 1 && totalCost ? ` 已记录轮次累计成本 $${totalCost.toFixed(3)}。` : ''}</p>
  </section>`;
}

function runOriginLabel(run) {
  return run.origin === 'claude_history'
    ? '<span class="run-origin claude-history">Claude Code 历史</span>'
    : '<span class="run-origin done">Done</span>';
}

function taskTimeline(task) {
  const runs = task.runs?.length ? task.runs : [{
    id: `${task.id}_legacy`, sequence: 1, prompt: task.prompt, status: task.status,
    result: task.result, raw_result: task.raw_result, error_message: task.error_message,
    created_at: task.created_at, started_at: task.started_at, completed_at: task.completed_at,
  }];
  return `<section class="panel task-timeline">
    <div class="panel-head"><div><p class="eyebrow">任务进展</p><h2>${runs.length} 轮沟通</h2></div><span class="hint">按沟通顺序展示，最近一轮默认展开</span></div>
    <div class="run-list">${runs.map((run, index) => {
      const preview = String(run.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 100);
      const open = index === runs.length - 1;
      return `<details class="task-run ${run.status}" ${open ? 'open' : ''}>
        <summary class="run-summary-row">
          <div class="run-marker"><span>${run.sequence}</span></div>
          <div class="run-heading">
            <div class="run-heading-head"><div><strong>第 ${run.sequence} 轮</strong>${badge(run.status)}${runOriginLabel(run)}</div><time>${escapeHtml(formatDate(run.completed_at || run.started_at || run.created_at))}</time></div>
            ${preview ? `<div class="run-preview">${escapeHtml(preview)}${String(run.prompt || '').replace(/\s+/g, ' ').trim().length > 100 ? '…' : ''}</div>` : ''}
            ${usageInline(run)}
          </div>
        </summary>
        <div class="run-content">
          <div class="run-prompt"><span>你的要求</span><div class="markdown-body">${renderMarkdown(run.prompt)}</div></div>
          ${runResultSummary(run)}
        </div>
      </details>`;
    }).join('')}</div>
  </section>`;
}

function taskDetailContent(task, projectListMeta = null, renameNotice = null) {
  const canFollowUp = !['queued', 'running'].includes(task.status);
  const canCancel = ['queued', 'running'].includes(task.status);
  const placeholder = task.status === 'needs_input'
    ? '回答 Claude 的问题，或补充新的要求。'
    : '例如：解释为什么这样实现；或者把按钮改小，并补充对应测试。';
  return `
    <div class="task-detail-inner">
      <section class="task-header">
        <div class="task-heading-copy"><div class="task-kicker">${badge(task.status)}<a href="${escapeHtml(workspaceHref(`/projects/${encodeURIComponent(task.project_id)}`, projectListMeta))}">${escapeHtml(task.project_name)}</a></div><div class="title-edit-row"><h1>${escapeHtml(task.title)}</h1>${renameControl({ target: 'task', id: task.id, value: task.title })}</div>${renameFeedback(renameNotice, 'task')}<div class="markdown-body">${renderMarkdown(task.prompt)}</div></div>
        ${canCancel ? `<form method="post" action="/tasks/${encodeURIComponent(task.id)}/cancel"><button class="button ghost" type="submit">取消任务</button></form>` : ''}
      </section>
      ${resultBlock(task)}
      ${contextUsagePanel(task)}
      ${taskTimeline(task)}
      ${task.diff_stat ? `<section class="panel"><div class="panel-head"><h2>当前累计代码变更</h2><span>${escapeHtml(task.branch_name || '')}</span></div><pre class="diff-stat">${escapeHtml(task.diff_stat)}</pre><details><summary>查看完整 Diff</summary><pre class="diff">${escapeHtml(task.diff_text || '没有可显示的文本差异。')}</pre></details></section>` : ''}
      ${task.error_message && !task.result ? `<section class="alert danger"><strong>错误信息</strong><pre>${escapeHtml(task.error_message)}</pre></section>` : ''}
      <section class="panel action-panel">
        <h2>${canFollowUp ? (task.status === 'needs_input' ? '补充 Claude 需要的信息' : '继续推进这个任务') : '当前轮正在执行'}</h2>
        <p class="hint">同一任务会复用工作区和 Claude Session；看板上始终只有这一张任务卡。</p>
        ${task.status === 'completed' ? `<div class="actions"><form method="post" action="/tasks/${encodeURIComponent(task.id)}/accept"><button class="button success-button" type="submit">接受结果</button></form></div>` : ''}
        <form class="continue-form" method="post" action="/tasks/${encodeURIComponent(task.id)}/runs">
          <label>追问或补充<textarea name="prompt" required minlength="3" rows="4" placeholder="${escapeHtml(placeholder)}" ${canFollowUp ? '' : 'disabled'}></textarea></label>
          <button class="button secondary" type="submit" ${canFollowUp ? '' : 'disabled'}>${canFollowUp ? '继续执行' : '请等待当前轮结束'}</button>
        </form>
      </section>
      <details class="technical"><summary>技术信息</summary><dl><dt>任务 ID</dt><dd>${escapeHtml(task.id)}</dd><dt>沟通轮次</dt><dd>${Number(task.run_count || task.runs?.length || 1)}</dd><dt>创建时间</dt><dd>${escapeHtml(formatDate(task.created_at))}</dd><dt>最后更新</dt><dd>${escapeHtml(formatDate(task.updated_at || task.created_at))}</dd><dt>工作分支</dt><dd>${escapeHtml(task.branch_name || '—')}</dd><dt>工作目录</dt><dd>${escapeHtml(task.workspace_path || '—')}</dd><dt>Claude Session</dt><dd>${escapeHtml(task.session_id || '—')}</dd></dl></details>
    </div>`;
}

export function taskPage(task, tasks = [task], projects = [], selectedProject = null) {
  const project = selectedProject || projects.find((item) => item.id === task.project_id) || null;
  return workbenchPage({ projects, selectedProject: project, tasks, selectedTask: task });
}

export function projectConversationPage(project, conversation, projects = [project]) {
  return layout(`历史沟通 · ${conversation.title}`, `<main class="conversation-page">${conversationDetailContent(project, conversation)}</main>`, { workspace: false });
}

export function notFoundPage() {
  return layout('未找到', '<section class="empty"><h1>页面不存在</h1><a class="button" href="/">返回任务</a></section>');
}
