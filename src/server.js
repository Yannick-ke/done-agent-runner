import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { createProject, createTask, createTaskRun, getProject, getTask, listProjects, listTaskRuns, listTasksByProject, recoverInterruptedTasks, renameProject, renameTask, updateTask } from './db.js';
import { initializeGitProject, validateProjectPath } from './git.js';
import { cancelTask, startRunner, stopRunner, tick } from './runner.js';
import { homePage, newProjectPage, newTaskPage, notFoundPage, projectConversationPage } from './views.js';
import { getProjectClaudeConversation, listProjectClaudeConversations } from './claude-history.js';
import { syncClaudeHistoryProjects } from './claude-project-sync.js';
import { syncProjectHistoryTasks } from './task-sync-service.js';
import { nowIso } from './utils.js';
import { projectListMeta } from './project-pagination.js';

const mimeTypes = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}
function redirect(res, location) { res.writeHead(303, { location }); res.end(); }
async function readForm(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 100_000) throw new Error('请求内容过大。');
  }
  return Object.fromEntries(new URLSearchParams(body));
}
function json(res, status, value) { send(res, status, JSON.stringify(value), 'application/json; charset=utf-8'); }
function taskSyncNotice(url) {
  if (!url.searchParams.has('task_sync_added')) return null;
  const added = Math.max(0, Number(url.searchParams.get('task_sync_added')) || 0);
  const updated = Math.max(0, Number(url.searchParams.get('task_sync_updated')) || 0);
  const turns = Math.max(0, Number(url.searchParams.get('task_sync_turns')) || 0);
  const existing = Math.max(0, Number(url.searchParams.get('task_sync_existing')) || 0);
  const ignored = Math.max(0, Number(url.searchParams.get('task_sync_ignored')) || 0);
  const pending = Math.max(0, Number(url.searchParams.get('task_sync_pending')) || 0);
  const changes = added || updated
    ? `新增 ${added} 个历史任务，更新 ${updated} 个已有任务，共导入 ${turns} 轮沟通。`
    : '没有需要增量导入的新沟通。';
  const pendingText = pending ? `另有 ${pending} 条外部要求尚无 Claude 回复，暂不导入。` : '';
  const details = existing || ignored ? `${existing} 个会话已是最新，${ignored} 个无法导入。` : '';
  return {
    added: added + updated,
    message: `${changes}${pendingText}${details}Done 中已有的沟通和结果没有被覆盖。`,
  };
}


function renameNotice(url) {
  const target = String(url.searchParams.get('rename_target') || url.searchParams.get('renamed') || '');
  const error = String(url.searchParams.get('rename_error') || '');
  if (!target || (!error && !url.searchParams.has('renamed'))) return null;
  return error
    ? { target, error: true, message: error }
    : { target, error: false, message: target === 'task' ? '任务名称已更新。' : '项目名称已更新。' };
}

