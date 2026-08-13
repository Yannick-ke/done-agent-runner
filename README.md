# Done

> Local AI Coding Task Runner

一个轻量的、面向结果的本地 AI 编程任务执行器。目前使用 Claude Code 作为执行引擎。

用户选择本地 Git 项目或普通目录并描述目标，任务会在隔离工作区中串行执行。Git 项目使用独立 Git Worktree，普通目录使用独立快照副本。页面不展示实时终端，只展示简化状态、结构化结果、验证信息和 Git Diff。

创建项目时，Done 会自动检测路径是否为 Git 项目。如果是普通目录，还会检测电脑是否安装 Git：已安装时会询问是否由 Done 自动执行 `git init`、记录当前文件的初始提交并按 Git 项目创建；也可以明确选择继续使用普通目录模式。未安装 Git 时则只提供普通目录确认，任务仍可在隔离副本中执行，但无法生成 Git Diff。

## 已实现

- 添加和浏览本地 Git 项目或普通目录
- 普通目录可在用户确认后自动初始化为 Git 项目并创建初始提交
- 项目优先工作台：左侧先选择项目，再查看该项目任务
- 三栏任务工作台：项目、任务、结果各占一列
- 创建后台任务
- SQLite 持久化状态
- 单任务串行执行
- Git 项目为每个初始任务创建独立 Git Worktree 和分支
- 普通目录为每个初始任务复制隔离快照，并在快照内初始化私有 Git 基线
- 调用本机 Claude Code 并要求结构化结果
- 展示结果摘要、验证、风险和 Git Diff
- 在同一工作区继续修改
- 接受、取消任务
- 应用重启后重新排队意外中断的任务
- 按项目同步 Claude Code 历史会话，同一 Session 增量追加为多轮任务
- 同步采用来源标识和幂等键，不覆盖 Done 中已有的追问和结果

## 环境要求

- macOS / Linux
- Node.js 22.5+
- Git
- 已安装并登录 Claude Code（运行 `claude auth status` 检查）

## 启动

```bash
git clone https://github.com/Yannick-ke/done-agent-runner.git
cd done-agent-runner
npm start
```

项目目前没有第三方运行时依赖；`package-lock.json` 仍应提交，用于固定 Node/npm 项目元数据。

浏览器打开：

```text
http://127.0.0.1:4173
```

开发模式：

```bash
npm run dev
```

测试：

```bash
npm test
```

## 可选配置

```bash
PORT=4173                       # Web 端口
HOST=127.0.0.1                 # 默认仅本机访问
CLAUDE_COMMAND=claude           # Claude CLI 路径
CLAUDE_MODEL=sonnet             # 留空使用 Claude Code 默认模型
CLAUDE_MAX_TURNS=30             # 单任务最大轮数
CLAUDE_MAX_BUDGET_USD=5         # 可选，单任务费用上限
CLAUDE_AUTOCOMPACT=auto         # 上下文自动压缩：auto、100000 等；设为 off 可关闭
DATA_DIR=./data                 # SQLite 等应用数据目录
DATABASE_PATH=./data/tasks.db   # 可选，覆盖 SQLite 文件位置
TASKS_DIR=./data/tasks          # 可选的隔离工作区、Claude 输出和错误日志目录
```

仓库提供了可公开提交的 `.env.example`。程序直接读取进程环境变量，不会自动加载 `.env`；需要时可以通过 shell 或进程管理器注入。真实的 `.env` 已被 Git 忽略。

## 数据位置

SQLite 数据库默认使用仓库相对路径：

```text
./data/tasks.db                SQLite 数据库
```

任务文件以 `TASKS_DIR` 为根目录组织：

```text
<TASKS_DIR>/<task-id>/workspace 独立工作区（Git Worktree 或普通目录快照）
<TASKS_DIR>/<task-id>/*.log     Claude 原始结果和错误日志
```

在 macOS 上，`TASKS_DIR` 默认位于当前用户的 Application Support 目录中的 `Done/tasks`，避免大型工作区被同步软件上传。也可以将其配置为 `./data/tasks` 等相对路径；相对路径以启动程序时的工作目录为基准。

## 安全与隐私

这是一个**无登录、单用户、本地运行**的工具。默认的 `HOST=127.0.0.1` 应当保留；不要直接把服务绑定到 `0.0.0.0` 或暴露到公网。页面能够向 Claude Code 下发任务，而 Claude Code 可以在受信任项目的隔离工作区中读取、编辑文件并运行命令。

以下内容可能包含源码、任务描述、Claude 回复、本地绝对路径、Session ID、Git Diff、命令输出或其他敏感信息，已经通过 `.gitignore` 排除，**不要上传到公开仓库**：

- `data/` 及其中的 SQLite 数据库、WAL/SHM、备份和日志
- `TASKS_DIR` 指向的任务目录、生成的 Worktree 或目录快照、`claude-result.json` 和错误日志
- Claude Code 用户配置目录中的历史会话、认证信息和个人配置
- `.env`、`.env.local` 等真实环境配置
- 任何从其他本地项目复制出来的私有源码、密钥、证书或导出数据

公开前建议重新执行 `git status --ignored --short`，确认上述文件仍处于忽略状态。

## 历史任务同步与自动化扩展

页面中的“同步历史任务”目前是手动触发。同步入口已经统一收敛到：

```js
syncProjectHistoryTasks({
  projectId,
  trigger: 'manual', // future: scheduled | webhook
  options,
});
```

`src/task-sync-service.js` 负责同步编排，HTTP 路由不直接操作 Claude 历史文件和数据库。后续增加定时器或 Webhook 时，复用这个服务并分别传入 `scheduled`、`webhook` 即可，不需要复制增量合并逻辑。当前版本刻意不引入任务调度框架或 Webhook 服务，以保持单机 MVP 轻量。

同步规则：

- 一个 Claude Session 始终对应一张任务卡。
- 只追加尚未导入的完整问答轮次。
- 只有用户要求、尚无 Claude 回复的轮次暂不导入，下一次同步再处理。
- Done 页面创建的追问和结果保留原样，不会被历史同步覆盖。
- 重复同步同一份历史不会产生重复任务或重复轮次。

## 当前边界

这是刻意保持轻量的单用户本地 MVP：

- 不提供登录、多用户和团队权限
- 不提供 Redis、Docker、Kubernetes 和多 Worker
- 不展示实时终端或思考过程
- 默认禁止 Claude 使用 WebFetch / WebSearch
- 不自动执行 Git push、部署或生产环境操作
- “接受结果”只记录验收状态，不自动合并到原分支

应用只能添加你信任的本地项目。Claude Code 只会在任务的隔离工作区中读取、编辑和运行命令，不直接修改原目录。普通目录模式会完整复制目录，目录较大时创建任务会更慢、占用更多磁盘；任务结果也不会自动写回原目录。若在创建项目时选择“初始化为 Git 项目”，Done 会修改原目录的 Git 元数据：创建 `.git`、暂存当前文件，并以 Done Agent Runner 的本地提交身份创建 `chore: initialize project` 初始提交；不会修改现有工作文件，也不会设置远程仓库或执行 push。选择前请确认目录中没有应被纳入提交的密钥或隐私文件，必要时先配置 `.gitignore`。

## License

本项目采用 [CC0 1.0 Universal](LICENSE) 许可。
