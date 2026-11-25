# dsh-github-panel

A GitHub console for [DeepSeek Harness](https://github.com/deepseek-ai) that runs inside the app: paste a personal access token once and work with your repositories, issues, pull requests, commits, notifications, stars, cloning and skills without opening github.com.

中文说明见下方 [中文](#中文).

## Features

| Area | What you get |
| --- | --- |
| Repositories | List every repository you can access, search locally, browse the file tree and preview file contents |
| Issues | Open/closed filter, create an issue, comment, close or reopen |
| Pull requests | List, inspect, comment, merge |
| Commits | Recent commits with author, message and time |
| Notifications | Unread threads, mark one or all as read, jump to the referenced issue/PR |
| Stars | Everything you starred, with instant unstar, and searching |
| Social | Who you follow, who follows you, your organizations |
| Activity | Your public events and the events of the people you follow |
| Clone | Clone a repo from your repositories, stars or search to disk, then keep it up to date automatically |
| Skills | Install a whole GitHub skill project into `~/.dsh/skills`, grouped by category with Chinese descriptions and AI search keywords, and keep it in step with upstream |

Data is read from the GitHub REST API on every refresh, so the panel and github.com never drift apart. A background refresh runs every 60 seconds while the panel is visible.

## Install

```bash
dsh plugin --profile web add github:gpta76/dsh-github-panel
```

Or from a local checkout:

```bash
dsh plugin --profile web add /absolute/path/to/dsh-github-panel
```

Restart DeepSeek Harness after installing, then open **GitHub** in the sidebar.

## Connect

1. Create a token at <https://github.com/settings/tokens>.
   - Classic token: `repo`, `read:user`, `notifications`.
   - Fine-grained token: repository contents, issues and pull requests read/write, plus your profile.
2. Paste it into the panel and press **连接** / **Connect**. The token is verified with `GET /user` before it is stored.

The panel lives in the web UI but every GitHub call is made by the host process, so no CORS proxy is involved and the token never enters the browser.

## Where the token is stored

`$DSH_HOME/plugin-data/github-panel.json` (mode `0600`), i.e. `~/.dsh/plugin-data/github-panel.json` on a default install. An older build wrote the token into the shared credential store; that record is migrated to the file and removed on first read.

The panel does not share the token with anything else, and **断开** / **Disconnect** deletes it.

## Tools for the agent

The host half registers eight tools, so the agent can drive GitHub, the clone cache and the skill library on its own:

| Tool | Purpose |
| --- | --- |
| `github_api` | Call any GitHub REST endpoint (`method`, `path`, optional `body`) through the stored token |
| `github_skill_list` | List skills in the local catalog with their source repository |
| `github_skill_install` | Install `owner/repo` (optionally a `dir` and `ref`) into `~/.dsh/skills` |
| `github_skill_remove` | Remove an installed skill by name |
| `github_skill_project` | `list`, `install` or `remove` a whole skill project (`repo`), with category, summary and keywords |
| `github_clone_list` | List local clones with branch, upstream, ahead/behind and dirty state |
| `github_clone` | Clone `owner/repo` (optionally a `ref` and a target `dir`) into the clone root or any absolute folder |
| `github_clone_sync` | Fetch and fast-forward one clone, or `all: true` |

## Cloning

Clones live in `$DSH_HOME/github-clones/<owner>/<repo>` by default, but every clone can pick its own folder: pressing 克隆 opens a target-directory field (leave it empty for the default), and the agent can pass `dir` to `github_clone`. The default root is configurable too (自动同步 card → 默认克隆目录, `DSH_GITHUB_CLONE_DIR`, saved in `plugin-data/github-panel-clones.json`). An absolute path that already ends with the repository name is used as-is; any other absolute path is treated as the parent folder and receives a directory named after the repository. Every location is recorded in `$DSH_HOME/plugin-data/github-panel-clone-index.json`, so listing, syncing and removing still find clones that live outside the default root.

Sync is fetch + `merge --ff-only`:

- a clean clone follows the upstream branch automatically;
- a clone with local changes is left alone and reported as *dirty*, so your edits are never overwritten;
- a diverged clone is reported instead of being reset.

Auto-sync runs every 15 minutes by default and can be switched off or re-timed in the panel. The panel shows a live progress bar (overall percentage plus the current git phase) while cloning or fetching.

Git must be installed and on `PATH`. On Windows the panel runs git with `http.sslBackend=openssl`, which avoids the Schannel `SEC_E_NO_CREDENTIALS` failure some machines hit.

## Skills library

Cloning a repository does **not** install its skills: the agent only loads `~/.dsh/skills/<name>/SKILL.md`. The panel therefore has two separate actions:

- **克隆** puts the repository on disk under `$DSH_HOME/github-clones`.
- **安装** (on every clone row, or the install form in the *技能* view) pulls every `SKILL.md` of that repository into the skill catalog as one *project*.

Each installed project and skill gets:

- a Chinese one-line description, so the panel is readable without English;
- a purpose category (漫剧 / 图像设计 / 视频音频 / 开发工具 / 文档办公 / 数据分析 / 自动化) and a sub-category inside it (for example 漫剧 → 大纲改编 / 剧本台词 / 人物角色 / 美术场景 / 分镜镜头 / 站位调度);
- AI search keywords written into `whenToUse`, which is what the agent matches on when it looks for a skill;
- an entry in `$DSH_HOME/plugin-data/github-panel-projects.json` plus a `.dsh-project.json` sidecar inside the skill directory.

The *技能* view lists projects with their skills collapsed, and the installed-skills section grouped by category → sub-category. **检查更新** compares each installed project with its upstream commit and re-downloads the ones that moved; the 15-minute auto-sync does the same, so the catalog never lags behind the repository. Clones whose skills are already installed show a green *已安装* badge instead of the install button.

## Guest mode (invite code)

The connect card has a small *邀请码* link. Entering the owner's invite code opens a read-only guest view built from **public** GitHub data only: profile, public repositories, stars, activity. No token is stored and nothing private is exposed; write operations are refused by the host.

## Security notes

- Every host route checks the request origin, so other pages cannot drive the panel.
- The RPC proxy only accepts paths that start with `/` and rejects absolute URLs, so it cannot be pointed at another host.
- The token is only attached to api.github.com requests.
- `npm` publishing is not required; the plugin is installed straight from this repository.

## Limitations

- One account per installation.
- File preview is capped at 300 KB, clone progress at the phases git reports.
- Merging uses the plain merge commit strategy; no rebase/squash choice yet.

## Development

```
index.js        host half: routes, token storage, git, skills, agent tools
client.js       client half: the panel UI (React, no bundler, no dependencies)
locale/*.json   display name and description per language
icon.svg        sidebar icon
cordis.patch.yml  bundle patch that inserts the plugin
```

The client half is plain JavaScript loaded through `window.__ModuleLoader__`; both halves can be syntax-checked with `node --check`.

## License

MIT

---

## 中文

一个跑在 DeepSeek Harness 里的 GitHub 控制台：粘贴一次个人访问令牌，就能在应用内管理仓库、议题、拉取请求、提交、通知、星标，还能把仓库克隆到本机并自动保持最新、从 GitHub 安装技能。

### 安装

```bash
dsh plugin --profile web add github:gpta76/dsh-github-panel
```

安装后重启应用，在侧栏点 **GitHub**。

### 连接

在 <https://github.com/settings/tokens> 生成令牌（经典令牌勾选 `repo`、`read:user`、`notifications`），粘贴进面板点「连接」。令牌只存在宿主进程的 `~/.dsh/plugin-data/github-panel.json`（权限 0600），不会进入浏览器，也不经过任何代理；点「断开」即删除。

### 功能

- **仓库**：列出你有权限的仓库，搜索、浏览目录、预览文件（300 KB 以内）。
- **克隆**：点「克隆」后先填目标目录——每个仓库可以单独落在任意绝对路径（留空则用默认 `~/.dsh/github-clones`），AI 也能用 `github_clone` 的 `dir` 参数指定；「已克隆」页的自动同步卡片里可改「默认克隆目录」（比如 `D:\projects`）；显示实时进度条（整体百分比 + 当前 git 阶段）；作者更新后自动 fetch + 快进合并，本地有改动时停下不动你的文件；默认每 15 分钟检查一次，可关闭或改间隔。克隆位置记在 `~/.dsh/plugin-data/github-panel-clone-index.json`，因此列表、同步、删除都能找到默认目录之外的克隆。
- **星标 / 关注 / 动态**：实时读自 GitHub，星标可一键取消。
- **技能**：填 `owner/repo`（可加子目录与分支）把含 `SKILL.md` 的技能装进 `~/.dsh/skills`；也可以直接点克隆行上的「安装」，把整个仓库的技能一次性作为「项目」装进来。项目和技能都自动带中文简介、用途大类（漫剧 / 图像设计 / 视频音频 / 开发工具 / 文档办公 / 数据分析 / 自动化）+ 细分小类（如 漫剧 → 大纲改编 / 剧本台词 / 人物角色 / 美术场景 / 分镜镜头 / 站位调度），并写入 AI 检索关键词（`whenToUse`）。「检查更新」和每 15 分钟的自动同步会按上游最新提交重装，技能库不会落后；已安装的克隆行显示绿色「已安装」，不再重复出现安装按钮。
- **通知**：未读列表、单条或全部标记已读、点击跳到对应议题/PR。
- **访客模式**：连接卡底部的「邀请码」可打开只读的公开数据视图（公开仓库、星标、动态），不需要令牌，也拿不到任何私有内容。

### 给 AI 的工具

`github_api`、`github_skill_list`、`github_skill_install`、`github_skill_remove`、`github_skill_project`、`github_clone_list`、`github_clone`、`github_clone_sync`——AI 可以直接调用它们读接口、装技能项目、克隆与同步仓库。

### 说明

- 需要本机装有 git；Windows 上自动加 `http.sslBackend=openssl` 规避 Schannel 报错。
- 一个安装对应一个 GitHub 账号。
- 数据每次都实时请求 GitHub，不落库，所以永远和网页端一致。

MIT 许可。
