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

  /**
   * Same-origin admission. The carrier already authenticated the browser session
   * and enforced its own trusted hosts, so this only has to prove the request was
   * made by the page itself. Compare against the authority the browser actually
   * addressed (`Host`), never against the loopback bind URL: behind a reverse
   * proxy or tunnel the page's origin is the public one, and comparing to the
   * bind address would reject every legitimate remote request.
   */
  function sameOrigin(req) {
    const site = req.headers['sec-fetch-site']
    if (typeof site === 'string' && site === 'cross-site') return false
    const sent = req.headers.origin
    if (typeof sent !== 'string' || sent === '') return true
    const host = req.headers.host
    if (typeof host !== 'string' || host === '') return false
    try {
      return new URL(sent).host === host
    } catch {
      return false
    }
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
    const lines = match[1].split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[index])
      if (!pair) continue
      const key = pair[1]
      let value = pair[2].trim()
      // YAML 块标量（description: | 后跟缩进行）不能把「|」当内容。
      if (/^[|>][-+]?$/.test(value)) {
        const fold = value.startsWith('>')
        const block = []
        while (index + 1 < lines.length && (/^\s+\S/.test(lines[index + 1]) || !lines[index + 1].trim())) {
          block.push(lines[index + 1].trim())
          index += 1
        }
        value = block.join(fold ? ' ' : '\n').trim()
      } else if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (value) out[key] = value
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

  /* ------------------------------------------------------- skill projects */

  // A project is one repository's worth of skills. The skills themselves must
  // stay one-directory-per-skill under ~/.dsh/skills so the harness can load
  // them; grouping, category and the Chinese descriptions live in an index
  // plus a small sidecar file inside every installed skill.
  const SKILL_PROJECT_META = '.dsh-project.json'
  const MAX_PROJECT_SKILLS = 40

  const CATEGORY_TABLE = [
    {
      id: 'drama',
      label: '漫剧',
      words: ['短剧', '漫剧', '微短剧', '剧本', '分镜', '角色', '人物', '场景', '小说', '台词', 'staging', 'storyboard', 'drama', 'script', 'novel', 'comic', 'character'],
    },
    {
      id: 'image',
      label: '图像设计',
      words: ['出图', '插画', '海报', '视觉', '角色图', '定妆照', '美术', 'image', 'img', 'svg', 'png', 'photo', 'poster', 'design', 'canvas', 'illustration'],
    },
    {
      id: 'video',
      label: '视频音频',
      words: ['视频', '剪辑', '配音', '音频', '字幕', 'video', 'audio', 'voice', 'tts', 'subtitle', 'clip'],
    },
    {
      id: 'dev',
      label: '开发工具',
      words: ['代码', '开发', '插件', '部署', '调试', '评测', 'code', 'dev', 'git', 'api', 'cli', 'build', 'test', 'plugin', 'mcp', 'harness', 'sdk', 'prompt', 'skill.md'],
    },
    {
      id: 'docs',
      label: '文档办公',
      words: ['文档', '写作', '报告', '简历', '论文', '排版', '表格', 'doc', 'write', 'report', 'markdown', 'pdf', 'ppt', 'excel', 'docx', 'xlsx'],
    },
    {
      id: 'data',
      label: '数据分析',
      words: ['数据', '分析', '统计', '爬虫', 'data', 'sql', 'csv', 'analysis', 'pandas', 'scrape'],
    },
    {
      id: 'auto',
      label: '自动化',
      words: ['自动化', '定时', '智能体', '工作流', 'automation', 'workflow', 'bot', 'agent', 'cron'],
    },
  ]
  const CATEGORY_OTHER = { id: 'other', label: '其他' }

  // 每个大类之下再按「制作流程」细分小类，界面上就是 漫剧 → 剧本 / 人物 / 分镜 …
  const SUBCATEGORY_TABLE = {
    drama: [
      { id: 'outline', label: '大纲改编', words: ['大纲', '改编', '拆书', 'outline', 'adapt'] },
      { id: 'script', label: '剧本台词', words: ['剧本', '台词', '场次', '写戏', 'script', 'screenplay', 'dialogue'] },
      { id: 'characters', label: '人物角色', words: ['人物', '角色', '人设', '画像', 'character', 'cast'] },
      { id: 'art', label: '美术场景', words: ['美术', '场景', '道具', '设定集', 'art', 'scene', 'prop'] },
      { id: 'storyboard', label: '分镜镜头', words: ['分镜', '镜头', 'storyboard', 'shot', 'frame'] },
      { id: 'staging', label: '站位调度', words: ['站位', '调度', '走位', 'staging', 'blocking'] },
      { id: 'video', label: '视频配音', words: ['视频', '配音', '音频', '字幕', 'video', 'audio', 'voice'] },
    ],
    image: [
      { id: 'poster', label: '海报封面', words: ['海报', '封面', '宣传图', 'poster', 'cover'] },
      { id: 'illustration', label: '插画视觉', words: ['插画', '视觉', '美术', 'illustration', 'visual', 'art'] },
      { id: 'ui', label: '界面图标', words: ['界面', '图标', 'ui', 'icon', 'logo'] },
      { id: 'export', label: '导出排版', words: ['导出', '排版', 'pdf', 'png', 'layout'] },
    ],
    video: [
      { id: 'editing', label: '剪辑合成', words: ['剪辑', '合成', 'edit', 'clip'] },
      { id: 'voice', label: '配音音频', words: ['配音', '音频', 'voice', 'audio', 'tts'] },
      { id: 'subtitle', label: '字幕翻译', words: ['字幕', '翻译', 'subtitle', 'caption'] },
    ],
    dev: [
      { id: 'plugin', label: '插件开发', words: ['插件', 'plugin', 'bundle'] },
      { id: 'test', label: '测试评测', words: ['测试', '调试', '评测', 'test', 'debug', 'eval'] },
      { id: 'deploy', label: '部署运维', words: ['部署', '运维', 'deploy', 'ops'] },
      { id: 'api', label: '接口集成', words: ['接口', '集成', 'api', 'sdk', 'mcp'] },
    ],
    docs: [
      { id: 'resume', label: '简历求职', words: ['简历', '求职', 'resume', 'cv'] },
      { id: 'report', label: '报告写作', words: ['报告', '论文', '写作', 'report', 'paper'] },
      { id: 'sheet', label: '表格数据', words: ['表格', 'sheet', 'excel', 'xlsx'] },
      { id: 'slides', label: '演示文稿', words: ['演示', '幻灯', 'ppt', 'slide', 'deck'] },
    ],
    data: [
      { id: 'cleaning', label: '数据清洗', words: ['清洗', '整理', 'clean', 'etl'] },
      { id: 'analysis', label: '分析建模', words: ['分析', '建模', 'analysis', 'model'] },
      { id: 'chart', label: '图表可视化', words: ['图表', '可视化', 'chart', 'viz'] },
    ],
    auto: [
      { id: 'workflow', label: '工作流', words: ['工作流', '流程', 'workflow', 'pipeline'] },
      { id: 'agent', label: '智能体', words: ['智能体', 'agent', 'bot'] },
      { id: 'schedule', label: '定时任务', words: ['定时', '计划', 'schedule', 'cron'] },
    ],
  }

  // 英文技能名用户看不懂：内置中文说明，未知技能回退到「分类 + 小类」模板。
  const ZH_SKILLS = {
    'canvas-design': '按设计哲学生成海报、插画等静态视觉，产出 .png / .pdf，适合做封面、宣传图和艺术风格实验。',
    'skill-creator': '创建、改写和评估「技能」本身：写 SKILL.md、优化描述与触发条件、跑评测，让技能更准地被调用。',
    'novel-outline': '把小说改编成短剧大纲：改编说明、人物表、爽点表、分集梗概和资产清单，带 14 道质量门自检。',
    'novel-script': '把大纲写成短剧剧本：场次 + 动作节拍与台词，逐集折算时长，并核对角色、场景与道具。',
    'novel-characters': '从小说里拆角色表、人物画像、形象与音色提示词，产出角色卡和可交互报告。',
    'novel-art': '给短剧出美术设定集：场景与叙事道具的设定意图、一致性锚点、光照变体与出图提示词。',
    'novel-staging': '给每一场排开场站位：谁站在哪件东西的哪一侧、坐着还是站着、面朝哪，输出可调整的站位报告。',
    'novel-storyboard': '给短剧出分镜：段 → 分镜 → 分镜图三层结构，每段带一条视频提示词，18 道质量门自检。',
    'character-refs': '给故事角色出参考图：先定一张正面全身锚点，再派生大头照、侧身、背面与细节，保证跨集一致。',
  }

  const ZH_REPOS = {
    'anthropics/skills': 'Anthropic 官方技能合集：静态视觉设计（海报 / 插画 / PDF）与技能创建、优化工具。',
    'eternityspring/shuohao-skills': '中文 AI 短剧（漫剧）制作流水线：大纲改编 → 剧本 → 人物 → 美术 → 站位 → 分镜，一条龙 7 个技能。',
  }

  const KEYWORD_STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'from', 'this', 'that', 'into', 'your', 'you', 'use', 'when', 'asked',
    'skill', 'skills', 'their', 'them', 'then', 'than', 'such', 'will', 'can', 'may', 'one', 'two', 'any',
    'a', 'an', 'of', 'to', 'in', 'on', 'by', 'is', 'are', 'it', 'as', 'at', 'or', 'if',
  ])

  function projectIndexFile() {
    return path.join(dshHome(), 'plugin-data', 'github-panel-projects.json')
  }

  async function loadProjectIndex() {
    try {
      const raw = await fs.readFile(projectIndexFile(), 'utf8')
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' && parsed.projects ? parsed : { projects: {} }
    } catch {
      return { projects: {} }
    }
  }

  async function saveProjectIndex(index) {
    const file = projectIndexFile()
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(index, null, 2), 'utf8')
  }

  function hasCjk(text) {
    return /[\u4e00-\u9fff]/.test(String(text || ''))
  }

  function firstSentence(text, limit = 90) {
    const flat = String(text || '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!flat) return ''
    const cut = /^(.{10,}?)[。！？!?；;.]/.exec(flat)
    const sentence = cut ? cut[1] : flat
    return sentence.length > limit ? sentence.slice(0, limit - 1) + '…' : sentence
  }

  function classifyProject(text) {
    const haystack = String(text || '').toLowerCase()
    let best = { id: CATEGORY_OTHER.id, label: CATEGORY_OTHER.label, score: 0 }
    for (const category of CATEGORY_TABLE) {
      let score = 0
      for (const word of category.words) {
        const needle = word.toLowerCase()
        if (!needle) continue
        let index = haystack.indexOf(needle)
        while (index !== -1) {
          score += 1
          index = haystack.indexOf(needle, index + needle.length)
        }
      }
      if (score > best.score) best = { id: category.id, label: category.label, score }
    }
    return best
  }

  function subcategoryOf(text, categoryId) {
    const table = SUBCATEGORY_TABLE[categoryId] || []
    const haystack = String(text || '').toLowerCase()
    let best = null
    let bestScore = 0
    for (const entry of table) {
      let score = 0
      for (const word of entry.words) {
        if (haystack.includes(word.toLowerCase())) score += 1
      }
      if (score > bestScore) {
        best = entry
        bestScore = score
      }
    }
    return best
  }

  /** Chinese one-liner for a skill: curated name first, then its own Chinese description. */
  function skillSummaryZh(skill, categoryId) {
    const curated = ZH_SKILLS[skill.name]
    if (curated) return curated
    const desc = String(skill.description || '').replace(/\s+/g, ' ').trim()
    if (hasCjk(desc) && desc.length >= 4 && desc !== '|') return firstSentence(desc, 96)
    const sub = subcategoryOf(`${skill.name} ${skill.description || ''}`, categoryId)
    const kind = sub ? sub.label : '通用'
    return `「${skill.name}」属于${kind}类技能${skill.fileCount ? `，含 ${skill.fileCount} 个文件` : ''}，装好后 AI 可直接调用。`
  }

  function collectKeywords(texts, limit = 12) {
    const counts = new Map()
    const order = []
    const push = (word) => {
      const value = String(word || '').trim()
      if (!value) return
      if (!counts.has(value)) order.push(value)
      counts.set(value, (counts.get(value) || 0) + 1)
    }
    const vocabulary = CATEGORY_TABLE.flatMap((category) => category.words)
    for (const raw of texts) {
      const text = String(raw || '')
      if (!text) continue
      const lower = text.toLowerCase()
      // Curated vocabulary first: these are the words users and the model
      // actually search with, so they outrank any n-gram we could extract.
      for (const word of vocabulary) {
        if (word.length < 2 || !lower.includes(word.toLowerCase())) continue
        push(word)
      }
      for (const token of text.match(/[A-Za-z][A-Za-z0-9+#.]{2,}/g) || []) {
        const word = token.toLowerCase().replace(/[.]+$/, '')
        if (word.length < 3 || KEYWORD_STOPWORDS.has(word)) continue
        push(word)
      }
      for (const run of text.match(/[\u4e00-\u9fff]{2,}/g) || []) {
        for (const piece of run.split(/[与和及、，。的了]/)) {
          const value = piece.trim()
          if (value.length < 2 || value.length > 6) continue
          if (/(技能|合集|项目|教程|说明)$/.test(value)) continue
          push(value)
        }
      }
    }
    const ranked = order
      .slice()
      .sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0))
      .slice(0, limit)
    return ranked
  }

  function yamlString(value) {
    // Double-quoted YAML keeps ":" and "#" harmless and stays on one line.
    return JSON.stringify(String(value == null ? '' : value))
  }

  /**
   * Rewrite the two front-matter fields the model actually sees when it picks a
   * skill (description, whenToUse) so both the Chinese summary and the retrieval
   * keywords travel with the skill, not just with our own index.
   */
  async function enrichSkillFrontMatter(dir, { summaryZh, keywords }) {
    const file = path.join(dir, 'SKILL.md')
    const text = await fs.readFile(file, 'utf8')
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    const body = match ? text.slice(match[0].length) : text
    const kept = []
    if (match) {
      const lines = match[1].split(/\r?\n/)
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]
        if (/^(description|whenToUse|when-to-use|when_to_use)\s*:/.test(line)) {
          // Drop the whole value, including indented block-scalar follow-ups.
          while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) i += 1
          continue
        }
        if (/^name\s*:/.test(line)) continue
        kept.push(line)
      }
    }
    const list = Array.isArray(keywords) ? keywords.filter(Boolean).slice(0, 16) : []
    const whenToUse = list.length
      ? `关键词 ${list.join('、')}；适用于：${summaryZh || '相关任务'}`
      : summaryZh || ''
    const front = [
      '---',
      `name: ${yamlString(path.basename(dir))}`,
      `description: ${yamlString(summaryZh || '')}`,
      `whenToUse: ${yamlString(whenToUse)}`,
      ...kept.filter((line) => line.trim() !== ''),
      '---',
    ].join('\n')
    const next = front + '\n' + body.replace(/^\r?\n+/, '')
    await fs.writeFile(file, next, 'utf8')
    return { summaryZh, keywords: list }
  }

  async function writeSkillProjectMeta(dir, meta) {
    await fs.writeFile(path.join(dir, SKILL_PROJECT_META), JSON.stringify(meta, null, 2), 'utf8')
  }

  async function readSkillProjectMeta(dir) {
    try {
      return JSON.parse(await fs.readFile(path.join(dir, SKILL_PROJECT_META), 'utf8'))
    } catch {
      return null
    }
  }

  /** Install every skill of a repository as one project and classify it. */
  async function installProjectFromRepo(token, request_) {
    const repo = String(request_.repo || '').trim()
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('仓库要写成 owner/name 的形式')
    let ref = String(request_.ref || '').trim()
    if (!ref) {
      const info = await request(token, 'GET', '/repos/' + repo)
      if (!info.ok) throw new Error('读取仓库失败：' + describe(info))
      ref = info.data?.default_branch || 'main'
    }
    const commit = await request(token, 'GET', '/repos/' + repo + '/commits/' + encodeURIComponent(ref))
    const commitSha = commit.ok ? commit.data?.sha || null : null
    const treeRef = commitSha || ref
    const tree = await request(token, 'GET', '/repos/' + repo + '/git/trees/' + encodeURIComponent(treeRef) + '?recursive=1')
    if (!tree.ok) throw new Error('读取仓库文件树失败：' + describe(tree))
    const all = Array.isArray(tree.data?.tree) ? tree.data.tree : []
    const dirs = []
    for (const entry of all) {
      if (entry.type !== 'blob') continue
      const p = entry.path
      if (p === 'SKILL.md') dirs.push('')
      else if (p.endsWith('/SKILL.md')) dirs.push(p.slice(0, -'/SKILL.md'.length))
    }
    const unique = Array.from(new Set(dirs)).filter((dir) => dir.split('/').length <= 3)
    if (unique.length === 0) throw new Error('这个仓库里没有找到任何 SKILL.md，无法作为技能项目安装')
    if (unique.length > MAX_PROJECT_SKILLS) {
      throw new Error(`这个仓库有 ${unique.length} 个技能，超过 ${MAX_PROJECT_SKILLS} 个上限`)
    }

    const repoInfo = await request(token, 'GET', '/repos/' + repo)
    const repoData = repoInfo.ok ? repoInfo.data : {}
    const installed = []
    for (const dir of unique) {
      const skill = await installSkillFromRepo(token, { repo, ref, dir })
      installed.push(skill)
    }

    const repoText = [
      repo,
      repoData.description || '',
      (repoData.topics || []).join(' '),
      repoData.topics ? '' : '',
      ...installed.map((skill) => `${skill.name} ${skill.description || ''}`),
    ].join(' ')
    const category = classifyProject(repoText)
    const keywords = collectKeywords(
      [
        (repoData.topics || []).join(' '),
        repoData.description || '',
        ...installed.map((skill) => `${skill.name} ${skill.description || ''}`),
      ],
      14,
    )
    const summaryZh =
      ZH_REPOS[repo] ||
      (hasCjk(repoData.description || '')
        ? firstSentence(repoData.description, 90)
        : `「${repo}」技能合集：${installed.map((skill) => skill.name).join('、')}，共 ${installed.length} 个技能，装好后 AI 可直接调用。`)

    const skills = []
    for (const skill of installed) {
      const dir = path.join(skillsRoot(), skill.name)
      const summary = skillSummaryZh(skill, category.id)
      const sub = subcategoryOf(`${skill.name} ${skill.description || ''}`, category.id)
      const ownWords = collectKeywords([`${skill.name} ${skill.description || ''}`], 8)
      const skillKeywords = Array.from(new Set([...ownWords, ...keywords.slice(0, 6)]))
      await enrichSkillFrontMatter(dir, { summaryZh: summary, keywords: skillKeywords })
      await writeSkillProjectMeta(dir, {
        project: repo,
        category: category.id,
        categoryLabel: category.label,
        subcategory: sub ? sub.id : null,
        subcategoryLabel: sub ? sub.label : null,
        summaryZh: summary,
        keywords: skillKeywords,
        installedAt: new Date().toISOString(),
      })
      skills.push({
        name: skill.name,
        dirInRepo: skill.dir === '' ? null : skill.dir,
        summaryZh: summary,
        keywords: skillKeywords,
        fileCount: skill.fileCount,
        subcategory: sub ? sub.id : '',
        subcategoryLabel: sub ? sub.label : '',
      })
    }

    const index = await loadProjectIndex()
    index.projects[repo] = {
      repo,
      ref,
      commitSha,
      category: category.id,
      categoryLabel: category.label,
      summaryZh,
      keywords,
      installedAt: new Date().toISOString(),
      skills,
    }
    await saveProjectIndex(index)
    return index.projects[repo]
  }

  async function listProjects() {
    const index = await loadProjectIndex()
    const projects = []
    for (const [repo, project] of Object.entries(index.projects)) {
      const skills = []
      for (const skill of project.skills || []) {
        const dir = path.join(skillsRoot(), skill.name)
        const exists = await fs.stat(dir).then((stat) => stat.isDirectory(), () => false)
        const disk = exists ? await readSkillDir(skill.name) : undefined
        const categoryId = project.category || 'other'
        const sub = subcategoryOf(`${skill.name} ${disk ? disk.description || '' : ''}`, categoryId)
        skills.push(
          Object.assign({}, skill, {
            installed: exists,
            summaryZh: disk ? skillSummaryZh({ ...disk, name: skill.name }, categoryId) : skill.summaryZh,
            subcategory: sub ? sub.id : skill.subcategory || '',
            subcategoryLabel: sub ? sub.label : skill.subcategoryLabel || '',
          }),
        )
      }
      projects.push(
        Object.assign({}, project, {
          skills,
          summaryZh: ZH_REPOS[repo] || project.summaryZh,
          categoryLabel: (CATEGORY_TABLE.find((entry) => entry.id === project.category) || CATEGORY_OTHER).label,
        }),
      )
    }
    projects.sort((a, b) => String(b.installedAt || '').localeCompare(String(a.installedAt || '')))
    const categories = []
    for (const project of projects) {
      const found = categories.find((entry) => entry.id === project.category)
      if (found) found.count += 1
      else categories.push({ id: project.category, label: project.categoryLabel, count: 1 })
    }
    return { projects, categories, root: skillsRoot() }
  }

  /**
   * Re-download installed skills whose upstream commit moved on, so the skill
   * catalogue follows the repository instead of freezing at install time.
   * Skills that belong to a known project are refreshed through the project
   * path, which also rewrites the Chinese summary and the AI keywords.
   */
  async function refreshInstalledSkills(token, options) {
    const opts = options && typeof options === 'object' ? options : {}
    const onlyRepo = String(opts.repo || '').trim()
    const result = { checked: 0, updated: [], errors: [] }
    if (!token) return result
    const skills = await listSkills()
    const byRepo = new Map()
    for (const skill of skills) {
      if (!skill.repo || !skill.commitSha) continue
      if (onlyRepo && skill.repo !== onlyRepo) continue
      if (!byRepo.has(skill.repo)) byRepo.set(skill.repo, [])
      byRepo.get(skill.repo).push(skill)
    }
    if (byRepo.size === 0) return result
    const index = await loadProjectIndex()
    for (const [repo, group] of byRepo) {
      result.checked += group.length
      try {
        const ref = group[0].ref || null
        let target = ref
        if (!target) {
          const info = await request(token, 'GET', '/repos/' + repo)
          target = info.ok ? info.data?.default_branch || 'main' : 'main'
        }
        const head = await request(token, 'GET', '/repos/' + repo + '/commits/' + encodeURIComponent(target))
        if (!head.ok) {
          result.errors.push({ repo, error: describe(head) })
          continue
        }
        const headSha = head.data?.sha || null
        if (!headSha) continue
        const stale = group.filter((skill) => skill.commitSha !== headSha)
        if (stale.length === 0) continue
        if (index.projects[repo]) {
          const project = await installProjectFromRepo(token, { repo, ref: target })
          for (const skill of project.skills || []) result.updated.push({ repo, name: skill.name })
        } else {
          for (const skill of stale) {
            const fresh = await installSkillFromRepo(token, { repo, ref: target, dir: skill.dirInRepo || '' })
            result.updated.push({ repo, name: fresh.name })
          }
        }
      } catch (error) {
        result.errors.push({ repo, error: String(error?.message || error) })
      }
    }
    return result
  }

  async function removeProject(repo) {
    const key = String(repo || '').trim()
    const index = await loadProjectIndex()
    const project = index.projects[key]
    if (!project) throw new Error('技能库里没有这个项目')
    for (const skill of project.skills || []) {
      await removeSkill(skill.name).catch(() => undefined)
    }
    delete index.projects[key]
    await saveProjectIndex(index)
    return { ok: true, repo: key, removed: (project.skills || []).length }
  }

  async function updateProjectMeta(repo, patch) {
    const key = String(repo || '').trim()
    const index = await loadProjectIndex()
    const project = index.projects[key]
    if (!project) throw new Error('技能库里没有这个项目')
    if (typeof patch.category === 'string') {
      const known = CATEGORY_TABLE.find((entry) => entry.id === patch.category) || CATEGORY_OTHER
      project.category = patch.category === 'other' ? 'other' : known.id
      project.categoryLabel = patch.category === 'other' ? CATEGORY_OTHER.label : known.label
    }
    if (typeof patch.summaryZh === 'string' && patch.summaryZh.trim()) {
      project.summaryZh = patch.summaryZh.trim().slice(0, 200)
    }
    if (Array.isArray(patch.keywords)) {
      project.keywords = patch.keywords.map((word) => String(word || '').trim()).filter(Boolean).slice(0, 16)
    }
    await saveProjectIndex(index)
    return project
  }

  /* --------------------------------------------------------------- clones */

  const CLONE_META = 'github-panel-clone.json'
  const GIT_TIMEOUT = 300000
  // A big repository can take a long time to download; what matters is that data
  // keeps flowing. Give clone/fetch 30 minutes, but stop after 3 silent minutes.
  const CLONE_TIMEOUT = 1800000
  const CLONE_STALL_MS = 180000
  const DEFAULT_AUTO_MINUTES = 15

  let cloneRootOverride = ''

  function cloneRoot() {
    if (cloneRootOverride) return cloneRootOverride
    return process.env.DSH_GITHUB_CLONE_DIR || path.join(dshHome(), 'github-clones')
  }

  function cloneConfigFile() {
    return path.join(dshHome(), 'plugin-data', 'github-panel-clones.json')
  }

  function cloneDir(repo) {
    return path.join(cloneRoot(), ...repo.split('/'))
  }

  /** Where every clone actually lives, including ones outside the default root. */
  function cloneIndexFile() {
    return path.join(dshHome(), 'plugin-data', 'github-panel-clone-index.json')
  }

  async function readCloneIndex() {
    try {
      const parsed = JSON.parse(await fs.readFile(cloneIndexFile(), 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  async function writeCloneIndex(next) {
    const file = cloneIndexFile()
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(next, null, 2), 'utf8')
  }

  async function rememberClone(repo, dir) {
    const index = await readCloneIndex()
    index[repo] = dir
    await writeCloneIndex(index)
    return index
  }

  async function forgetClone(repo) {
    const index = await readCloneIndex()
    if (Object.prototype.hasOwnProperty.call(index, repo)) {
      delete index[repo]
      await writeCloneIndex(index)
    }
  }

  /** Absolute directory of an existing clone: the recorded target wins over the default root. */
  async function resolveCloneDir(repo) {
    const index = await readCloneIndex()
    const mapped = index[repo]
    if (typeof mapped === 'string' && mapped.trim()) return path.resolve(mapped)
    return cloneDir(repo)
  }

  /**
   * Turn a requested target into the directory the repository itself occupies.
   * A path ending in the repository name is used as-is; anything else is treated
   * as the parent folder that receives a directory named after the repository.
   */
  function targetCloneDir(repo, requested) {
    const want = String(requested || '').trim()
    if (!want) return null
    const repoName = String(repo).split('/')[1] || ''
    const absolute = path.resolve(want)
    const sameName = path.basename(absolute).toLowerCase() === repoName.toLowerCase()
    return sameName ? absolute : path.join(absolute, repoName)
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

  // 网络抖动（连接被重置/超时）很常见，值得自动重试；授权与仓库不存在不值得重试。
  const TRANSIENT_GIT_FAILURE =
    /Connection was reset|Recv failure|Failed to connect|Could not resolve host|Connection timed out|Operation timed out|unexpected disconnect|the remote end hung up|RPC failed|TLS|SSL/i

  function friendlyGitError(text) {
    const raw = String(text || '').trim()
    const head = raw.length > 160 ? raw.slice(0, 160) + '…' : raw
    if (TRANSIENT_GIT_FAILURE.test(raw)) {
      return (
        '网络连接中断（不是仓库或令牌的问题）：与 GitHub 的连接被重置或超时，常见于网络波动、代理/VPN 抖动。' +
        '已自动重试过；稍后再点「同步」即可。如果经常失败，可以给 git 配代理，或设置环境变量 DSH_GITHUB_GIT_BASE=https://gh-proxy.com/https://github.com 走镜像加速。' +
        '｜原始信息：' +
        head
      )
    }
    if (/Authentication failed|Invalid username or password|terminal prompts disabled|Permission denied|could not read Username|access denied or repository|Repository not found/i.test(raw)) {
      return 'GitHub 拒绝访问：私有仓库需要令牌带 repo 权限，公开仓库请确认 owner/name 拼写。｜原始信息：' + head
    }
    return raw || 'git 命令失败'
  }

  /** Run a git command, retrying only when the failure looks like a network blip. */
  async function runGitWithRetry(args, options, slug, attempts = 3) {
    let result = null
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) {
        jobSet(slug, { label: '网络中断，正在重试', detail: '第 ' + (attempt + 1) + '/' + attempts + ' 次尝试' })
        await new Promise((resolve) => setTimeout(resolve, attempt * 2500))
      }
      result = await runGit(args, options)
      if (result.code === 0) return result
      const text = String(result.stderr || '') + '\n' + String(result.stdout || '')
      if (!TRANSIENT_GIT_FAILURE.test(text)) return result
    }
    return result
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
      owners = []
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
          lastCheck: meta.lastCheck || null,
          checkError: meta.checkError || null,
          lastError: meta.lastError || null,
          autoSync: meta.autoSync !== false,
        })
      }
    }
    const indexed = await readCloneIndex()
    const seen = new Set(out.map((item) => path.resolve(item.dir).toLowerCase()))
    for (const repo of Object.keys(indexed)) {
      if (!validRepo(repo)) continue
      const dir = path.resolve(indexed[repo])
      if (seen.has(dir.toLowerCase())) continue
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
        lastCheck: meta.lastCheck || null,
        checkError: meta.checkError || null,
        lastError: meta.lastError || null,
        autoSync: meta.autoSync !== false,
      })
    }
    out.sort((a, b) => String(a.repo).toLowerCase().localeCompare(String(b.repo).toLowerCase()))
    return out
  }

  /** Refresh remote-tracking refs for every clone; failures stay per clone. */
  async function fetchClones(clones) {
    const token = await readToken().catch(() => undefined)
    await Promise.all(
      clones.map((clone) =>
        runGitWithRetry(
          ['fetch', '--quiet', '--prune', '--tags', 'origin'],
          { cwd: clone.dir, token, timeout: 120000 },
          clone.repo,
          2,
        ).catch(() => null),
      ),
    )
  }

  async function cloneRepo(token, request_) {
    const repo = String(request_?.repo || '').trim()
    if (!validRepo(repo)) throw new Error('仓库要写成 owner/name 的形式')
    const ref = String(request_?.ref || '').trim()
    if (ref && !/^[A-Za-z0-9._\/-]+$/.test(ref)) throw new Error('分支名不合法')
    if (!(await gitInfo())) throw new Error('本机没有找到 git，请先安装 Git 并加入 PATH')
    const wantsExplicit = String(request_?.dir || '').trim().length > 0
    if (wantsExplicit && !path.isAbsolute(String(request_?.dir).trim())) {
      throw new Error('目标文件夹要写绝对路径，例如 D:\\projects')
    }
    const requested = targetCloneDir(repo, request_?.dir)
    const dir = requested || (await resolveCloneDir(repo))
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
    const result = await runGitWithRetry(args, {
      token,
      timeout: CLONE_TIMEOUT,
      stallMs: CLONE_STALL_MS,
      onOutput: progressReporter(repo, 'clone'),
    }, repo)
    if (result.code !== 0) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      const failure = friendlyGitError(gitFailure(result))
      jobFinish(repo, { percent: 0, step: 0, label: '失败', detail: '失败', error: '克隆失败：' + failure })
      throw new Error('克隆失败：' + failure)
    }
    const state = await cloneStatus(dir)
    jobFinish(repo, { percent: 100, step: 100, label: '完成', detail: '完成' })
    const meta = {
      repo,
      dir,
      url: cloneUrl(repo),
      ref: ref || state.branch || null,
      clonedAt: new Date().toISOString(),
      lastSync: new Date().toISOString(),
      lastError: null,
      autoSync: true,
    }
    await writeCloneMeta(dir, meta)
    await rememberClone(repo, dir)
    return { repo, dir, branch: state.branch, head: state.head, ref: meta.ref }
  }

  /**
   * Fetch the remote refs and refresh the ahead/behind numbers without touching
   * the working tree. This is what the auto-sync timer calls, so a scheduled run
   * never pulls, never pushes, and never changes a file on disk.
   */
  async function checkClone(token, repo) {
    const slug = String(repo || '').trim()
    if (!validRepo(slug)) throw new Error('仓库要写成 owner/name 的形式')
    const dir = await resolveCloneDir(slug)
    const meta = await readCloneMeta(dir)
    if (!meta) throw new Error(slug + ' 还没有绑定到本机文件夹')
    const fetch = await runGitWithRetry(
      ['fetch', '--quiet', '--prune', '--tags', 'origin'],
      { cwd: dir, token, timeout: 120000 },
      slug,
    )
    meta.lastCheck = new Date().toISOString()
    meta.checkError = fetch.code === 0 ? null : friendlyGitError(gitFailure(fetch))
    await writeCloneMeta(dir, meta)
    const state = await cloneStatus(dir)
    return {
      repo: slug,
      dir,
      behind: state.behind,
      ahead: state.ahead,
      dirty: state.dirty,
      lastCheck: meta.lastCheck,
      checkError: meta.checkError,
    }
  }

  /** The manual 检查 button runs exactly what the timer runs: fetch, then refresh. */
  async function checkAllClones() {
    const token = await readToken().catch(() => undefined)
    const clones = await listClones().catch(() => [])
    const results = []
    for (const clone of clones) {
      if (!clone.autoSync) continue
      try {
        results.push(await checkClone(token, clone.repo))
      } catch (error) {
        results.push({ repo: clone.repo, failed: true, error: String(error?.message || error) })
      }
    }
    return results
  }

  async function syncClone(token, repo) {
    const slug = String(repo || '').trim()
    if (!validRepo(slug)) throw new Error('仓库要写成 owner/name 的形式')
    const dir = await resolveCloneDir(slug)
    const meta = await readCloneMeta(dir)
    if (!meta) throw new Error(slug + ' 还没有克隆到本机')
    jobSet(slug, { phase: 'sync', percent: 0, step: 0, label: '连接 GitHub', detail: '连接 GitHub', done: false, error: null, startedAt: Date.now() })
    const fetch = await runGitWithRetry(
      ['fetch', '--progress', '--prune', '--tags', 'origin'],
      {
        cwd: dir,
        token,
        timeout: CLONE_TIMEOUT,
        stallMs: CLONE_STALL_MS,
        onOutput: progressReporter(slug, 'sync'),
      },
      slug,
    )
    if (fetch.code !== 0) {
      meta.lastError = friendlyGitError(gitFailure(fetch))
      meta.lastSync = new Date().toISOString()
      await writeCloneMeta(dir, meta)
      jobFinish(slug, { percent: 0, step: 0, label: '失败', detail: '失败', error: '拉取失败：' + meta.lastError })
      throw new Error('拉取失败：' + meta.lastError)
    }
    let before = await cloneStatus(dir)
    let action = 'up-to-date'
    let detail = ''
    const behind = before.behind || 0
    const ahead = before.ahead || 0
    if (before.upstream && behind > 0 && ahead > 0) {
      action = 'diverged'
      detail = '本地领先 ' + ahead + ' 个提交、落后 ' + behind + ' 个提交，需要手动合并'
      meta.lastError = detail
    } else if (before.upstream && behind > 0) {
      jobSet(slug, { phase: 'sync', percent: 40, step: 40, label: '拉取更新', detail: '拉取更新', done: false })
      const merge = await runGit(['merge', '--ff-only', '@{u}'], { cwd: dir, token })
      if (merge.code === 0) {
        action = 'pulled'
      } else {
        action = 'diverged'
        meta.lastError = gitFailure(merge)
      }
    } else if (before.upstream && ahead > 0) {
      jobSet(slug, { phase: 'sync', percent: 40, step: 40, label: '推送提交', detail: '推送提交', done: false })
      const push = await runGit(['push', 'origin', 'HEAD'], { cwd: dir, token, timeout: CLONE_TIMEOUT })
      if (push.code === 0) {
        action = 'pushed'
      } else {
        action = 'push-failed'
        meta.lastError = gitFailure(push)
      }
    }
    meta.lastSync = new Date().toISOString()
    meta.lastCheck = meta.lastSync
    if (action === 'pulled' || action === 'pushed' || action === 'up-to-date') {
      meta.lastError = null
      meta.checkError = null
    }
    await writeCloneMeta(dir, meta)
    const after = await cloneStatus(dir)
    jobFinish(slug, { percent: 100, step: 100, label: '完成', detail: '完成' })
    return {
      repo: slug,
      action,
      detail: detail || null,
      branch: after.branch,
      behind: after.behind,
      ahead: after.ahead,
      dirty: after.dirty,
      head: after.head,
      lastSync: meta.lastSync,
      error: meta.lastError || null,
    }
  }

  /** Compare a remote URL with owner/name regardless of protocol or trailing .git. */
  function remoteMatchesRepo(url, repo) {
    const text = String(url || '').trim()
    if (!text) return false
    const cleaned = text
      .replace(/^git@[^:]+:/i, '')
      .replace(/^ssh:\/\/git@[^/]+\//i, '')
      .replace(/^https?:\/\/[^/]+\//i, '')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '')
    return cleaned.toLowerCase() === String(repo).toLowerCase()
  }

  /**
   * Bind a repository to a local folder. An existing checkout must already point
   * at the repository; an empty or missing folder is cloned into. Binding is what
   * makes the folder show up in 我的仓库 with pull/push state.
   */
  async function bindRepo(token, request_) {
    const repo = String(request_?.repo || '').trim()
    if (!validRepo(repo)) throw new Error('仓库要写成 owner/name 的形式')
    const raw = String(request_?.dir || '').trim()
    if (!raw) throw new Error('先填一个要绑定的文件夹')
    if (!path.isAbsolute(raw)) throw new Error('文件夹要写绝对路径，例如 D:\\projects\\my-app')
    if (!(await gitInfo())) throw new Error('本机没有找到 git，请先安装 Git 并加入 PATH')
    const dir = path.resolve(raw)

    let exists = false
    try {
      await fs.access(path.join(dir, '.git'))
      exists = true
    } catch {
      exists = false
    }

    if (exists) {
      const remote = await runGit(['config', '--get', 'remote.origin.url'], { cwd: dir, timeout: 20000 })
      const url = remote.code === 0 ? String(remote.stdout).trim() : ''
      if (!remoteMatchesRepo(url, repo)) {
        throw new Error('这个文件夹已经是别的仓库：' + (url || '没有 origin 远端'))
      }
    } else {
      let entries = []
      try {
        entries = await fs.readdir(dir)
      } catch {
        entries = []
      }
      if (entries.length > 0) throw new Error('这个文件夹不是空的，换一个空文件夹或新建一个')
      const ref = String(request_?.ref || '').trim()
      if (ref && !/^[A-Za-z0-9._\/-]+$/.test(ref)) throw new Error('分支名不合法')
      await fs.mkdir(path.dirname(dir), { recursive: true })
      const args = ['clone', '--progress', '--single-branch']
      if (ref) args.push('--branch', ref)
      args.push(cloneUrl(repo), dir)
      jobSet(repo, { phase: 'clone', percent: 0, step: 0, label: '连接 GitHub', detail: '连接 GitHub', done: false, error: null, startedAt: Date.now() })
      const result = await runGitWithRetry(args, {
        token,
        timeout: CLONE_TIMEOUT,
        stallMs: CLONE_STALL_MS,
        onOutput: progressReporter(repo, 'clone'),
      }, repo)
      if (result.code !== 0) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
        const failure = friendlyGitError(gitFailure(result))
        jobFinish(repo, { percent: 0, step: 0, label: '失败', detail: '失败', error: '克隆失败：' + failure })
        throw new Error('克隆失败：' + failure)
      }
      jobFinish(repo, { percent: 100, step: 100, label: '完成', detail: '完成' })
    }

    const state = await cloneStatus(dir)
    const meta = {
      repo,
      dir,
      url: cloneUrl(repo),
      ref: state.branch || null,
      clonedAt: new Date().toISOString(),
      lastSync: new Date().toISOString(),
      lastError: null,
      autoSync: true,
      bound: true,
    }
    await writeCloneMeta(dir, meta)
    await rememberClone(repo, dir)
    return {
      repo,
      dir,
      branch: state.branch,
      head: state.head,
      behind: state.behind,
      ahead: state.ahead,
      dirty: state.dirty,
    }
  }

  /** Stop tracking a binding without touching the files on disk. */
  async function unbindRepo(repo) {
    const slug = String(repo || '').trim()
    if (!validRepo(slug)) throw new Error('仓库要写成 owner/name 的形式')
    const index = await readCloneIndex()
    const dir = typeof index[slug] === 'string' ? path.resolve(index[slug]) : await resolveCloneDir(slug)
    await forgetClone(slug)
    const meta = await readCloneMeta(dir).catch(() => null)
    if (meta) {
      meta.bound = false
      meta.autoSync = false
      await writeCloneMeta(dir, meta).catch(() => {})
    }
    return { ok: true, repo: slug, dir }
  }

  async function removeClone(repo) {
    const slug = String(repo || '').trim()
    if (!validRepo(slug)) throw new Error('仓库要写成 owner/name 的形式')
    const dir = await resolveCloneDir(slug)
    const root = path.resolve(cloneRoot())
    const index = await readCloneIndex()
    const recorded = typeof index[slug] === 'string' ? path.resolve(index[slug]) : null
    const underRoot = path.resolve(dir).startsWith(root + path.sep)
    if (!underRoot && recorded !== path.resolve(dir)) throw new Error('仓库路径不合法')
    await fs.rm(dir, { recursive: true, force: true })
    await forgetClone(slug)
    if (underRoot) {
      try {
        const ownerDir = path.dirname(dir)
        const rest = await fs.readdir(ownerDir)
        if (rest.length === 0) await fs.rmdir(ownerDir)
      } catch {
        /* leave the owner directory alone */
      }
    }
    return { ok: true, repo: slug, dir }
  }

  let autoConfig = { enabled: true, minutes: DEFAULT_AUTO_MINUTES }
  let autoTimer = null

  async function readAutoConfig() {
    try {
      const parsed = JSON.parse(await fs.readFile(cloneConfigFile(), 'utf8'))
      const minutes = Number(parsed?.minutes)
      cloneRootOverride = typeof parsed?.root === 'string' ? parsed.root.trim() : ''
      autoConfig = {
        enabled: parsed?.enabled !== false,
        minutes: Number.isFinite(minutes) && minutes >= 1 ? Math.min(720, Math.round(minutes)) : DEFAULT_AUTO_MINUTES,
        root: cloneRootOverride,
      }
    } catch {
      cloneRootOverride = ''
      autoConfig = { enabled: true, minutes: DEFAULT_AUTO_MINUTES, root: '' }
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
        await checkClone(token, clone.repo)
      } catch {
        /* per-clone failures stay in that clone's metadata */
      }
    }
    // Installed skills follow their repository too, whether or not it is cloned.
    await refreshInstalledSkills(token).catch(() => undefined)
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
      path: `${BASE}/skills/projects`,
      handler: async (req, res) => {
        if (!sameOrigin(req)) return json(res, 403, { error: '来源不受信任' })
        try {
          return json(res, 200, await listProjects())
        } catch (error) {
          return json(res, 500, { error: String(error?.message || error) })
        }
      },
    },
    {
      path: `${BASE}/skills/projects/install`,
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
          const project = await installProjectFromRepo(token, body && typeof body === 'object' ? body : {})
          return json(res, 200, { ok: true, project })
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message || error) })
        }
      },
    },
    {
      path: `${BASE}/skills/projects/remove`,
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
          return json(res, 200, await removeProject(body?.repo))
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message || error) })
        }
      },
    },
    {
      path: `${BASE}/skills/projects/meta`,
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
          const project = await updateProjectMeta(body?.repo, body || {})
          return json(res, 200, { ok: true, project })
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message || error) })
        }
      },
    },
    {
      path: `${BASE}/skills/update`,
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
          return json(res, 200, await refreshInstalledSkills(token, body && typeof body === 'object' ? body : {}))
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message || error) })
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
      path: `${BASE}/clones/check`,
      handler: async (req, res) => {
        if (!sameOrigin(req)) return json(res, 403, { error: '来源不受信任' })
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        let body = {}
        try {
          body = await readJsonBody(req)
        } catch (error) {
          return json(res, 400, { error: String(error.message || error) })
        }
        const token = await readToken().catch(() => undefined)
        try {
          if (body && typeof body.repo === 'string' && body.repo.trim()) {
            return json(res, 200, { ok: true, results: [await checkClone(token, body.repo)] })
          }
          return json(res, 200, { ok: true, results: await checkAllClones() })
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message || error) })
        }
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
      path: `${BASE}/clones/bind`,
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
          const bound = await bindRepo(token, body && typeof body === 'object' ? body : {})
          return json(res, 200, Object.assign({ ok: true }, bound))
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message || error) })
        }
      },
    },
    {
      path: `${BASE}/clones/unbind`,
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
          return json(res, 200, Object.assign({ ok: true }, await unbindRepo(body?.repo)))
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
        if (body?.root !== undefined) {
          const root = String(body.root || '').trim()
          if (root && !path.isAbsolute(root)) {
            return json(res, 400, { ok: false, error: '克隆目录要写绝对路径，例如 D:\\projects' })
          }
          next.root = root
        }
        if (body?.minutes !== undefined) {
          const minutes = Number(body.minutes)
          if (!Number.isFinite(minutes) || minutes < 1 || minutes > 720) {
            return json(res, 400, { ok: false, error: '同步间隔要在 1 到 720 分钟之间' })
          }
          next.minutes = Math.round(minutes)
        }
        try {
          const auto = await saveAutoConfig(next)
          cloneRootOverride = typeof auto.root === 'string' ? auto.root.trim() : ''
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
        name: 'github_skill_project',
        description:
          'Manage whole-repository skill projects. list returns installed projects with their category, ' +
          'Chinese summary and retrieval keywords; install installs every SKILL.md of a repository as one ' +
          'project (skills stay individually loadable) and writes Chinese summaries plus keywords into each ' +
          'SKILL.md; remove uninstalls the whole project.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'install', 'remove'], description: 'What to do' },
            repo: { type: 'string', description: 'owner/name (install and remove)' },
            ref: { type: 'string', description: 'Branch, tag, or commit; default branch when omitted' },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: output({ type: 'object' }),
        execute: async (args) => {
          const action = String(args?.action || 'list')
          if (action === 'list') return listProjects()
          if (action === 'remove') return removeProject(args?.repo)
          const token = await readToken()
          if (!token) throw new Error('GitHub 尚未连接：请先在 GitHub 面板里填入令牌')
          return installProjectFromRepo(token, { repo: args?.repo, ref: args?.ref })
        },
      },
      {
        name: 'github_clone_list',
        description:
          'List the repositories cloned to this machine, with the absolute directory of each clone, ' +
          'branch, commits behind the remote, and the last sync result.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: output({ type: 'array' }),
        execute: async () => listClones(),
      },
      {
        name: 'github_clone',
        description:
          'Clone a GitHub repository onto this machine. Pass dir to choose the folder: an absolute path ' +
          'naming the repository is used as-is, any other absolute path is treated as the parent folder and ' +
          'receives a directory named after the repository. Without dir the clone goes to ' +
          '~/.dsh/github-clones/owner/name. The connected token is used for private repositories, and the ' +
          'auto-sync timer keeps every clone up to date.',
        parameters: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'owner/name' },
            ref: { type: 'string', description: 'Branch or tag to check out; default branch when omitted' },
            dir: {
              type: 'string',
              description:
                'Absolute target folder, e.g. D:\\\\projects\\\\my-app or D:\\\\projects (the repository name ' +
                'is appended when the path does not already end with it)',
            },
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
          'Two-way sync for bound clones: pass one repo as owner/name, or all=true to sync every clone. ' +
          'Fetches first, then pulls with --ff-only when the remote is ahead, or pushes the local branch ' +
          'when it is ahead. Diverged clones are reported instead of being reset.',
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
      {
        name: 'github_repo_bind',
        description:
          'Bind a GitHub repository to a local folder so the folder shows up under 我的仓库 and stays in ' +
          'sync. The folder may be empty, missing (it is cloned into), or an existing checkout of the same ' +
          'repository. After binding, github_clone_sync pulls when the remote is ahead and pushes when the ' +
          'local branch is ahead.',
        parameters: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'owner/name' },
            dir: { type: 'string', description: 'Absolute folder to bind, e.g. D:\\\\projects\\\\my-app' },
            ref: { type: 'string', description: 'Branch to check out when cloning; default branch when omitted' },
          },
          required: ['repo', 'dir'],
          additionalProperties: false,
        },
        output: output({ type: 'object' }),
        execute: async (args) => {
          const token = await readToken().catch(() => undefined)
          return bindRepo(token, args || {})
        },
      },
      {
        name: 'github_repo_unbind',
        description: 'Stop syncing a bound repository. The files on disk are left untouched.',
        parameters: {
          type: 'object',
          properties: { repo: { type: 'string', description: 'owner/name' } },
          required: ['repo'],
          additionalProperties: false,
        },
        output: output({ type: 'object' }),
        execute: async (args) => unbindRepo(args?.repo),
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
