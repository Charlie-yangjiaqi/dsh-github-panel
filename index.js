/**
 * Host half of the GitHub console bundle.
 *
 * The browser half never talks to github.com: it calls the small JSON routes
 * below, and this half holds the personal access token and performs the real
 * REST calls. That keeps the token out of page storage and sidesteps CORS.
 */
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const BASE = '/github-panel'
const API = process.env.DSH_GITHUB_API_BASE || 'https://api.github.com'
// Credential records are addressed by lower-case path segments. A key that does
// not match this shape poisons the credentials store: the credentials plugin
// rejects the whole file on the next start, and since it is a required plugin the
// entire profile fails to boot. Never write a key that fails this pattern.
const RECORD_KEY = 'github-panel/pat'
const RECORD_KEY_PATTERN = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/
const MAX_BODY = 1 << 20
const METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE'])

export const inject = ['webServer']

export function apply(ctx) {
  // A third-party plugin must never take the application down with it: a defect
  // here leaves only this panel inactive instead of failing the whole startup.
  try {
    setup(ctx)
  } catch (error) {
    try {
      console.error('[github-panel] activation failed:', error)
    } catch {
      /* no console available */
    }
  }
}

function setup(ctx) {
  const webServer = ctx.webServer
  const planned = []

  function credentialService() {
    try {
      return typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
    } catch {
      return undefined
    }
  }

  function credentialKey() {
    return RECORD_KEY_PATTERN.test(RECORD_KEY) ? RECORD_KEY : undefined
  }

  function fallbackFile() {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    return path.join(home, 'plugin-data', 'github-panel.json')
  }

  async function readFallback() {
    try {
      const raw = await fs.readFile(fallbackFile(), 'utf8')
      const parsed = JSON.parse(raw)
      return typeof parsed?.token === 'string' && parsed.token ? parsed.token : undefined
    } catch {
      return undefined
    }
  }

  async function writeFallback(token) {
    const file = fallbackFile()
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ token }), { encoding: 'utf8', mode: 0o600 })
  }

  async function clearFallback() {
    try {
      await fs.unlink(fallbackFile())
    } catch {
      /* already absent */
    }
  }

  let legacyRecordCleaned = false

  async function dropLegacyCredentialRecord() {
    if (legacyRecordCleaned) return
    legacyRecordCleaned = true
    const service = credentialService()
    const key = credentialKey()
    if (!service || !key || typeof service.deleteRecord !== 'function') return
    try {
      await service.deleteRecord(key)
    } catch {
      /* nothing to clean */
    }
  }

  // The token lives in the plugin's own 0600 file. It used to sit in the shared
  // credentials store, where one malformed record can stop the whole profile from
  // booting; keeping plugin data in plugin data means a bad token can only ever
  // break this panel. Existing credentials records are still read once and
  // migrated into the file.
  async function readToken() {
    const stored = await readFallback()
    if (stored) {
      await dropLegacyCredentialRecord()
      return stored
    }
    const service = credentialService()
    const key = credentialKey()
    if (service && key && typeof service.readRecord === 'function') {
      try {
        const record = await service.readRecord(key)
        if (record && record.kind === 'api-key' && typeof record.key === 'string' && record.key) {
          // Only forget the legacy record once its value really lives in our own
          // file; a failed write must not cost the user their token.
          const migrated = await writeFallback(record.key).then(() => true, () => false)
          if (migrated) await dropLegacyCredentialRecord()
          return record.key
        }
      } catch {
        /* no legacy record */
      }
    }
    return undefined
  }

  async function saveToken(token) {
    await writeFallback(token)
    const service = credentialService()
    const key = credentialKey()
    if (service && key && typeof service.deleteRecord === 'function') {
      try {
        await service.deleteRecord(key)
      } catch {
        /* an orphaned legacy record is harmless */
      }
    }
  }

  async function clearToken() {
    await clearFallback()
    const service = credentialService()
    const key = credentialKey()
    if (service && key && typeof service.deleteRecord === 'function') {
      try {
        await service.deleteRecord(key)
      } catch {
        /* ignore */
      }
    }
  }

  function json(res, status, body) {
    const text = JSON.stringify(body ?? null)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    })
    res.end(text)
  }

  function sameOrigin(req) {
    let origin
    try {
      origin = webServer.getOrigin()
    } catch {
      origin = undefined
    }
    const sent = req.headers.origin
    if (typeof sent === 'string' && sent && origin && sent !== origin) return false
    const site = req.headers['sec-fetch-site']
    if (!sent && typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
    return true
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY) {
          reject(new Error('请求体过大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (!text.trim()) return resolve(undefined)
        try {
          resolve(JSON.parse(text))
        } catch {
          reject(new Error('请求体不是合法 JSON'))
        }
      })
      req.on('error', reject)
    })
  }

  function describe(result) {
    const data = result.data
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      let message = typeof data.message === 'string' && data.message ? data.message : `HTTP ${result.status}`
      if (Array.isArray(data.errors) && data.errors.length) {
        message += ' — ' + data.errors.map((entry) => entry?.message || entry?.code || JSON.stringify(entry)).join('; ')
      }
      if (result.status === 401) message = `令牌无效或权限不足：${message}`
      if (result.status === 403 && /rate limit/i.test(message)) message = `触发 GitHub 速率限制：${message}`
      return message
    }
    if (typeof data === 'string' && data.trim()) return `HTTP ${result.status}：${data.slice(0, 200)}`
    return `HTTP ${result.status}`
  }

  async function request(token, method, target, body) {
    const init = {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'dsh-github-panel',
        'x-github-api-version': '2022-11-28',
      },
    }
    if (token) init.headers.authorization = `Bearer ${token}`
    if (body !== undefined && method !== 'GET' && method !== 'DELETE') {
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    const response = await fetch(API + target, init)
    const text = await response.text()
    let data = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = text
      }
    }
    return { status: response.status, ok: response.ok, data }
  }

  const PUBLIC_READ_PREFIXES = ['/users/', '/repos/', '/search/', '/organizations/', '/rate_limit']

  /* 未登录时只放行「读公开数据」的 GET，账号私有接口一律要求令牌。 */
  function isPublicRead(method, target) {
    if (method !== 'GET') return false
    if (target === '/user' || target.startsWith('/user/')) return false
    if (target.startsWith('/user/starred') || target.startsWith('/notifications')) return false
    return PUBLIC_READ_PREFIXES.some((prefix) => target.startsWith(prefix))
  }

  function profileOf(data) {
    if (!data || typeof data !== 'object') return null
    return {
      login: data.login,
      name: data.name || data.login,
      avatarUrl: data.avatar_url,
      htmlUrl: data.html_url,
    }
  }

  /* --------------------------------------------------------------- skills */

  const MAX_SKILL_FILES = 400
  const MAX_SKILL_FILE_BYTES = 2 << 20

  function dshHome() {
    return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  }

  function skillsRoot() {
    return path.join(dshHome(), 'skills')
  }

  function parseFrontMatter(text) {
    const out = {}
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''))
    if (!match) return out
    for (const line of match[1].split(/\r?\n/)) {
      const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
      if (!pair) continue
      let value = pair[2].trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (value) out[pair[1]] = value
    }
    return out
  }

  async function readSkillDir(entryName) {
    const dir = path.join(skillsRoot(), entryName)
    let stat
    try {
      stat = await fs.stat(dir)
    } catch {
      return undefined
    }
    if (!stat.isDirectory()) return undefined
    let text = ''
    try {
      text = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8')
    } catch {
      return undefined
    }
    const meta = parseFrontMatter(text)
    let hub = null
    try {
      hub = JSON.parse(await fs.readFile(path.join(dir, '.skill-hub.json'), 'utf8'))
    } catch {
      hub = null
    }
    return {
      name: meta.name || entryName,
      dir: entryName,
      description: meta.description || (hub && hub.description) || '',
      whenToUse: meta.whenToUse || meta['when-to-use'] || '',
      source: hub ? 'github' : 'local',
      repo: hub ? hub.repo || null : null,
      ref: hub ? hub.ref || null : null,
      dirInRepo: hub ? hub.dir || null : null,
      commitSha: hub ? hub.commitSha || null : null,
      installedAt: hub ? hub.installedAt || null : null,
      fileCount: hub ? hub.fileCount || null : null,
      path: dir,
      updatedAt: stat.mtime.toISOString(),
      size: text.length,
    }
  }

  async function listSkills() {
    let names = []
    try {
      names = await fs.readdir(skillsRoot())
    } catch {
      return []
    }
    const out = []
    for (const name of names) {
      if (name.startsWith('.')) continue
      const skill = await readSkillDir(name)
      if (skill) out.push(skill)
    }
    out.sort((a, b) => String(a.name).localeCompare(String(b.name)))
    return out
  }

  function safeSkillName(raw, fallback) {
    const base = String(raw || fallback || '').trim().toLowerCase()
    const cleaned = base.replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
    return cleaned || 'skill-' + Date.now().toString(36)
  }

  /**
   * Install one skill directory from a GitHub repository into the harness skill
   * catalog. Everything is fetched live through the API, so the installed copy
   * always matches the repository at the resolved commit.
   */
  async function installSkillFromRepo(token, request_) {
    const repo = String(request_.repo || '').trim()
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      throw new Error('仓库要写成 owner/name 的形式')
    }
    let ref = String(request_.ref || '').trim()
    if (!ref) {
      const info = await request(token, 'GET', '/repos/' + repo)
      if (!info.ok) throw new Error('读取仓库失败：' + describe(info))
      ref = info.data?.default_branch || 'main'
    }
    let dir = String(request_.dir || '').trim().replace(/^\/+|\/+$/g, '')
    if (dir === '.') dir = ''

    const commit = await request(token, 'GET', '/repos/' + repo + '/commits/' + encodeURIComponent(ref))
    const commitSha = commit.ok ? commit.data?.sha || null : null
    const treeRef = commitSha || ref

    const tree = await request(token, 'GET', '/repos/' + repo + '/git/trees/' + encodeURIComponent(treeRef) + '?recursive=1')
    if (!tree.ok) throw new Error('读取仓库文件树失败：' + describe(tree))
    const all = Array.isArray(tree.data?.tree) ? tree.data.tree : []
    const prefixed = dir ? dir + '/' : ''

    let files = all.filter((entry) => {
      if (entry.type !== 'blob') return false
      if (dir && entry.path !== dir && !entry.path.startsWith(prefixed)) return false
      return true
    })

    const skillFile = files.find((entry) => entry.path === (dir ? prefixed + 'SKILL.md' : 'SKILL.md'))
    if (!skillFile) {
      const hint = dir
        ? '目录 ' + dir + ' 下没有 SKILL.md'
        : '仓库根目录没有 SKILL.md（这个仓库可能是一个技能合集，请填写技能所在的子目录）'
      throw new Error(hint)
    }
    if (files.length > MAX_SKILL_FILES) {
      throw new Error('这个目录有 ' + files.length + ' 个文件，超过 ' + MAX_SKILL_FILES + ' 个上限，请安装更具体的子目录')
    }

    // Read SKILL.md first: its front matter names the skill.
    const readBlob = async (entry) => {
      if (typeof entry.size === 'number' && entry.size > MAX_SKILL_FILE_BYTES) {
        throw new Error('文件过大：' + entry.path)
      }
      const result = await request(
        token,
        'GET',
        '/repos/' + repo + '/contents/' + entry.path.split('/').map(encodeURIComponent).join('/') + '?ref=' + encodeURIComponent(treeRef),
      )
      if (!result.ok) throw new Error('读取 ' + entry.path + ' 失败：' + describe(result))
      const data = result.data
      if (data?.encoding !== 'base64' || typeof data?.content !== 'string') return ''
      return Buffer.from(data.content, 'base64').toString('utf8')
    }

    const skillText = await readBlob(skillFile)
    const meta = parseFrontMatter(skillText)
    const installName = safeSkillName(meta.name, dir ? dir.split('/').pop() : repo.split('/').pop())
    const target = path.join(skillsRoot(), installName)

    const written = []
    for (const entry of files) {
      if (entry.path === skillFile.path) continue
      const relative = dir ? entry.path.slice(prefixed.length) : entry.path
      if (!relative || relative.startsWith('..')) continue
      const destination = path.join(target, relative)
      if (!destination.startsWith(target + path.sep)) continue
      const text = await readBlob(entry)
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.writeFile(destination, text, 'utf8')
      written.push(relative)
    }
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(path.join(target, 'SKILL.md'), skillText, 'utf8')

    const hub = {
      installName,
      source: 'github',
      repo,
      ref,
      dir: dir || null,
      commitSha,
      installedAt: new Date().toISOString(),
      fileCount: written.length + 1,
      description: meta.description || '',
      whenToUse: meta.whenToUse || meta['when-to-use'] || '',
    }
    await fs.writeFile(path.join(target, '.skill-hub.json'), JSON.stringify(hub, null, 2), 'utf8')

    return {
      name: installName,
      repo,
      ref,
      commitSha,
      fileCount: hub.fileCount,
      description: hub.description,
      path: target,
      replaced: true,
    }
  }

  async function removeSkill(name) {
    const entry = String(name || '').trim()
    if (!entry || entry.includes('/') || entry.includes('\\') || entry === '.' || entry === '..') {
      throw new Error('技能名称不合法')
    }
    const dir = path.join(skillsRoot(), entry)
    const root = skillsRoot()
    if (!path.resolve(dir).startsWith(path.resolve(root) + path.sep)) throw new Error('技能名称不合法')
    await fs.rm(dir, { recursive: true, force: true })
    return { ok: true, name: entry }
  }

  /* --------------------------------------------------------------- clones */

  const CLONE_META = 'github-panel-clone.json'
  const GIT_TIMEOUT = 300000
  // A big repository can take a long time to download; what matters is that data
  // keeps flowing. Give clone/fetch 30 minutes, but stop after 3 silent minutes.
  const CLONE_TIMEOUT = 1800000
  const CLONE_STALL_MS = 180000
  const DEFAULT_AUTO_MINUTES = 15

  function cloneRoot() {
    return process.env.DSH_GITHUB_CLONE_DIR || path.join(dshHome(), 'github-clones')
  }

  function cloneConfigFile() {
    return path.join(dshHome(), 'plugin-data', 'github-panel-clones.json')
  }

  function cloneDir(repo) {
    return path.join(cloneRoot(), ...repo.split('/'))
  }

  function cloneUrl(repo) {
    const base = (process.env.DSH_GITHUB_GIT_BASE || 'https://github.com').replace(/\/+$/, '')
    return base + '/' + repo + '.git'
  }

  function validRepo(repo) {
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repo || ''))
  }

  let gitVersion = null
  let gitChecked = false

  async function gitInfo() {
    if (!gitChecked) {
      gitChecked = true
      const result = await runGit(['--version'], { timeout: 20000 })
      gitVersion = result.code === 0 ? String(result.stdout).trim() : null
    }
    return gitVersion
  }

  function gitEnv(token) {
    const env = Object.assign({}, process.env)
    env.GIT_TERMINAL_PROMPT = '0'
    env.GIT_ASKPASS = 'echo'
    env.GCM_INTERACTIVE = 'never'
    const config = []
    if (process.platform === 'win32') config.push(['http.sslBackend', 'openssl'])
    if (token) {
      const basic = Buffer.from('x-access-token:' + token, 'utf8').toString('base64')
      config.push(['http.extraheader', 'Authorization: Basic ' + basic])
    }
    env.GIT_CONFIG_COUNT = String(config.length)
    config.forEach((pair, index) => {
      env['GIT_CONFIG_KEY_' + index] = pair[0]
      env['GIT_CONFIG_VALUE_' + index] = pair[1]
    })
    return env
  }

  /**
   * Run one git command; never rejects so callers can branch on the exit code.
   * The sandbox this plugin runs under forbids piped stdio for child processes,
   * so git writes to temp files that are read back once the process exits.
   */
  async function runGit(args, options = {}) {
    const { cwd, token, timeout = GIT_TIMEOUT, stallMs = 0, onOutput } = options
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ghp-git-')).catch(() => null)
    const stdoutPath = scratch ? path.join(scratch, 'stdout.log') : null
    const stderrPath = scratch ? path.join(scratch, 'stderr.log') : null
    let outHandle = null
    let errHandle = null
    let timedOut = false
    let stalled = false
    let code = -1
    try {
      if (scratch) {
        outHandle = await fs.open(stdoutPath, 'w')
        errHandle = await fs.open(stderrPath, 'w')
      }
      code = await new Promise((resolve) => {
        let child
        try {
          child = spawn('git', args, {
            cwd,
            env: gitEnv(token),
            stdio: ['ignore', outHandle ? outHandle.fd : 'ignore', errHandle ? errHandle.fd : 'ignore'],
            windowsHide: true,
          })
        } catch {
          resolve(-1)
          return
        }
        let settled = false
        const finish = (exitCode) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (poller) clearInterval(poller)
          if (watchdog) clearInterval(watchdog)
          resolve(exitCode)
        }
        const kill = () => {
          try {
            child.kill()
          } catch {
            /* already gone */
          }
        }
        const timer = setTimeout(() => {
          timedOut = true
          kill()
        }, timeout)
        // git reports byte progress on stderr; keep the UI fed and stop a transfer
        // that has produced no output at all for stallMs (dead network, huge repo).
        let lastSize = 0
        let lastGrowth = Date.now()
        const poller =
          scratch && onOutput
            ? setInterval(() => {
                fs.readFile(stderrPath).then((buffer) => {
                  if (buffer.length === lastSize) return
                  lastSize = buffer.length
                  lastGrowth = Date.now()
                  try {
                    onOutput(buffer.toString('utf8'))
                  } catch {
                    /* a bad consumer must not kill the transfer */
                  }
                }).catch(() => {})
              }, 400)
            : null
        const watchdog =
          stallMs > 0 && poller
            ? setInterval(() => {
                if (Date.now() - lastGrowth < stallMs) return
                stalled = true
                kill()
              }, 1000)
            : null
        child.on('error', () => finish(-1))
        child.on('close', (exitCode) => finish(exitCode))
      })
    } catch {
      code = -1
    } finally {
      await outHandle?.close().catch(() => {})
      await errHandle?.close().catch(() => {})
    }
    let stdout = ''
    let stderr = ''
    if (scratch) {
      stdout = await fs.readFile(stdoutPath, 'utf8').catch(() => '')
      stderr = await fs.readFile(stderrPath, 'utf8').catch(() => '')
      await fs.rm(scratch, { recursive: true, force: true }).catch(() => {})
    }
    if (timedOut) stderr += '\n（操作超时）'
    if (stalled) stderr += '\n（长时间没有进度，已停止）'
    return { code, stdout, stderr }
  }

  // [git stage, Chinese label, share of the whole job at 0%, share at 100%]
  // git reports a percentage per stage, so the panel maps every stage onto a slice
  // of one overall bar: the number then only ever grows, and never sits at 100%
  // while git is still resolving deltas.
  const PROGRESS_PHASES = [
    ['Cloning into', '连接 GitHub', 0, 2],
    ['Enumerating objects', '统计对象', 2, 6],
    ['Counting objects', '统计对象', 2, 6],
    ['Compressing objects', '压缩对象', 6, 10],
    ['Receiving objects', '接收对象', 10, 86],
    ['Resolving deltas', '整理差异', 86, 96],
    ['Unpacking objects', '解包对象', 96, 98],
    ['Updating files', '更新文件', 96, 100],
    ['Checking out files', '检出文件', 96, 100],
  ]

  function parseGitProgress(text) {
    // git writes its progress meter with carriage returns and prefixes remote
    // stages with "remote: ", so split on either break and strip that prefix.
    const lines = String(text || '')
      .split(/[\r\n]+/)
      .map((line) => line.replace(/^\s*remote:\s*/i, '').trim())
      .filter(Boolean)
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const match = lines[index].match(/^([A-Za-z][A-Za-z ]*?):\s*(\d{1,3})%/)
      if (!match) continue
      const stage = match[1]
      const step = Math.max(0, Math.min(100, Number(match[2]) || 0))
      const known = PROGRESS_PHASES.find((pair) => stage.toLowerCase().startsWith(pair[0].toLowerCase()))
      if (!known) return { label: stage, step, percent: step }
      const percent = Math.round(known[2] + ((known[3] - known[2]) * step) / 100)
      return { label: known[1], step, percent }
    }
    return null
  }

  // Clones and syncs run inside an HTTP request, so the browser cannot see git's
  // stderr. A small registry carries the latest percentage to the panel instead.
  const gitJobs = new Map()

  function jobSet(repo, patch) {
    const current = gitJobs.get(repo) || { repo, phase: '', percent: 0, step: 0, label: '', detail: '', done: false, error: null, startedAt: Date.now() }
    Object.assign(current, patch, { updatedAt: Date.now() })
    gitJobs.set(repo, current)
    return current
  }

  function jobFinish(repo, patch) {
    jobSet(repo, Object.assign({ done: true }, patch))
    const timer = setTimeout(() => {
      const job = gitJobs.get(repo)
      if (job && job.done) gitJobs.delete(repo)
    }, 15000)
    timer.unref?.()
  }

  function progressReporter(repo, phase) {
    return (text) => {
      const parsed = parseGitProgress(text)
      if (!parsed) return
      const previous = gitJobs.get(repo)
      // Keep the number monotonic even if a late line from an earlier stage lands
      // after this one, so the bar never walks backwards.
      const percent = Math.max(previous ? Number(previous.percent) || 0 : 0, parsed.percent)
      const detail = parsed.label + (parsed.percent >= 100 ? '' : ' ' + parsed.step + '%')
      if (previous && previous.percent === percent && previous.detail === detail) return
      jobSet(repo, { phase, percent, step: parsed.step, label: parsed.label, detail, done: false })
    }
  }

  function gitFailure(result) {
    const text = String(result.stderr || result.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-3)
      .join(' ')
    return text || 'git 命令失败（退出码 ' + result.code + '）'
  }

  async function readCloneMeta(dir) {
    try {
      const raw = await fs.readFile(path.join(dir, '.git', CLONE_META), 'utf8')
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  async function writeCloneMeta(dir, meta) {
    await fs.writeFile(path.join(dir, '.git', CLONE_META), JSON.stringify(meta, null, 2), 'utf8')
  }

  async function cloneStatus(dir) {
    const state = { branch: null, upstream: null, behind: null, ahead: null, dirty: false, head: null }
    const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, timeout: 20000 })
    if (branch.code === 0) state.branch = String(branch.stdout).trim()
    const head = await runGit(['rev-parse', '--short', 'HEAD'], { cwd: dir, timeout: 20000 })
    if (head.code === 0) state.head = String(head.stdout).trim()
    const upstream = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
      cwd: dir,
      timeout: 20000,
    })
    if (upstream.code === 0) {
      state.upstream = String(upstream.stdout).trim()
      const behind = await runGit(['rev-list', '--count', 'HEAD..@{u}'], { cwd: dir, timeout: 20000 })
      if (behind.code === 0) state.behind = Number(String(behind.stdout).trim()) || 0
      const ahead = await runGit(['rev-list', '--count', '@{u}..HEAD'], { cwd: dir, timeout: 20000 })
      if (ahead.code === 0) state.ahead = Number(String(ahead.stdout).trim()) || 0
    }
    const dirty = await runGit(['status', '--porcelain'], { cwd: dir, timeout: 20000 })
    if (dirty.code === 0) state.dirty = String(dirty.stdout).trim().length > 0
    return state
  }

  async function listClones() {
    const root = cloneRoot()
    let owners = []
    try {
      owners = await fs.readdir(root, { withFileTypes: true })
    } catch {
      return []
    }
    const out = []
    for (const owner of owners) {
      if (!owner.isDirectory() || owner.name.startsWith('.')) continue
      let entries = []
      try {
        entries = await fs.readdir(path.join(root, owner.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const repo = owner.name + '/' + entry.name
        const dir = path.join(root, owner.name, entry.name)
        const meta = await readCloneMeta(dir)
        if (!meta) continue
        const state = await cloneStatus(dir)
        out.push({
          repo,
          dir,
          branch: state.branch,
          upstream: state.upstream,
          behind: state.behind,
          ahead: state.ahead,
          dirty: state.dirty,
          head: state.head,
          url: meta.url || cloneUrl(repo),
          ref: meta.ref || null,
          clonedAt: meta.clonedAt || null,
          lastSync: meta.lastSync || meta.clonedAt || null,
          lastError: meta.lastError || null,
          autoSync: meta.autoSync !== false,
        })
      }
    }
    out.sort((a, b) => String(a.repo).toLowerCase().localeCompare(String(b.repo).toLowerCase()))
    return out
  }

  /** Refresh remote-tracking refs for every clone; failures stay per clone. */
  async function fetchClones(clones) {
    const token = await readToken().catch(() => undefined)
    await Promise.all(
      clones.map((clone) =>
        runGit(['fetch', '--quiet', '--prune', '--tags', 'origin'], { cwd: clone.dir, token, timeout: 120000 }).catch(() => null),
      ),
    )
  }

  async function cloneRepo(token, request_) {
    const repo = String(request_?.repo || '').trim()
    if (!validRepo(repo)) throw new Error('仓库要写成 owner/name 的形式')
    const ref = String(request_?.ref || '').trim()
    if (ref && !/^[A-Za-z0-9._\/-]+$/.test(ref)) throw new Error('分支名不合法')
    if (!(await gitInfo())) throw new Error('本机没有找到 git，请先安装 Git 并加入 PATH')
    const dir = cloneDir(repo)
    try {
      await fs.access(path.join(dir, '.git'))
      throw new Error(repo + ' 已经克隆过了')
    } catch (error) {
      if (error && String(error.message).includes('已经克隆过了')) throw error
      /* not cloned yet */
    }
    await fs.mkdir(path.dirname(dir), { recursive: true })
    const args = ['clone', '--progress', '--single-branch']
    if (ref) args.push('--branch', ref)
    args.push(cloneUrl(repo), dir)
    jobSet(repo, { phase: 'clone', percent: 0, step: 0, label: '连接 GitHub', detail: '连接 GitHub', done: false, error: null, startedAt: Date.now() })
    const result = await runGit(args, {
      token,
      timeout: CLONE_TIMEOUT,
      stallMs: CLONE_STALL_MS,
      onOutput: progressReporter(repo, 'clone'),
    })
    if (result.code !== 0) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      jobFinish(repo, { percent: 0, step: 0, label: '失败', detail: '失败', error: '克隆失败：' + gitFailure(result) })
      throw new Error('克隆失败：' + gitFailure(result))
    }
    const state = await cloneStatus(dir)
    jobFinish(repo, { percent: 100, step: 100, label: '完成', detail: '完成' })
    const meta = {
      repo,
      url: cloneUrl(repo),
      ref: ref || state.branch || null,
      clonedAt: new Date().toISOString(),
      lastSync: new Date().toISOString(),
      lastError: null,
      autoSync: true,
    }
    await writeCloneMeta(dir, meta)
    return { repo, dir, branch: state.branch, head: state.head, ref: meta.ref }
  }

  async function syncClone(token, repo) {
    const slug = String(repo || '').trim()
    if (!validRepo(slug)) throw new Error('仓库要写成 owner/name 的形式')
    const dir = cloneDir(slug)
    const meta = await readCloneMeta(dir)
    if (!meta) throw new Error(slug + ' 还没有克隆到本机')
    jobSet(slug, { phase: 'sync', percent: 0, step: 0, label: '连接 GitHub', detail: '连接 GitHub', done: false, error: null, startedAt: Date.now() })
    const fetch = await runGit(['fetch', '--progress', '--prune', '--tags', 'origin'], {
      cwd: dir,
      token,
      timeout: CLONE_TIMEOUT,
      stallMs: CLONE_STALL_MS,
      onOutput: progressReporter(slug, 'sync'),
    })
    if (fetch.code !== 0) {
      meta.lastError = gitFailure(fetch)
      meta.lastSync = new Date().toISOString()
      await writeCloneMeta(dir, meta)
      jobFinish(slug, { percent: 0, step: 0, label: '失败', detail: '失败', error: '拉取失败：' + meta.lastError })
      throw new Error('拉取失败：' + meta.lastError)
    }
    const state = await cloneStatus(dir)
    let action = 'up-to-date'
    if (state.dirty) {
      action = 'dirty'
    } else if (state.upstream && (state.behind || 0) > 0) {
      const merge = await runGit(['merge', '--ff-only', '@{u}'], { cwd: dir, token })
      if (merge.code === 0) {
        action = 'updated'
      } else {
        action = 'diverged'
        meta.lastError = gitFailure(merge)
      }
    }
    meta.lastSync = new Date().toISOString()
    if (action === 'updated' || action === 'up-to-date') meta.lastError = null
    await writeCloneMeta(dir, meta)
    const after = await cloneStatus(dir)
    jobFinish(slug, { percent: 100, step: 100, label: '完成', detail: '完成' })
    return {
      repo: slug,
      action,
      branch: after.branch,
      behind: after.behind,
      ahead: after.ahead,
      dirty: after.dirty,
      head: after.head,
      lastSync: meta.lastSync,
      error: meta.lastError || null,
    }
  }

  async function removeClone(repo) {
    const slug = String(repo || '').trim()
    if (!validRepo(slug)) throw new Error('仓库要写成 owner/name 的形式')
    const dir = cloneDir(slug)
    const root = path.resolve(cloneRoot())
    if (!path.resolve(dir).startsWith(root + path.sep)) throw new Error('仓库路径不合法')
    await fs.rm(dir, { recursive: true, force: true })
    try {
      const ownerDir = path.dirname(dir)
      const rest = await fs.readdir(ownerDir)
      if (rest.length === 0) await fs.rmdir(ownerDir)
    } catch {
      /* leave the owner directory alone */
    }
    return { ok: true, repo: slug, dir }
  }

  let autoConfig = { enabled: true, minutes: DEFAULT_AUTO_MINUTES }
  let autoTimer = null

  async function readAutoConfig() {
    try {
      const parsed = JSON.parse(await fs.readFile(cloneConfigFile(), 'utf8'))
      const minutes = Number(parsed?.minutes)
      autoConfig = {
        enabled: parsed?.enabled !== false,
        minutes: Number.isFinite(minutes) && minutes >= 1 ? Math.min(720, Math.round(minutes)) : DEFAULT_AUTO_MINUTES,
      }
    } catch {
      autoConfig = { enabled: true, minutes: DEFAULT_AUTO_MINUTES }
    }
    return autoConfig
  }

  async function saveAutoConfig(next) {
    autoConfig = Object.assign({}, autoConfig, next)
    const file = cloneConfigFile()
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(autoConfig, null, 2), 'utf8')
    return autoConfig
  }

  async function autoSyncAll() {
    const token = await readToken().catch(() => undefined)
    const clones = await listClones().catch(() => [])
    for (const clone of clones) {
      if (!clone.autoSync) continue
      try {
        await syncClone(token, clone.repo)
      } catch {
        /* per-clone failures stay in that clone's metadata */
      }
    }
  }

  function scheduleAutoSync() {
    if (autoTimer) {
      clearInterval(autoTimer)
      autoTimer = null
    }
    if (!autoConfig.enabled) return
    const every = Math.max(60000, autoConfig.minutes * 60000)
    autoTimer = setInterval(() => {
      autoSyncAll().catch(() => {})
    }, every)
    if (typeof autoTimer.unref === 'function') autoTimer.unref()
  }

  readAutoConfig()
    .catch(() => {})
    .then(() => scheduleAutoSync())
    .catch(() => {})

  /* --------------------------------------------------------------- clones end */

  const routes = [
    {
      path: `${BASE}/state`,
      handler: async (req, res) => {
        if (!sameOrigin(req)) return json(res, 403, { connected: false, error: '来源不受信任' })
        try {
          const token = await readToken()
          if (!token) return json(res, 200, { connected: false })
          try {
            const result = await request(token, 'GET', '/user')
            if (result.ok) return json(res, 200, { connected: true, profile: profileOf(result.data) })
            return json(res, 200, { connected: true, profile: null, error: describe(result) })
          } catch (error) {
            return json(res, 200, {
              connected: true,
              profile: null,
              error: `无法连接 GitHub（网络或代理问题）：${error?.message || error}`,
            })
          }
        } catch (error) {
          return json(res, 500, { connected: false, error: String(error?.message || error) })
        }
      },
    },
    {
      path: `${BASE}/token`,
      handler: async (req, res) => {
        if (!sameOrigin(req)) return json(res, 403, { error: '来源不受信任' })
        if (req.method === 'DELETE') {
          await clearToken()
          return json(res, 200, { ok: true })
        }
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          return json(res, 400, { error: String(error.message || error) })
        }
        const token = typeof body?.token === 'string' ? body.token.trim() : ''
        if (token.length < 20) return json(res, 400, { error: '令牌格式看起来不对，请粘贴完整的个人访问令牌。' })
        let result
        try {
          result = await request(token, 'GET', '/user')
        } catch (error) {
          return json(res, 502, { error: `无法连接 GitHub（网络或代理问题）：${error?.message || error}` })
        }
        if (!result.ok) return json(res, 400, { error: describe(result) })
        await saveToken(token)
        return json(res, 200, { ok: true, profile: profileOf(result.data) })
      },
    },
    {
      path: `${BASE}/rpc`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
        if (!sameOrigin(req)) return json(res, 403, { ok: false, error: '来源不受信任' })
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error.message || error) })
        }
        const method = typeof body?.method === 'string' ? body.method.toUpperCase() : 'GET'
        const target = typeof body?.path === 'string' ? body.path : ''
        if (!METHODS.has(method)) return json(res, 400, { ok: false, error: '不支持的请求方法' })
        if (!target.startsWith('/') || target.startsWith('//') || target.includes('://')) {
          return json(res, 400, { ok: false, error: '非法的接口路径' })
        }
        const token = await readToken()
        if (!token && !isPublicRead(method, target)) {
          return json(res, 401, { ok: false, error: '尚未连接 GitHub' })
        }
        try {
          const result = await request(token, method, target, body?.body)
          return json(res, 200, {
            ok: result.ok,
            status: result.status,
            data: result.data,
            error: result.ok ? undefined : describe(result),
          })
        } catch (error) {
          return json(res, 502, { ok: false, error: `无法连接 GitHub：${error?.message || error}` })
        }
      },
    },
    {
      path: `${BASE}/skills`,
      handler: async (req, res) => {
        if (!sameOrigin(req)) return json(res, 403, { error: '来源不受信任' })
        try {
          return json(res, 200, { skills: await listSkills(), root: skillsRoot() })
        } catch (error) {
          return json(res, 500, { error: String(error?.message || error) })
        }
      },
    },
    {
      path: `${BASE}/skills/install`,
      handler: async (req, res) => {
        if (!sameOrigin(req)) return json(res, 403, { error: '来源不受信任' })
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          return json(res, 400, { error: String(error.message || error) })
        }
        const token = await readToken()
        if (!token) return json(res, 401, { error: '尚未连接 GitHub' })
        try {
          const skill = await installSkillFromRepo(token, body && typeof body === 'object' ? body : {})
          return json(res, 200, { ok: true, skill })
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message || error) })
        }
      },
    },
    {
      path: `${BASE}/skills/remove`,
      handler: async (req, res) => {
        if (!sameOrigin(req)) return json(res, 403, { error: '来源不受信任' })
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          return json(res, 400, { error: String(error.message || error) })
        }
        try {
          const result = await removeSkill(body?.name)
          return json(res, 200, result)
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message || error) })
        }
      },
    },
    {
      path: `${BASE}/clones`,
      handler: async (req, res) => {
        if (!sameOrigin(req)) return json(res, 403, { error: '来源不受信任' })
        try {
          const url = new URL(req.url, 'http://localhost')
          let clones = await listClones()
          // `fetch=1` refreshes the remote-tracking refs first, so the page can
          // show how far behind the author's latest push a clone is.
          if (url.searchParams.get('fetch') === '1' && clones.length > 0) {
            await fetchClones(clones)
            clones = await listClones()
          }
          const [git, auto] = await Promise.all([gitInfo(), readAutoConfig()])
          return json(res, 200, { root: cloneRoot(), git, auto, clones })
        } catch (error) {
          return json(res, 500, { error: String(error?.message || error) })
        }
      },
    },
    {
      path: `${BASE}/clones/progress`,
      handler: async (req, res) => {
        if (!sameOrigin(req)) return json(res, 403, { error: '来源不受信任' })
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        return json(res, 200, { jobs: Array.from(gitJobs.values()) })
      },
    },
    {
      path: `${BASE}/clones/clone`,
      handler: async (req, res) => {
        if (!sameOrigin(req)) return json(res, 403, { error: '来源不受信任' })
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          return json(res, 400, { error: String(error.message || error) })
        }
        const token = await readToken().catch(() => undefined)
        if (!token) return json(res, 401, { ok: false, error: '尚未连接 GitHub' })
        try {
          const clone = await cloneRepo(token, body && typeof body === 'object' ? body : {})
          return json(res, 200, Object.assign({ ok: true }, clone))
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message || error) })
        }
      },
    },
    {
      path: `${BASE}/clones/sync`,
      handler: async (req, res) => {
        if (!sameOrigin(req)) return json(res, 403, { error: '来源不受信任' })
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          return json(res, 400, { error: String(error.message || error) })
        }
        const token = await readToken().catch(() => undefined)
        try {
          if (body?.all === true) {
            const clones = await listClones()
            const results = []
            for (const clone of clones) {
              try {
                results.push(await syncClone(token, clone.repo))
              } catch (error) {
                results.push({ repo: clone.repo, action: 'failed', error: String(error?.message || error) })
              }
            }
            return json(res, 200, { ok: true, results })
          }
          const result = await syncClone(token, body?.repo)
          return json(res, 200, Object.assign({ ok: true }, result))
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message || error) })
        }
      },
    },
    {
      path: `${BASE}/clones/remove`,
      handler: async (req, res) => {
        if (!sameOrigin(req)) return json(res, 403, { error: '来源不受信任' })
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          return json(res, 400, { error: String(error.message || error) })
        }
        try {
          return json(res, 200, await removeClone(body?.repo))
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message || error) })
        }
      },
    },
    {
      path: `${BASE}/clones/auto`,
      handler: async (req, res) => {
        if (!sameOrigin(req)) return json(res, 403, { error: '来源不受信任' })
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          return json(res, 400, { error: String(error.message || error) })
        }
        const next = {}
        if (typeof body?.enabled === 'boolean') next.enabled = body.enabled
        if (body?.minutes !== undefined) {
          const minutes = Number(body.minutes)
          if (!Number.isFinite(minutes) || minutes < 1 || minutes > 720) {
            return json(res, 400, { ok: false, error: '同步间隔要在 1 到 720 分钟之间' })
          }
          next.minutes = Math.round(minutes)
        }
        try {
          const auto = await saveAutoConfig(next)
          scheduleAutoSync()
          return json(res, 200, { ok: true, auto })
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message || error) })
        }
      },
    },
  ]

  for (const route of routes) {
    try {
      planned.push(webServer.register({ kind: 'exact', path: route.path, handler: route.handler }))
    } catch {
      /* An older instance in this process already owns the path (hot reload without a
         restart). Keep serving through it instead of failing the whole entry. */
    }
  }

  /* Host tools: let the assistant read and change GitHub, and manage skills. */

  const toolService = ctx.get('tools')
  if (toolService && typeof toolService.register === 'function') {
    const output = (schema) => ({
      schema,
      render: (_args, value) => [
        { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
      ],
    })
    const tools = [
      {
        name: 'github_api',
        description:
          'Call the GitHub REST API as the connected account (token lives on the host). Works for any ' +
          'endpoint, e.g. GET /user/repos, GET /repos/owner/name/issues, POST /repos/owner/name/issues ' +
          'with a JSON body. Returns { ok, status, data }.',
        parameters: {
          type: 'object',
          properties: {
            method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'], description: 'HTTP method, default GET' },
            path: { type: 'string', description: 'API path starting with /, e.g. /repos/owner/name' },
            body: { type: 'object', description: 'JSON body for POST/PATCH/PUT' },
          },
          required: ['path'],
          additionalProperties: false,
        },
        output: output({ type: 'object' }),
        execute: async (args) => {
          const token = await readToken()
          if (!token) throw new Error('GitHub 尚未连接：请先在 GitHub 面板里填入令牌')
          const method = String(args?.method || 'GET').toUpperCase()
          const target = String(args?.path || '')
          if (!METHODS.has(method)) throw new Error('不支持的方法：' + method)
          if (!target.startsWith('/') || target.startsWith('//') || target.includes('://')) {
            throw new Error('非法路径：' + target)
          }
          const result = await request(token, method, target, args?.body)
          let data = result.data
          try {
            const encoded = JSON.stringify(data)
            if (encoded && encoded.length > 40000) {
              data = JSON.parse(encoded.slice(0, 40000) + '…')
            }
          } catch {
            /* keep as is */
          }
          return { ok: result.ok, status: result.status, data, error: result.ok ? undefined : describe(result) }
        },
      },
      {
        name: 'github_skill_list',
        description:
          'List the skills installed in the harness skill catalog (~/.dsh/skills), with source repo and description.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: output({ type: 'array' }),
        execute: async () => listSkills(),
      },
      {
        name: 'github_skill_install',
        description:
          'Install a skill from a GitHub repository into ~/.dsh/skills. Give repo as owner/name, plus the ' +
          'subdirectory that holds SKILL.md (leave dir empty when SKILL.md is at the repository root).',
        parameters: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'owner/name' },
            dir: { type: 'string', description: 'Directory inside the repo containing SKILL.md' },
            ref: { type: 'string', description: 'Branch, tag, or commit; default branch when omitted' },
          },
          required: ['repo'],
          additionalProperties: false,
        },
        output: output({ type: 'object' }),
        execute: async (args) => {
          const token = await readToken()
          if (!token) throw new Error('GitHub 尚未连接：请先在 GitHub 面板里填入令牌')
          return installSkillFromRepo(token, args || {})
        },
      },
      {
        name: 'github_skill_remove',
        description: 'Remove one installed skill from ~/.dsh/skills by its directory name.',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: 'Skill directory name' } },
          required: ['name'],
          additionalProperties: false,
        },
        output: output({ type: 'object' }),
        execute: async (args) => removeSkill(args?.name),
      },
      {
        name: 'github_clone_list',
        description:
          'List the repositories cloned to this machine (under ~/.dsh/github-clones), with branch, ' +
          'commits behind the remote, and the last sync result.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: output({ type: 'array' }),
        execute: async () => listClones(),
      },
      {
        name: 'github_clone',
        description:
          'Clone a GitHub repository onto this machine under ~/.dsh/github-clones/owner/name, using the ' +
          'connected token for private repositories. Clones are kept up to date by the auto-sync timer.',
        parameters: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'owner/name' },
            ref: { type: 'string', description: 'Branch or tag to check out; default branch when omitted' },
          },
          required: ['repo'],
          additionalProperties: false,
        },
        output: output({ type: 'object' }),
        execute: async (args) => {
          const token = await readToken().catch(() => undefined)
          return cloneRepo(token, args || {})
        },
      },
      {
        name: 'github_clone_sync',
        description:
          'Fast-forward local clones to their upstream: pass one repo as owner/name, or all=true to sync ' +
          'every clone. Clones with local changes are reported as dirty instead of being overwritten.',
        parameters: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'owner/name' },
            all: { type: 'boolean', description: 'Sync every cloned repository' },
          },
          additionalProperties: false,
        },
        output: output({ type: 'object' }),
        execute: async (args) => {
          const token = await readToken().catch(() => undefined)
          if (args?.all) {
            const clones = await listClones()
            const results = []
            for (const clone of clones) {
              try {
                results.push(await syncClone(token, clone.repo))
              } catch (error) {
                results.push({ repo: clone.repo, action: 'failed', error: String(error?.message || error) })
              }
            }
            return results
          }
          return syncClone(token, args?.repo)
        },
      },
    ]
    for (const definition of tools) {
      try {
        planned.push(toolService.register(definition))
      } catch {
        /* a duplicate name from another plugin must not break the panel */
      }
    }
  }

  ctx.on('dispose', () => {
    if (autoTimer) {
      clearInterval(autoTimer)
      autoTimer = null
    }
    for (const dispose of planned.splice(0)) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
  })
}