function syncNotice(url) {
  if (!url.searchParams.has('sync_added')) return null;
  const added = Math.max(0, Number(url.searchParams.get('sync_added')) || 0);
  const existing = Math.max(0, Number(url.searchParams.get('sync_existing')) || 0);
  const ignored = Math.max(0, Number(url.searchParams.get('sync_ignored')) || 0);
  const message = added
    ? `新增 ${added} 个历史项目；${existing} 个已存在，${ignored} 个已忽略。已有任务和沟通没有被修改。`
    : `没有发现需要新增的项目；${existing} 个项目已存在，${ignored} 个已忽略。已有任务和沟通保持不变。`;
  return { added, message };
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  try {
    if (req.method === 'GET' && (pathname === '/' || pathname === '/projects')) {
      const projectQuery = String(url.searchParams.get('q') || '').trim();
      const allProjects = listProjects(projectQuery);
      const selectedProject = allProjects[0] || null;
      const projectPage = projectListMeta(url, allProjects, selectedProject?.id);
      const tasks = selectedProject ? listTasksByProject(selectedProject.id) : [];
      const conversations = selectedProject ? listProjectClaudeConversations(selectedProject, tasks) : [];
      return send(res, 200, homePage({ projects: projectPage.projects, projectListMeta: projectPage, selectedProject, tasks, conversations, selectedTask: null, syncNotice: syncNotice(url), taskSyncNotice: taskSyncNotice(url), renameNotice: renameNotice(url) }));
    }
    if (req.method === 'GET' && pathname === '/projects/new') return send(res, 200, newProjectPage());
    if (req.method === 'POST' && pathname === '/projects/sync') {
      const form = await readForm(req);
      const result = await syncClaudeHistoryProjects({ existingProjects: listProjects(), createProject });
      const params = new URLSearchParams({
        sync_added: String(result.added.length),
        sync_existing: String(result.existing),
        sync_ignored: String(result.ignored),
      });
      const returnProject = getProject(form.return_to || '');
      return redirect(res, `${returnProject ? `/projects/${returnProject.id}` : '/projects'}?${params}`);
    }
    if (req.method === 'POST' && pathname === '/projects') {
      const form = await readForm(req);
      try {
        const validated = await validateProjectPath(form.path || '');
        const name = String(form.name || path.basename(validated.root)).trim();
        if (!name) throw new Error('请输入项目名称。');
        if (validated.kind === 'directory' && form.initialize_git === '1') {
          const initialized = await initializeGitProject(validated.root);
          const project = createProject({ name, projectPath: initialized.root });
          return redirect(res, `/projects/${project.id}`);
        }
        if (validated.kind === 'directory' && form.confirm_directory !== '1') {
          return send(res, 200, newProjectPage('', { name, path: validated.root }, validated));
        }
        const project = createProject({ name, projectPath: validated.root });
        return redirect(res, `/projects/${project.id}`);
      } catch (error) {
        const message = String(error.message).includes('UNIQUE constraint') ? '这个项目已经添加过了。' : error.message;
        return send(res, 400, newProjectPage(message, { name: form.name, path: form.path }));
      }
    }
    const projectRenameMatch = pathname.match(/^\/projects\/([^/]+)\/rename$/);
    if (req.method === 'POST' && projectRenameMatch) {
      const project = getProject(projectRenameMatch[1]);
      if (!project) return send(res, 404, notFoundPage());
      const form = await readForm(req);
      try {
        renameProject(project.id, form.name);
        return redirect(res, `/projects/${project.id}?renamed=project&rename_target=project`);
      } catch (error) {
        const params = new URLSearchParams({ rename_target: 'project', rename_error: String(error.message || error) });
        return redirect(res, `/projects/${project.id}?${params}`);
      }
    }
    const projectTaskSyncMatch = pathname.match(/^\/projects\/([^/]+)\/sync-tasks$/);
    if (req.method === 'POST' && projectTaskSyncMatch) {
      const project = getProject(projectTaskSyncMatch[1]);
      if (!project) return send(res, 404, notFoundPage());
      const result = syncProjectHistoryTasks({ projectId: project.id, trigger: 'manual' });
      const params = new URLSearchParams({
        task_sync_added: String(result.added.length),
        task_sync_updated: String(result.updated.length),
        task_sync_turns: String(result.turnsAdded),
        task_sync_existing: String(result.existing),
        task_sync_ignored: String(result.ignored),
        task_sync_pending: String(result.pending),
      });
      return redirect(res, `/projects/${project.id}?${params}`);
    }
    const projectMatch = pathname.match(/^\/projects\/([^/]+)$/);
    if (req.method === 'GET' && projectMatch) {
      const selectedProject = getProject(projectMatch[1]);
      if (!selectedProject) return send(res, 404, notFoundPage());
      const projectQuery = String(url.searchParams.get('q') || '').trim();
      const allProjects = listProjects(projectQuery);
      const projectPage = projectListMeta(url, allProjects, selectedProject.id);
      const tasks = listTasksByProject(selectedProject.id);
      const conversations = listProjectClaudeConversations(selectedProject, tasks);
      return send(res, 200, homePage({ projects: projectPage.projects, projectListMeta: projectPage, selectedProject, tasks, conversations, selectedTask: null, syncNotice: syncNotice(url), taskSyncNotice: taskSyncNotice(url), renameNotice: renameNotice(url) }));
    }
    const conversationMatch = pathname.match(/^\/projects\/([^/]+)\/conversations\/([^/]+)$/);
    if (req.method === 'GET' && conversationMatch) {
      const projects = listProjects();
      const project = projects.find((item) => item.id === conversationMatch[1]);
      if (!project) return send(res, 404, notFoundPage());
      const tasks = listTasksByProject(project.id);
      const conversation = getProjectClaudeConversation(project, tasks, conversationMatch[2]);
      if (!conversation) return send(res, 404, notFoundPage());
      return send(res, 200, projectConversationPage(project, conversation, projects));
    }
    if (req.method === 'GET' && pathname === '/tasks/new') {
      const selectedProject = url.searchParams.get('project') || '';
      return send(res, 200, newTaskPage(listProjects(), '', { project_id: selectedProject }));
    }
    if (req.method === 'POST' && pathname === '/tasks') {
      const form = await readForm(req);
      const project = getProject(form.project_id);
      const prompt = String(form.prompt || '').trim();
      if (!project || prompt.length < 5) return send(res, 400, newTaskPage(listProjects(), '请选择项目，并至少用 5 个字描述任务。', form));
      const task = createTask({ projectId: project.id, prompt });
      void tick();
      return redirect(res, `/tasks/${task.id}`);
    }
    const taskRenameMatch = pathname.match(/^\/tasks\/([^/]+)\/rename$/);
    if (req.method === 'POST' && taskRenameMatch) {
      const task = getTask(taskRenameMatch[1]);
      if (!task) return send(res, 404, notFoundPage());
      const form = await readForm(req);
      try {
        renameTask(task.id, form.title);
        return redirect(res, `/tasks/${task.id}?renamed=task&rename_target=task`);
      } catch (error) {
        const params = new URLSearchParams({ rename_target: 'task', rename_error: String(error.message || error) });
        return redirect(res, `/tasks/${task.id}?${params}`);
      }
    }
    const taskMatch = pathname.match(/^\/tasks\/([^/]+)$/);
    if (req.method === 'GET' && taskMatch) {
      const task = getTask(taskMatch[1]);
      if (!task) return send(res, 404, notFoundPage());
      const projectQuery = String(url.searchParams.get('q') || '').trim();
      const allProjects = listProjects(projectQuery);
      const selectedProject = getProject(task.project_id);
      const projectPage = projectListMeta(url, allProjects, selectedProject?.id);
      const tasks = listTasksByProject(task.project_id);
      return send(res, 200, homePage({ projects: projectPage.projects, projectListMeta: projectPage, selectedProject, tasks, conversations: listProjectClaudeConversations(selectedProject, tasks), selectedTask: { ...task, runs: listTaskRuns(task.id) }, renameNotice: renameNotice(url) }));
    }
    const apiMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (req.method === 'GET' && apiMatch) {
      const task = getTask(apiMatch[1]);
      return task ? json(res, 200, { id: task.id, status: task.status, phase: task.phase, updated_at: task.updated_at }) : json(res, 404, { error: 'not_found' });
    }
    const runMatch = pathname.match(/^\/tasks\/([^/]+)\/runs$/);
    if (req.method === 'POST' && runMatch) {
      const task = getTask(runMatch[1]);
      if (!task) return send(res, 404, notFoundPage());
      const form = await readForm(req);
      const prompt = String(form.prompt || '').trim();
      if (prompt.length >= 3 && !['queued', 'running'].includes(task.status)) {
        createTaskRun({ taskId: task.id, prompt });
        void tick();
      }
      return redirect(res, `/tasks/${task.id}`);
    }
    const actionMatch = pathname.match(/^\/tasks\/([^/]+)\/(cancel|accept|continue)$/);
    if (req.method === 'POST' && actionMatch) {
      const [, id, action] = actionMatch;
      const task = getTask(id);
      if (!task) return send(res, 404, notFoundPage());
      if (action === 'cancel') cancelTask(id);
      if (action === 'accept' && task.status === 'completed') updateTask(id, { status: 'accepted', phase: '已接受', accepted_at: nowIso() });
      if (action === 'continue') {
        const form = await readForm(req);
        const prompt = String(form.prompt || '').trim();
        if (prompt.length >= 3 && !['queued', 'running'].includes(task.status)) {
          createTaskRun({ taskId: task.id, prompt });
          void tick();
        }
      }
      return redirect(res, `/tasks/${id}`);
    }
    if (req.method === 'GET' && (pathname === '/styles.css' || pathname === '/app.js')) {
      const filePath = path.join(config.publicDir, path.basename(pathname));
      const content = await fs.readFile(filePath);
      return send(res, 200, content, mimeTypes[path.extname(filePath)] || 'application/octet-stream');
    }
    return send(res, 404, notFoundPage());
  } catch (error) {
    console.error(error);
    return send(res, 500, `<h1>服务器错误</h1><pre>${String(error.message)}</pre>`);
  }
}

recoverInterruptedTasks();
startRunner();
const server = http.createServer(handler);
server.listen(config.port, config.host, () => {
  console.log(`Done is running at http://${config.host}:${config.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { stopRunner(); server.close(() => process.exit(0)); });
}
