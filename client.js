window.__ModuleLoader__.load({
  id: 'dsh-github-panel',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect } = React
    const useSyncExternalStore = React.useSyncExternalStore

    const ROUTE = '/github-panel'

    /* ------------------------------------------------------------------ store */

    let state = {
      booted: false,
      connected: false,
      profile: null,
      tokenDraft: '',
      tokenError: null,
      connecting: false,
      view: 'repos',
      repos: null,
      reposLoading: false,
      reposError: null,
      repoQuery: '',
      repo: null,
      tab: 'issues',
      items: {},
      filters: { issues: 'open', pulls: 'open' },
      detail: null,
      issueForm: { open: false, title: '', body: '', busy: false, error: null },
      commentDraft: '',
      actionBusy: false,
      actionError: null,
      codePath: '',
      codeEntries: null,
      codeFile: null,
      codeLoading: false,
      codeError: null,
      codeEmpty: false,
      stars: null,
      starsLoading: false,
      starsError: null,
      starsQuery: '',
      social: null,
      socialLoading: false,
      socialError: null,
      activity: null,
      activityKind: 'mine',
      activityLoading: false,
      activityError: null,
      skills: null,
      skillsRoot: '',
      skillsLoading: false,
      skillsError: null,
      skillForm: { repo: '', dir: '', ref: '', busy: false, error: null },
      clones: null,
      cloneRoot: '',
      cloneGit: null,
      cloneAuto: { enabled: true, minutes: 15 },
      cloneTab: 'clones',
      clonesLoading: false,
      clonesError: null,
      cloneBusy: {},
      cloneProgress: {},
      cloneNotice: null,
      cloneSearch: '',
      cloneResults: null,
      cloneSearchLoading: false,
      cloneSearchError: null,
      cloneRef: '',
      notifications: null,
      notifLoading: false,
      notifError: null,
      inviteOpen: false,
      inviteDraft: '',
      inviteError: null,
      guest: null,
      notice: null,
    }

    const listeners = new Set()

    function subscribe(listener) {
      listeners.add(listener)
      return function unsubscribe() {
        listeners.delete(listener)
      }
    }

    function snapshot() {
      return state
    }

    function set(patch) {
      state = Object.assign({}, state, typeof patch === 'function' ? patch(state) : patch)
      for (const listener of listeners) listener()
    }

    function useStore() {
      if (typeof useSyncExternalStore === 'function') return useSyncExternalStore(subscribe, snapshot, snapshot)
      const [, bump] = React.useState(0)
      useEffect(function () {
        const listener = function () {
          bump(function (value) {
            return value + 1
          })
        }
        return subscribe(listener)
      }, [])
      return state
    }

    /* -------------------------------------------------------------------- net */

    function messageOf(error) {
      if (!error) return '未知错误'
      if (typeof error === 'string') return error
      return error.message || String(error)
    }

    async function fetchJson(url, init) {
      let response
      try {
        response = await fetch(url, init)
      } catch (error) {
        throw new Error('无法连接本地 GitHub 服务：' + messageOf(error))
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) throw new Error((payload && payload.error) || 'HTTP ' + response.status)
      return payload || {}
    }

    function readBody(data) {
      return data && typeof data === 'object' ? data : {}
    }

    async function apiCall(method, path, body) {
      const payload = await fetchJson(ROUTE + '/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: method, path: path, body: body }),
      })
      if (payload.ok === false) throw new Error(payload.error || 'GitHub 返回 ' + payload.status)
      return payload.data
    }

    /* ------------------------------------------------------------------ utils */

    function timeAgo(iso) {
      if (!iso) return ''
      const stamp = Date.parse(iso)
      if (Number.isNaN(stamp)) return ''
      const diff = Math.max(0, Date.now() - stamp)
      const minutes = Math.floor(diff / 60000)
      if (minutes < 1) return '刚刚'
      if (minutes < 60) return minutes + ' 分钟前'
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return hours + ' 小时前'
      const days = Math.floor(hours / 24)
      if (days < 30) return days + ' 天前'
      return new Date(stamp).toLocaleDateString('zh-CN')
    }

    function decodeBase64(text) {
      const clean = String(text).replace(/\s+/g, '')
      const binary = window.atob(clean)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      try {
        return new TextDecoder('utf-8').decode(bytes)
      } catch {
        return binary
      }
    }

    function branchOf() {
      const repo = state.repo
      return (repo && repo.data && repo.data.default_branch) || 'main'
    }

    /* ---------------------------------------------------------------- actions */

    async function boot() {
      try {
        const payload = await fetchJson(ROUTE + '/state')
        set({
          booted: true,
          connected: !!payload.connected,
          profile: payload.profile || null,
          tokenError: payload.error || null,
        })
        if (payload.connected) {
          loadRepos()
          loadNotifications()
          loadSkills()
        }
      } catch (error) {
        set({ booted: true, tokenError: messageOf(error) })
      }
    }

    async function connect(token) {
      const value = String(token || '').trim()
      if (!value) return
      set({ connecting: true, tokenError: null })
      try {
        const payload = await fetchJson(ROUTE + '/token', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: value }),
        })
        set({
          connecting: false,
          connected: true,
          profile: payload.profile || null,
          tokenError: null,
          tokenDraft: '',
          repos: null,
          repo: null,
          detail: null,
          items: {},
          notifications: null,
          view: 'repos',
        })
        loadRepos()
        loadNotifications()
        loadSkills()
      } catch (error) {
        set({ connecting: false, tokenError: messageOf(error) })
      }
    }

    async function disconnect() {
      let confirmed = true
      try {
        confirmed = window.confirm('断开 GitHub 连接？令牌会从本机凭据存储中删除。')
      } catch {
        confirmed = true
      }
      if (!confirmed) return
      try {
        await fetchJson(ROUTE + '/token', { method: 'DELETE' })
      } catch {
        /* the UI still resets below */
      }
      set({
        connected: false,
        profile: null,
        repos: null,
        reposError: null,
        repo: null,
        detail: null,
        items: {},
        notifications: null,
        view: 'repos',
        tokenError: null,
      })
    }

    /* 访客模式：邀请码只解锁公开数据的只读视图，不需要、也不会拿到账号令牌。 */
    const GUEST_LOGIN = 'gpta76'
    const INVITE_HASH = '851189b97a5c759064f13cb2c8723016f0d06702131a6cd466d44894e2612bbf'

    async function inviteDigest(text) {
      try {
        const bytes = new TextEncoder().encode(String(text).trim().toLowerCase())
        const buffer = await window.crypto.subtle.digest('SHA-256', bytes)
        return Array.prototype.map
          .call(new Uint8Array(buffer), function (byte) {
            return byte.toString(16).padStart(2, '0')
          })
          .join('')
      } catch {
        return ''
      }
    }

    async function submitInvite() {
      const value = String(state.inviteDraft || '').trim()
      if (!value) return
      const digest = await inviteDigest(value)
      if (!digest) {
        set({ inviteError: '当前环境无法校验邀请码' })
        return
      }
      if (digest !== INVITE_HASH) {
        set({ inviteError: '邀请码不正确' })
        return
      }
      set({
        inviteOpen: false,
        inviteDraft: '',
        inviteError: null,
        guest: { login: GUEST_LOGIN, profile: null, repos: null, starred: null, events: null, orgs: null, loading: true, error: null, tab: 'repos' },
      })
      loadGuest()
    }

    async function loadGuest(quiet) {
      const login = (state.guest && state.guest.login) || GUEST_LOGIN
      if (!quiet) set({ guest: Object.assign({}, state.guest, { loading: true, error: null }) })
      try {
        const results = await Promise.all([
          apiCall('GET', '/users/' + login),
          apiCall('GET', '/users/' + login + '/repos?per_page=100&sort=updated'),
          apiCall('GET', '/users/' + login + '/starred?per_page=100&sort=created&direction=desc'),
          apiCall('GET', '/users/' + login + '/events/public?per_page=50'),
          apiCall('GET', '/users/' + login + '/orgs?per_page=100'),
        ])
        set({
          guest: {
            login: login,
            profile: results[0] || null,
            repos: Array.isArray(results[1]) ? results[1] : [],
            starred: Array.isArray(results[2]) ? results[2] : [],
            events: Array.isArray(results[3]) ? results[3] : [],
            orgs: Array.isArray(results[4]) ? results[4] : [],
            loading: false,
            error: null,
            tab: (state.guest && state.guest.tab) || 'repos',
          },
        })
      } catch (error) {
        set({ guest: Object.assign({}, state.guest, { loading: false, error: messageOf(error) }) })
      }
    }

    function setGuestTab(tab) {
      set({ guest: Object.assign({}, state.guest, { tab: tab }) })
    }

    function openInvite() {
      set({ inviteOpen: !state.inviteOpen, inviteError: null })
    }

    function exitGuest() {
      set({ guest: null, inviteOpen: false, inviteDraft: '', inviteError: null })
    }

    async function loadRepos(quiet) {      if (!quiet || !state.repos) set({ reposLoading: true, reposError: null })
      try {
        const rows = await apiCall('GET', '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member')
        set({ reposLoading: false, reposError: null, repos: Array.isArray(rows) ? rows : [] })
      } catch (error) {
        set({ reposLoading: false, reposError: messageOf(error) })
      }
    }

    async function selectRepo(fullName) {
      const parts = String(fullName).split('/')
      set({
        repo: { full: fullName, owner: parts[0], name: parts[1], data: null },
        tab: 'issues',
        detail: null,
        items: {},
        codePath: '',
        codeEntries: null,
        codeFile: null,
        codeError: null,
        codeEmpty: false,
        actionError: null,
      })
      loadTab('issues')
      try {
        const data = await apiCall('GET', '/repos/' + fullName)
        set(function (current) {
          return { repo: Object.assign({}, current.repo, { data: data }) }
        })
      } catch {
        /* the lists still work with the default branch */
      }
    }

    async function loadTab(tab) {
      const repo = state.repo
      if (!repo) return
      set(function (current) {
        const entry = Object.assign({ list: null, error: null }, current.items[tab], { loading: true, error: null })
        return { items: Object.assign({}, current.items, { [tab]: entry }) }
      })
      try {
        let list = []
        if (tab === 'issues') {
          const rows = await apiCall('GET', '/repos/' + repo.full + '/issues?state=' + state.filters.issues + '&per_page=50&sort=updated')
          list = (Array.isArray(rows) ? rows : []).filter(function (row) {
            return !row.pull_request
          })
        } else if (tab === 'pulls') {
          const rows = await apiCall('GET', '/repos/' + repo.full + '/pulls?state=' + state.filters.pulls + '&per_page=50&sort=updated')
          list = Array.isArray(rows) ? rows : []
        } else if (tab === 'commits') {
          const rows = await apiCall('GET', '/repos/' + repo.full + '/commits?per_page=30')
          list = Array.isArray(rows) ? rows : []
        }
        set(function (current) {
          return { items: Object.assign({}, current.items, { [tab]: { loading: false, error: null, list: list } }) }
        })
      } catch (error) {
        set(function (current) {
          const entry = Object.assign({ list: null }, current.items[tab], { loading: false, error: messageOf(error) })
          return { items: Object.assign({}, current.items, { [tab]: entry }) }
        })
      }
    }

    async function loadCode(dirPath) {
      const repo = state.repo
      if (!repo) return
      const target = String(dirPath || '')
      set({ codeLoading: true, codeError: null, codePath: target, codeFile: null })
      try {
        const entries = await apiCall('GET', '/repos/' + repo.full + '/contents/' + encodeURI(target) + '?ref=' + encodeURIComponent(branchOf()))
        set({ codeLoading: false, codeEmpty: false, codeEntries: Array.isArray(entries) ? entries : [] })
      } catch (error) {
        const text = messageOf(error)
        if (/empty/i.test(text)) {
          set({ codeLoading: false, codeEntries: [], codeError: null, codeEmpty: true })
          return
        }
        set({ codeLoading: false, codeEntries: [], codeError: text, codeEmpty: false })
      }
    }

    async function openFile(filePath) {
      const repo = state.repo
      if (!repo) return
      set({ codeLoading: true, codeError: null })
      try {
        const data = readBody(await apiCall('GET', '/repos/' + repo.full + '/contents/' + encodeURI(filePath) + '?ref=' + encodeURIComponent(branchOf())))
        const size = typeof data.size === 'number' ? data.size : 0
        let text
        if (size > 300000) text = '（文件共 ' + size + ' 字节，过大，未在面板内预览）'
        else if (typeof data.content === 'string' && data.content) text = decodeBase64(data.content)
        else text = '（没有可显示的文本内容）'
        set({ codeLoading: false, codeFile: { path: data.path || filePath, name: data.name || filePath, text: text, size: size } })
      } catch (error) {
        set({ codeLoading: false, codeError: messageOf(error) })
      }
    }

    async function loadNotifications(quiet) {
      if (!quiet || !state.notifications) set({ notifLoading: true, notifError: null })
      try {
        const rows = await apiCall('GET', '/notifications?all=false&per_page=50')
        set({ notifLoading: false, notifError: null, notifications: Array.isArray(rows) ? rows : [] })
      } catch (error) {
        set({ notifLoading: false, notifError: messageOf(error), notifications: state.notifications || [] })
      }
    }

    async function markAllRead() {
      set({ notifLoading: true, notifError: null })
      try {
        await apiCall('PUT', '/notifications', {})
        set({ notifLoading: false, notice: '已把全部通知标为已读' })
        loadNotifications()
      } catch (error) {
        set({ notifLoading: false, notifError: messageOf(error) })
      }
    }

    async function openThread(thread) {
      const url = (thread && thread.subject && thread.subject.url) || ''
      const match = /\/repos\/([^/]+)\/([^/]+)\/(issues|pulls)\/(\d+)$/.exec(url)
      try {
        await apiCall('PATCH', '/notifications/threads/' + thread.id, {})
      } catch {
        /* marking read is best effort */
      }
      if (!match) {
        set({ notice: '该通知类型暂不支持在面板内打开' })
        loadNotifications()
        return
      }
      const full = match[1] + '/' + match[2]
      const tab = match[3] === 'pulls' ? 'pulls' : 'issues'
      set({
        view: 'repos',
        repo: { full: full, owner: match[1], name: match[2], data: null },
        tab: tab,
        detail: null,
        items: {},
        codePath: '',
        codeEntries: null,
        codeFile: null,
      })
      try {
        const data = await apiCall('GET', '/repos/' + full)
        set(function (current) {
          return { repo: Object.assign({}, current.repo, { data: data }) }
        })
      } catch {
        /* fall back to the default branch */
      }
      loadTab(tab)
      openDetail(tab === 'pulls' ? 'pr' : 'issue', Number(match[4]))
      loadNotifications()
    }

    async function openDetail(kind, number) {
      const repo = state.repo
      if (!repo) return
      set({ detail: { kind: kind, number: number, loading: true }, commentDraft: '', actionError: null })
      const base = kind === 'pr' ? '/repos/' + repo.full + '/pulls/' + number : '/repos/' + repo.full + '/issues/' + number
      try {
        const data = await apiCall('GET', base)
        let comments = []
        try {
          const rows = await apiCall('GET', '/repos/' + repo.full + '/issues/' + number + '/comments?per_page=100')
          comments = Array.isArray(rows) ? rows : []
        } catch {
          comments = []
        }
        set({ detail: { kind: kind, number: number, loading: false, data: data, comments: comments } })
      } catch (error) {
        set({ detail: { kind: kind, number: number, loading: false, error: messageOf(error) } })
      }
    }

    function closeDetail() {
      set({ detail: null, commentDraft: '', actionError: null })
    }

    async function submitComment() {
      const detail = state.detail
      const repo = state.repo
      const draft = state.commentDraft.trim()
      if (!detail || !repo || !draft) return
      set({ actionBusy: true, actionError: null })
      try {
        await apiCall('POST', '/repos/' + repo.full + '/issues/' + detail.number + '/comments', { body: draft })
        set({ actionBusy: false })
        await openDetail(detail.kind, detail.number)
        loadTab(state.tab)
      } catch (error) {
        set({ actionBusy: false, actionError: messageOf(error) })
      }
    }

    async function toggleState() {
      const detail = state.detail
      const repo = state.repo
      if (!detail || !repo || !detail.data) return
      const next = detail.data.state === 'open' ? 'closed' : 'open'
      const base = detail.kind === 'pr' ? '/repos/' + repo.full + '/pulls/' + detail.number : '/repos/' + repo.full + '/issues/' + detail.number
      set({ actionBusy: true, actionError: null })
      try {
        await apiCall('PATCH', base, { state: next })
        set({ actionBusy: false, notice: next === 'closed' ? '已关闭' : '已重新打开' })
        await openDetail(detail.kind, detail.number)
        loadTab(state.tab)
      } catch (error) {
        set({ actionBusy: false, actionError: messageOf(error) })
      }
    }

    async function mergePull() {
      const detail = state.detail
      const repo = state.repo
      if (!detail || !repo) return
      set({ actionBusy: true, actionError: null })
      try {
        await apiCall('PUT', '/repos/' + repo.full + '/pulls/' + detail.number + '/merge', { merge_method: 'merge' })
        set({ actionBusy: false, notice: '已合并' })
        await openDetail(detail.kind, detail.number)
        loadTab(state.tab)
      } catch (error) {
        set({ actionBusy: false, actionError: messageOf(error) })
      }
    }

    async function createIssue() {
      const repo = state.repo
      const form = state.issueForm
      const title = form.title.trim()
      if (!repo || !title) return
      set({ issueForm: Object.assign({}, form, { busy: true, error: null }) })
      try {
        const created = readBody(await apiCall('POST', '/repos/' + repo.full + '/issues', { title: title, body: form.body }))
        set({
          issueForm: { open: false, title: '', body: '', busy: false, error: null },
          notice: '已创建议题 #' + created.number,
        })
        loadTab('issues')
        if (created.number) openDetail('issue', created.number)
      } catch (error) {
        set(function (current) {
          return { issueForm: Object.assign({}, current.issueForm, { busy: false, error: messageOf(error) }) }
        })
      }
    }

    /* --------------------------------------------------------- account sync */

    function openRepoFromCard(full) {
      set({ view: 'repos' })
      selectRepo(full)
    }

    async function loadStars(quiet) {
      if (!quiet || !state.stars) set({ starsLoading: true, starsError: null })
      try {
        const rows = await apiCall('GET', '/user/starred?per_page=100&sort=created&direction=desc')
        set({ starsLoading: false, starsError: null, stars: Array.isArray(rows) ? rows : [] })
      } catch (error) {
        set({ starsLoading: false, starsError: messageOf(error) })
      }
    }

    async function toggleStar(full, starred) {
      if (!full) return
      set({ actionError: null })
      try {
        await apiCall(starred ? 'DELETE' : 'PUT', '/user/starred/' + full)
        set({ notice: starred ? '已取消星标：' + full : '已加星标：' + full })
        if (state.stars) loadStars(true)
      } catch (error) {
        set({ actionError: messageOf(error) })
      }
    }

    async function loadSocial(quiet) {
      if (!quiet || !state.social) set({ socialLoading: true, socialError: null })
      try {
        const payload = await Promise.all([
          apiCall('GET', '/user/following?per_page=100&sort=created'),
          apiCall('GET', '/user/followers?per_page=100'),
          apiCall('GET', '/user/orgs?per_page=100'),
        ])
        set({
          socialLoading: false,
          socialError: null,
          social: {
            following: Array.isArray(payload[0]) ? payload[0] : [],
            followers: Array.isArray(payload[1]) ? payload[1] : [],
            orgs: Array.isArray(payload[2]) ? payload[2] : [],
          },
        })
      } catch (error) {
        set({ socialLoading: false, socialError: messageOf(error) })
      }
    }

    async function loadActivity(quiet) {
      const kind = state.activityKind || 'mine'
      if (!quiet || !state.activity) set({ activityLoading: true, activityError: null })
      try {
        const login = (state.profile && state.profile.login) || ''
        const target = kind === 'received' ? '/user/received_events?per_page=50' : '/users/' + login + '/events/public?per_page=50'
        const rows = await apiCall('GET', target)
        set({ activityLoading: false, activityError: null, activity: Array.isArray(rows) ? rows : [] })
      } catch (error) {
        set({ activityLoading: false, activityError: messageOf(error) })
      }
    }

    async function loadSkills(quiet) {
      if (!quiet || !state.skills) set({ skillsLoading: true, skillsError: null })
      try {
        const payload = await fetchJson(ROUTE + '/skills')
        set({
          skillsLoading: false,
          skillsError: null,
          skills: Array.isArray(payload.skills) ? payload.skills : [],
          skillsRoot: payload.root || '',
        })
      } catch (error) {
        set({ skillsLoading: false, skillsError: messageOf(error) })
      }
    }

    async function installSkill() {
      const form = state.skillForm
      const repo = String(form.repo || '').trim()
      if (!repo) return
      set({ skillForm: Object.assign({}, form, { busy: true, error: null }), actionError: null })
      try {
        const payload = await fetchJson(ROUTE + '/skills/install', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            repo: repo,
            dir: String(form.dir || '').trim(),
            ref: String(form.ref || '').trim(),
          }),
        })
        const skill = payload.skill || {}
        set({
          skillForm: { repo: '', dir: '', ref: '', busy: false, error: null },
          notice: '已安装技能 ' + (skill.name || repo) + (skill.fileCount ? '（' + skill.fileCount + ' 个文件）' : ''),
        })
        loadSkills()
      } catch (error) {
        set({ skillForm: Object.assign({}, state.skillForm, { busy: false, error: messageOf(error) }) })
      }
    }

    async function removeSkill(name) {
      let confirmed = true
      try {
        confirmed = window.confirm('卸载技能 ' + name + '？会删除本机 ~/.dsh/skills 下的这个目录。')
      } catch {
        confirmed = true
      }
      if (!confirmed) return
      try {
        await fetchJson(ROUTE + '/skills/remove', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: name }),
        })
        set({ notice: '已卸载技能 ' + name })
        loadSkills()
      } catch (error) {
        set({ skillsError: messageOf(error) })
      }
    }

    /* ----------------------------------------------------------------- clones */

    async function loadClones(quiet, fetchRemote) {
      if (!quiet || !state.clones) set({ clonesLoading: true, clonesError: null })
      try {
        const payload = await fetchJson(ROUTE + '/clones' + (fetchRemote ? '?fetch=1' : ''))
        set({
          clonesLoading: false,
          clonesError: null,
          clones: Array.isArray(payload.clones) ? payload.clones : [],
          cloneRoot: payload.root || '',
          cloneGit: payload.git || null,
          cloneAuto: payload.auto || state.cloneAuto,
        })
      } catch (error) {
        set({ clonesLoading: false, clonesError: messageOf(error) })
      }
    }

    function markCloneBusy(repo, value) {
      const next = Object.assign({}, state.cloneBusy)
      if (value) next[repo] = value
      else delete next[repo]
      set({ cloneBusy: next })
      if (value) startCloneProgress()
      else if (Object.keys(next).length === 0) stopCloneProgress()
    }

    let cloneProgressTimer = null

    async function pollCloneProgress() {
      try {
        const payload = await fetchJson(ROUTE + '/clones/progress')
        const map = {}
        const jobs = payload && Array.isArray(payload.jobs) ? payload.jobs : []
        jobs.forEach((job) => {
          if (!job || !job.repo) return
          map[job.repo] = {
            percent: Math.max(0, Math.min(100, Number(job.percent) || 0)),
            step: Number(job.step) || 0,
            label: job.label || '',
            detail: job.detail || '',
            done: !!job.done,
            error: job.error || null,
          }
        })
        set({ cloneProgress: map })
      } catch {
        /* progress is cosmetic; a failed poll must not disturb the clone */
      }
    }

    function startCloneProgress() {
      pollCloneProgress()
      if (cloneProgressTimer) return
      cloneProgressTimer = setInterval(pollCloneProgress, 500)
    }

    function stopCloneProgress() {
      if (!cloneProgressTimer) return
      clearInterval(cloneProgressTimer)
      cloneProgressTimer = null
      setTimeout(pollCloneProgress, 300)
    }

    function progressLabel(repo) {
      const job = state.cloneProgress[repo]
      if (!job) return null
      if (job.done) return '完成'
      if (job.percent > 0) return job.percent + '%'
      return job.detail || null
    }

    // A clone runs on the host, not here, so the bar is drawn from the polled job
    // record. Before git prints its first percentage the fill animates instead of
    // sitting at a fake 0%.
    function progressBar(repo, options) {
      const job = state.cloneProgress[repo]
      const opts = options || {}
      const percent = job ? Math.max(0, Math.min(100, Math.round(job.percent || 0))) : 0
      const done = !!(job && job.done)
      const stage = !job ? '准备中…' : done ? '完成' : job.detail || '准备中…'
      return h(
        'div',
        { className: 'ghp-progress' + (opts.inline ? ' ghp-progress-inline' : ''), key: 'progress-' + repo },
        h(
          'div',
          { className: 'ghp-progress-head' },
          opts.title ? h('span', { className: 'ghp-progress-name' }, opts.title) : null,
          h('span', { className: 'ghp-progress-pct' }, percent ? percent + '%' : done ? '完成' : '进行中'),
        ),
        h(
          'div',
          {
            className: 'ghp-progress-track',
            role: 'progressbar',
            'aria-valuenow': percent,
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-label': '克隆进度',
          },
          h('div', {
            className: 'ghp-progress-fill' + (percent ? '' : ' is-indeterminate'),
            style: { width: percent ? percent + '%' : '40%' },
          }),
        ),
        h('div', { className: 'ghp-progress-stage' }, stage),
      )
    }

    async function cloneRepo(repo, ref) {
      const target = String(repo || '').trim()
      if (!target || state.cloneBusy[target]) return
      markCloneBusy(target, 'cloning')
      set({ cloneNotice: null, actionError: null })
      try {
        const payload = await fetchJson(ROUTE + '/clones/clone', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repo: target, ref: String(ref || state.cloneRef || '').trim() }),
        })
        set({
          notice: '已克隆 ' + target + (payload.branch ? '（' + payload.branch + '）' : ''),
          cloneTab: 'clones',
        })
        await loadClones(true)
      } catch (error) {
        set({ cloneNotice: { kind: 'error', text: messageOf(error) } })
      }
      markCloneBusy(target, null)
    }

    async function syncClone(repo) {
      if (!repo || state.cloneBusy[repo]) return
      markCloneBusy(repo, 'syncing')
      set({ cloneNotice: null })
      try {
        const payload = await fetchJson(ROUTE + '/clones/sync', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repo: repo }),
        })
        const labels = {
          updated: '已更新到最新提交',
          'up-to-date': '已经是最新版本',
          dirty: '有未提交的改动，先提交再同步',
          diverged: '本地和远端分叉了，需要手动处理',
        }
        set({
          cloneNotice: {
            kind: payload.action === 'updated' || payload.action === 'up-to-date' ? 'ok' : 'error',
            text: repo + '：' + (labels[payload.action] || payload.action || '同步完成') + (payload.error ? '（' + payload.error + '）' : ''),
          },
        })
        await loadClones(true)
      } catch (error) {
        set({ cloneNotice: { kind: 'error', text: messageOf(error) } })
      }
      markCloneBusy(repo, null)
    }

    async function syncAllClones() {
      set({ clonesLoading: true, cloneNotice: null, cloneBusy: Object.assign({}, state.cloneBusy, { '*': 'syncing' }) })
      startCloneProgress()
      try {
        const payload = await fetchJson(ROUTE + '/clones/sync', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ all: true }),
        })
        const rows = Array.isArray(payload) ? payload : []
        const updated = rows.filter(function (row) {
          return row.action === 'updated'
        }).length
        const failed = rows.filter(function (row) {
          return row.action === 'failed' || row.action === 'diverged' || row.action === 'dirty'
        }).length
        set({
          cloneBusy: {},
          cloneNotice: {
            kind: failed ? 'error' : 'ok',
            text: '同步了 ' + rows.length + ' 个仓库：' + updated + ' 个更新' + (failed ? '，' + failed + ' 个需要手动处理' : ''),
          },
        })
        await loadClones(true)
        stopCloneProgress()
      } catch (error) {
        stopCloneProgress()
        set({ cloneBusy: {}, clonesLoading: false, cloneNotice: { kind: 'error', text: messageOf(error) } })
      }
    }

    async function removeClone(repo) {
      let confirmed = true
      try {
        confirmed = window.confirm('删除本机克隆 ' + repo + '？只删本地目录，不影响 GitHub 上的仓库。')
      } catch {
        confirmed = true
      }
      if (!confirmed) return
      try {
        await fetchJson(ROUTE + '/clones/remove', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repo: repo }),
        })
        set({ notice: '已删除本机克隆 ' + repo, cloneNotice: null })
        await loadClones(true)
      } catch (error) {
        set({ cloneNotice: { kind: 'error', text: messageOf(error) } })
      }
    }

    async function setCloneAuto(patch) {
      const next = Object.assign({}, state.cloneAuto, patch)
      set({ cloneAuto: next })
      try {
        const payload = await fetchJson(ROUTE + '/clones/auto', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: next.enabled, minutes: next.minutes }),
        })
        set({ cloneAuto: payload.auto || next })
      } catch (error) {
        set({ cloneNotice: { kind: 'error', text: messageOf(error) } })
        loadClones(true)
      }
    }

    async function searchRepos(quiet) {
      const query = String(state.cloneSearch || '').trim()
      if (!query) {
        set({ cloneResults: null, cloneSearchError: null, cloneSearchLoading: false })
        return
      }
      if (!quiet || !state.cloneResults) set({ cloneSearchLoading: true, cloneSearchError: null })
      try {
        const data = await apiCall(
          'GET',
          '/search/repositories?q=' + encodeURIComponent(query) + '&sort=stars&order=desc&per_page=30',
        )
        set({ cloneSearchLoading: false, cloneSearchError: null, cloneResults: readBody(data).items || [] })
      } catch (error) {
        set({ cloneSearchLoading: false, cloneSearchError: messageOf(error) })
      }
    }

    function ensureView(value) {
      if (value === 'stars' && !state.stars) loadStars()
      if (value === 'social' && !state.social) loadSocial()
      if (value === 'activity' && !state.activity) loadActivity()
      if (value === 'skills' && !state.skills) loadSkills()
      if (value === 'clones' && !state.clones) loadClones(false, true)
      if (value === 'notifications' && !state.notifications) loadNotifications()
    }

    function refreshView(quiet) {
      const view = state.view
      if (view === 'stars') loadStars(quiet)
      else if (view === 'social') loadSocial(quiet)
      else if (view === 'activity') loadActivity(quiet)
      else if (view === 'skills') loadSkills(quiet)
      else if (view === 'clones') loadClones(quiet, true)
      else if (view === 'notifications') loadNotifications(quiet)
      else loadRepos(quiet)
    }

    /* -------------------------------------------------------------------- ui */

    function GitHubIcon(props) {
      const size = props.size || 24
      const stroke = props.active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)'
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M7.2 5.6v12.8',
          fill: 'none',
          stroke: stroke,
          strokeWidth: 1.9,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M7.2 12.4h4.3a4.4 4.4 0 0 0 4.4-4.4V6.6',
          fill: 'none',
          stroke: stroke,
          strokeWidth: 1.9,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 7.2, cy: 5.6, r: 2.4, fill: stroke }),
        h('circle', { cx: 7.2, cy: 18.4, r: 2.4, fill: stroke }),
        h('circle', { cx: 15.9, cy: 5.6, r: 2.4, fill: stroke }),
      )
    }

    function Button(props) {
      const className =
        'ghp-btn' +
        (props.kind ? ' ghp-btn-' + props.kind : '') +
        (props.small ? ' ghp-btn-sm' : '')
      return h(
        'button',
        {
          type: 'button',
          className: className,
          onClick: props.onClick,
          disabled: !!props.disabled,
          title: props.title,
        },
        props.children,
      )
    }

    function Spinner() {
      return h('span', { className: 'ghp-spinner' })
    }

    function renderRepoList(current) {
      const query = current.repoQuery.trim().toLowerCase()
      const repos = (current.repos || []).filter(function (repo) {
        if (!query) return true
        if (String(repo.full_name || '').toLowerCase().indexOf(query) >= 0) return true
        return String(repo.description || '').toLowerCase().indexOf(query) >= 0
      })
      return h(
        'div',
        { className: 'ghp-side' },
        h(
          'div',
          { className: 'ghp-side-head' },
          h('input', {
            className: 'ghp-input ghp-search',
            placeholder: '搜索仓库…',
            value: current.repoQuery,
            onChange: function (event) {
              set({ repoQuery: event.target.value })
            },
          }),
          h(
            Button,
            { small: true, onClick: loadRepos, title: '刷新仓库列表' },
            current.reposLoading ? '刷新中' : '刷新',
          ),
        ),
        current.reposError ? h('div', { className: 'ghp-error ghp-side-error' }, current.reposError) : null,
        h(
          'div',
          { className: 'ghp-list' },
          !current.repos && current.reposLoading ? h('div', { className: 'ghp-center' }, h(Spinner)) : null,
          current.repos && repos.length === 0 ? h('div', { className: 'ghp-empty' }, '没有匹配的仓库') : null,
          repos.map(function (repo) {
            const active = current.repo && current.repo.full === repo.full_name
            return h(
              'button',
              {
                type: 'button',
                key: repo.id,
                className: 'ghp-repo' + (active ? ' is-active' : ''),
                onClick: function () {
                  selectRepo(repo.full_name)
                },
              },
              h(
                'div',
                { className: 'ghp-repo-line' },
                h('span', { className: 'ghp-repo-name' }, repo.name),
                repo.private ? h('span', { className: 'ghp-badge' }, '私有') : null,
              ),
              h('div', { className: 'ghp-repo-owner' }, repo.owner ? repo.owner.login : ''),
              repo.description ? h('div', { className: 'ghp-repo-desc' }, repo.description) : null,
            )
          }),
        ),
      )
    }

    function renderDetail(current) {
      const detail = current.detail
      const backBar = h(
        'div',
        { className: 'ghp-toolbar' },
        h(Button, { small: true, onClick: closeDetail }, '← 返回列表'),
        h(
          Button,
          {
            small: true,
            onClick: function () {
              openDetail(detail.kind, detail.number)
            },
          },
          '刷新',
        ),
      )
      if (detail.loading) {
        return h('div', { className: 'ghp-detail' }, backBar, h('div', { className: 'ghp-center' }, h(Spinner)))
      }
      if (detail.error) {
        return h('div', { className: 'ghp-detail' }, backBar, h('div', { className: 'ghp-error' }, detail.error))
      }
      const data = detail.data || {}
      const isPr = detail.kind === 'pr'
      const stateLabel = data.merged ? '已合并' : data.state === 'open' ? '打开' : '已关闭'
      return h(
        'div',
        { className: 'ghp-detail' },
        backBar,
        h(
          'div',
          { className: 'ghp-detail-head' },
          h('h3', { className: 'ghp-h3' }, data.title || '（无标题）'),
          h(
            'div',
            { className: 'ghp-item-meta' },
            h('span', { className: 'ghp-state ghp-state-' + (data.state || 'open') }, stateLabel),
            h('span', null, '#' + detail.number),
            h('span', null, (data.user && data.user.login) || ''),
            h('span', null, timeAgo(data.created_at)),
            isPr && data.head ? h('span', null, String(data.head.ref) + ' → ' + String(data.base ? data.base.ref : '')) : null,
          ),
        ),
        h(
          'div',
          { className: 'ghp-actions' },
          h(
            Button,
            { small: true, onClick: toggleState, disabled: current.actionBusy },
            data.state === 'open' ? '关闭' : '重新打开',
          ),
          isPr
            ? h(
                Button,
                {
                  small: true,
                  kind: 'primary',
                  onClick: mergePull,
                  disabled: current.actionBusy || data.merged || data.state === 'closed',
                },
                data.merged ? '已合并' : '合并',
              )
            : null,
        ),
        current.actionError ? h('div', { className: 'ghp-error' }, current.actionError) : null,
        h(
          'div',
          { className: 'ghp-body-text' },
          data.body ? data.body : h('span', { className: 'ghp-muted' }, '（没有正文）'),
        ),
        h('div', { className: 'ghp-sep' }),
        (detail.comments || []).length === 0
          ? h('div', { className: 'ghp-muted ghp-small' }, '还没有评论')
          : null,
        (detail.comments || []).map(function (comment) {
          return h(
            'div',
            { key: comment.id, className: 'ghp-comment' },
            h(
              'div',
              { className: 'ghp-item-meta' },
              h('span', { className: 'ghp-strong' }, (comment.user && comment.user.login) || '未知'),
              h('span', null, timeAgo(comment.created_at)),
            ),
            h('div', { className: 'ghp-body-text' }, comment.body),
          )
        }),
        h(
          'div',
          { className: 'ghp-form' },
          h('textarea', {
            className: 'ghp-textarea',
            rows: 3,
            placeholder: '写一条评论…',
            value: current.commentDraft,
            onChange: function (event) {
              set({ commentDraft: event.target.value })
            },
          }),
          h(
            'div',
            { className: 'ghp-row' },
            h(
              Button,
              {
                small: true,
                kind: 'primary',
                disabled: current.actionBusy || !current.commentDraft.trim(),
                onClick: submitComment,
              },
              current.actionBusy ? '发送中…' : '发送评论',
            ),
          ),
        ),
      )
    }

    function renderList(current) {
      if (current.detail) return renderDetail(current)
      const item = current.items[current.tab] || {}
      const showFilter = current.tab === 'issues' || current.tab === 'pulls'
      const filterRow = showFilter
        ? h(
            'div',
            { className: 'ghp-toolbar' },
            h(
              'div',
              { className: 'ghp-seg' },
              ['open', 'closed'].map(function (value) {
                const active = (current.filters[current.tab] || 'open') === value
                return h(
                  'button',
                  {
                    type: 'button',
                    key: value,
                    className: 'ghp-seg-btn' + (active ? ' is-active' : ''),
                    onClick: function () {
                      set(function (snap) {
                        const filters = Object.assign({}, snap.filters)
                        filters[current.tab] = value
                        return { filters: filters }
                      })
                      loadTab(current.tab)
                    },
                  },
                  value === 'open' ? '打开' : '已关闭',
                )
              }),
            ),
            current.tab === 'issues'
              ? h(
                  Button,
                  {
                    small: true,
                    kind: 'primary',
                    onClick: function () {
                      set({
                        issueForm: {
                          open: !current.issueForm.open,
                          title: '',
                          body: '',
                          busy: false,
                          error: null,
                        },
                      })
                    },
                  },
                  current.issueForm.open ? '取消' : '新建议题',
                )
              : null,
          )
        : null

      const issueForm =
        current.tab === 'issues' && current.issueForm.open
          ? h(
              'div',
              { className: 'ghp-form' },
              h('input', {
                className: 'ghp-input',
                placeholder: '标题',
                value: current.issueForm.title,
                onChange: function (event) {
                  set(function (snap) {
                    return { issueForm: Object.assign({}, snap.issueForm, { title: event.target.value }) }
                  })
                },
              }),
              h('textarea', {
                className: 'ghp-textarea',
                rows: 4,
                placeholder: '描述（可选，支持 Markdown）',
                value: current.issueForm.body,
                onChange: function (event) {
                  set(function (snap) {
                    return { issueForm: Object.assign({}, snap.issueForm, { body: event.target.value }) }
                  })
                },
              }),
              current.issueForm.error ? h('div', { className: 'ghp-error' }, current.issueForm.error) : null,
              h(
                'div',
                { className: 'ghp-row' },
                h(
                  Button,
                  {
                    small: true,
                    kind: 'primary',
                    disabled: current.issueForm.busy || !current.issueForm.title.trim(),
                    onClick: createIssue,
                  },
                  current.issueForm.busy ? '提交中…' : '创建议题',
                ),
                h(
                  Button,
                  {
                    small: true,
                    onClick: function () {
                      set({ issueForm: { open: false, title: '', body: '', busy: false, error: null } })
                    },
                  },
                  '取消',
                ),
              ),
            )
          : null

      const rows = (item.list || []).map(function (row) {
        if (current.tab === 'commits') {
          const commit = row.commit || {}
          const author = commit.author || {}
          return h(
            'div',
            { key: row.sha, className: 'ghp-item ghp-item-static' },
            h(
              'div',
              { className: 'ghp-item-line' },
              h('span', { className: 'ghp-item-num' }, String(row.sha || '').slice(0, 7)),
              h('span', { className: 'ghp-item-title' }, String(commit.message || '').split('\n')[0]),
            ),
            h(
              'div',
              { className: 'ghp-item-meta' },
              h('span', null, author.name || (row.author && row.author.login) || '未知'),
              h('span', null, timeAgo(author.date)),
            ),
          )
        }
        const isPr = current.tab === 'pulls'
        return h(
          'button',
          {
            type: 'button',
            key: row.number,
            className: 'ghp-item',
            onClick: function () {
              openDetail(isPr ? 'pr' : 'issue', row.number)
            },
          },
          h(
            'div',
            { className: 'ghp-item-line' },
            h('span', { className: 'ghp-item-num' }, '#' + row.number),
            h('span', { className: 'ghp-item-title' }, row.title),
            row.state ? h('span', { className: 'ghp-state ghp-state-' + row.state }, row.state === 'open' ? '打开' : '已关闭') : null,
            isPr && row.draft ? h('span', { className: 'ghp-badge' }, '草稿') : null,
          ),
          h(
            'div',
            { className: 'ghp-item-meta' },
            h('span', null, (row.user && row.user.login) || '未知作者'),
            h('span', null, timeAgo(row.updated_at || row.created_at)),
            row.comments ? h('span', null, row.comments + ' 条评论') : null,
            (row.labels || []).slice(0, 4).map(function (label) {
              return h('span', { key: label.id || label.name, className: 'ghp-chip' }, label.name)
            }),
          ),
        )
      })

      return h(
        'div',
        { className: 'ghp-list-pane' },
        filterRow,
        issueForm,
        item.error ? h('div', { className: 'ghp-error' }, item.error) : null,
        item.loading && !(item.list || []).length ? h('div', { className: 'ghp-center' }, h(Spinner)) : null,
        !item.loading && (item.list || []).length === 0 && !item.error
          ? h('div', { className: 'ghp-empty' }, current.tab === 'issues' ? '没有议题' : current.tab === 'pulls' ? '没有拉取请求' : '没有提交记录')
          : null,
        rows,
      )
    }

    function renderCode(current) {
      const dirPath = current.codePath || ''
      if (current.codeFile) {
        return h(
          'div',
          { className: 'ghp-code' },
          h(
            'div',
            { className: 'ghp-toolbar' },
            h(
              Button,
              {
                small: true,
                onClick: function () {
                  set({ codeFile: null })
                  loadCode(dirPath)
                },
              },
              '← 返回目录',
            ),
            h('span', { className: 'ghp-muted ghp-small' }, current.codeFile.path + ' · ' + current.codeFile.size + ' 字节'),
          ),
          h('pre', { className: 'ghp-pre' }, current.codeFile.text),
        )
      }
      const parts = dirPath ? dirPath.split('/') : []
      const crumbs = [
        h(
          'button',
          {
            type: 'button',
            key: 'root',
            className: 'ghp-crumb',
            onClick: function () {
              loadCode('')
            },
          },
          '根目录',
        ),
      ]
      parts.forEach(function (part, index) {
        const target = parts.slice(0, index + 1).join('/')
        crumbs.push(h('span', { key: target + '-sep', className: 'ghp-crumb-sep' }, '/'))
        crumbs.push(
          h(
            'button',
            {
              type: 'button',
              key: target,
              className: 'ghp-crumb',
              onClick: function () {
                loadCode(target)
              },
            },
            part,
          ),
        )
      })
      const entries = current.codeEntries || []
      return h(
        'div',
        { className: 'ghp-code' },
        h(
          'div',
          { className: 'ghp-toolbar' },
          h(
            Button,
            {
              small: true,
              onClick: function () {
                loadCode(dirPath)
              },
            },
            current.codeLoading ? '读取中' : '刷新',
          ),
          h('div', { className: 'ghp-crumbs' }, crumbs),
        ),
        current.codeError ? h('div', { className: 'ghp-error' }, current.codeError) : null,
        current.codeLoading && !entries.length ? h('div', { className: 'ghp-center' }, h(Spinner)) : null,
        !current.codeLoading && !current.codeError && entries.length === 0
          ? h(
              'div',
              { className: 'ghp-empty' },
              current.codeEmpty
                ? '这个仓库还没有任何提交（空仓库）。在 GitHub 上推送第一个提交后，这里就会显示文件。'
                : '这个目录是空的',
            )
          : null,
        entries.map(function (entry) {
          const isDir = entry.type === 'dir'
          return h(
            'button',
            {
              type: 'button',
              key: entry.path,
              className: 'ghp-entry',
              onClick: function () {
                if (isDir) loadCode(entry.path)
                else openFile(entry.path)
              },
            },
            h('span', { className: 'ghp-entry-icon' }, isDir ? '▸' : '·'),
            h('span', { className: 'ghp-entry-name' }, entry.name),
            h('span', { className: 'ghp-entry-size' }, isDir ? '目录' : entry.size + ' B'),
          )
        }),
      )
    }

    function renderRepoMain(current) {
      if (!current.repo) {
        return h(
          'div',
          { className: 'ghp-center ghp-hint' },
          h('div', null, h('div', { className: 'ghp-hint-title' }, '选择一个仓库'), h('div', { className: 'ghp-muted ghp-small' }, '左侧列出了你有权限访问的仓库')),
        )
      }
      const repo = current.repo
      const data = repo.data
      const tabs = [
        ['issues', '议题'],
        ['pulls', '拉取请求'],
        ['commits', '提交'],
        ['code', '代码'],
      ]
      return h(
        'div',
        { className: 'ghp-main-inner' },
        h(
          'div',
          { className: 'ghp-repo-head' },
          h(
            'div',
            { className: 'ghp-repo-head-text' },
            h('div', { className: 'ghp-repo-title' }, repo.full),
            h(
              'div',
              { className: 'ghp-muted ghp-small' },
              data
                ? [data.description || '（无描述）', data.private ? '· 私有' : '· 公开', data.default_branch ? '· 默认分支 ' + data.default_branch : ''].join(' ')
                : '正在读取仓库信息…',
            ),
          ),
          h(
            'div',
            { className: 'ghp-row' },
            cloneButton(repo.full, { kind: 'primary' }),
            h(
              Button,
              {
                small: true,
                onClick: function () {
                  if (current.tab === 'code') loadCode(current.codePath || '')
                  else loadTab(current.tab)
                },
              },
              '刷新',
            ),
          ),
        ),
        h(
          'div',
          { className: 'ghp-tabs' },
          tabs.map(function (pair) {
            return h(
              'button',
              {
                type: 'button',
                key: pair[0],
                className: 'ghp-tab' + (current.tab === pair[0] ? ' is-active' : ''),
                onClick: function () {
                  set({ tab: pair[0], detail: null, actionError: null })
                  if (pair[0] === 'code') loadCode(current.codePath || '')
                  else loadTab(pair[0])
                },
              },
              pair[1],
            )
          }),
        ),
        h('div', { className: 'ghp-content' }, current.tab === 'code' ? renderCode(current) : renderList(current)),
      )
    }

    function renderNotifications(current) {
      const rows = current.notifications || []
      return h(
        'div',
        { className: 'ghp-notif' },
        h(
          'div',
          { className: 'ghp-notif-head' },
          h(
            'div',
            null,
            h('h3', { className: 'ghp-h3' }, '通知'),
            h('p', { className: 'ghp-muted ghp-small' }, '未读的议题、拉取请求与讨论，与 GitHub 网页端保持同步。'),
          ),
          h(
            'div',
            { className: 'ghp-row' },
            h(Button, { small: true, onClick: loadNotifications }, current.notifLoading ? '刷新中' : '刷新'),
            h(Button, { small: true, onClick: markAllRead }, '全部标为已读'),
          ),
        ),
        current.notifError ? h('div', { className: 'ghp-error' }, current.notifError) : null,
        current.notifLoading && rows.length === 0 ? h('div', { className: 'ghp-center' }, h(Spinner)) : null,
        !current.notifLoading && rows.length === 0 && !current.notifError
          ? h('div', { className: 'ghp-empty' }, '没有未读通知')
          : null,
        rows.map(function (item) {
          return h(
            'button',
            {
              type: 'button',
              key: item.id,
              className: 'ghp-item',
              onClick: function () {
                openThread(item)
              },
            },
            h(
              'div',
              { className: 'ghp-item-line' },
              item.unread ? h('span', { className: 'ghp-dot' }) : null,
              h('span', { className: 'ghp-item-title' }, (item.subject && item.subject.title) || '（无标题）'),
            ),
            h(
              'div',
              { className: 'ghp-item-meta' },
              h('span', null, item.repository ? item.repository.full_name : ''),
              h('span', null, item.reason || ''),
              h('span', null, timeAgo(item.updated_at)),
            ),
          )
        }),
      )
    }

    /* --------------------------------------------------- account-wide views */

    const EVENT_LABELS = {
      PushEvent: '推送了提交',
      CreateEvent: '创建了',
      DeleteEvent: '删除了',
      IssuesEvent: '更新了议题',
      IssueCommentEvent: '评论了议题',
      PullRequestEvent: '更新了拉取请求',
      PullRequestReviewEvent: '审查了拉取请求',
      PullRequestReviewCommentEvent: '在审查中留言',
      CommitCommentEvent: '评论了提交',
      ForkEvent: '复刻了仓库',
      WatchEvent: '星标了仓库',
      ReleaseEvent: '发布了版本',
      PublicEvent: '公开了仓库',
      MemberEvent: '变更了成员',
      GollumEvent: '更新了 Wiki',
      SponsorshipEvent: '发起或收到赞助',
    }

    function eventText(event) {
      const payload = event.payload || {}
      const action = payload.action ? '（' + payload.action + '）' : ''
      if (event.type === 'PushEvent') {
        const count = payload.size || (payload.commits ? payload.commits.length : 0)
        return '推送了 ' + (count || '若干') + ' 个提交'
      }
      if (event.type === 'CreateEvent') {
        const kind = payload.ref_type === 'branch' ? '分支' : payload.ref_type === 'tag' ? '标签' : '仓库'
        return '创建了' + kind + (payload.ref ? ' ' + payload.ref : '')
      }
      if (event.type === 'IssuesEvent' || event.type === 'PullRequestEvent') {
        const number = payload.issue
          ? payload.issue.number
          : payload.pull_request
            ? payload.pull_request.number
            : null
        return (EVENT_LABELS[event.type] || event.type) + (number ? ' #' + number : '') + action
      }
      return (EVENT_LABELS[event.type] || event.type) + action
    }

    function pageFrame(options) {
      return h(
        'div',
        { className: 'ghp-page' },
        h(
          'div',
          { className: 'ghp-page-head' },
          h(
            'div',
            { className: 'ghp-page-head-text' },
            h('h2', { className: 'ghp-page-title' }, options.title),
            options.subtitle ? h('p', { className: 'ghp-muted ghp-small' }, options.subtitle) : null,
          ),
          options.toolbar ? h('div', { className: 'ghp-toolbar' }, options.toolbar) : null,
        ),
        options.error ? h('div', { className: 'ghp-error' }, options.error) : null,
        options.loading
          ? h(
              'div',
              { className: 'ghp-center' },
              h(Spinner),
              h('span', { className: 'ghp-muted ghp-small' }, options.loadingText || '正在读取…'),
            )
          : null,
        options.empty ? h('div', { className: 'ghp-empty' }, options.empty) : null,
        options.body || null,
      )
    }

    function userChips(rows, emptyText) {
      const list = Array.isArray(rows) ? rows : []
      if (!list.length) return h('div', { className: 'ghp-empty' }, emptyText)
      return h(
        'div',
        { className: 'ghp-chips' },
        list.map(function (row) {
          return h(
            'div',
            { className: 'ghp-chip-user', key: row.login, title: row.login },
            row.avatar_url ? h('img', { className: 'ghp-chip-avatar', src: row.avatar_url, alt: '' }) : null,
            h('span', null, row.login),
          )
        }),
      )
    }

    function renderStars(current) {
      const rows = current.stars || []
      const query = String(current.starsQuery || '').trim().toLowerCase()
      const list = query
        ? rows.filter(function (row) {
            return (
              String(row.full_name || '').toLowerCase().indexOf(query) >= 0 ||
              String(row.description || '').toLowerCase().indexOf(query) >= 0
            )
          })
        : rows
      const toolbar = [
        h('input', {
          key: 'query',
          className: 'ghp-input ghp-search-input',
          value: current.starsQuery,
          placeholder: '搜索星标…',
          onChange: function (event) {
            set({ starsQuery: event.target.value })
          },
        }),
        h(
          Button,
          {
            key: 'reload',
            small: true,
            onClick: function () {
              loadStars()
            },
          },
          '刷新',
        ),
      ]
      const body = h(
        'div',
        { className: 'ghp-card-grid' },
        list.map(function (row) {
          return h(
            'div',
            { className: 'ghp-tile', key: row.full_name },
            h('div', { className: 'ghp-tile-title' }, row.full_name),
            row.description ? h('div', { className: 'ghp-tile-desc' }, row.description) : null,
            h(
              'div',
              { className: 'ghp-tile-meta' },
              row.language ? h('span', null, row.language) : null,
              h('span', null, '★ ' + (row.stargazers_count || 0)),
              h('span', null, timeAgo(row.updated_at)),
              h('div', { className: 'ghp-toolbar-spacer' }),
              cloneButton(row.full_name),
              h(
                Button,
                {
                  small: true,
                  onClick: function () {
                    openRepoFromCard(row.full_name)
                  },
                },
                '打开',
              ),
              h(
                Button,
                {
                  small: true,
                  onClick: function () {
                    toggleStar(row.full_name, true)
                  },
                },
                '取消星标',
              ),
            ),
          )
        }),
      )
      return pageFrame({
        title: '星标仓库',
        subtitle: rows.length
          ? '共 ' + rows.length + ' 个星标，来自你的 GitHub 账号，打开面板即读取最新数据'
          : '这里会同步你在 GitHub 上点过星标的仓库',
        toolbar: toolbar,
        error: current.starsError,
        loading: current.starsLoading && !rows.length,
        loadingText: '正在读取星标…',
        empty:
          !current.starsLoading && !current.starsError && !rows.length
            ? '还没有星标仓库。在 GitHub 上给仓库点星后，这里会自动出现。'
            : query && !list.length
              ? '没有匹配「' + current.starsQuery + '」的星标。'
              : null,
        body: list.length ? body : null,
      })
    }

    function renderSocial(current) {
      const social = current.social || { following: [], followers: [], orgs: [] }
      const body = h(
        'div',
        { className: 'ghp-social' },
        h(
          'div',
          { className: 'ghp-section' },
          h(
            'div',
            { className: 'ghp-section-head' },
            h('h3', { className: 'ghp-h3' }, '我关注的'),
            h('span', { className: 'ghp-muted ghp-small' }, social.following.length + ' 人'),
          ),
          userChips(social.following, '还没有关注任何人'),
        ),
        h(
          'div',
          { className: 'ghp-section' },
          h(
            'div',
            { className: 'ghp-section-head' },
            h('h3', { className: 'ghp-h3' }, '关注我的'),
            h('span', { className: 'ghp-muted ghp-small' }, social.followers.length + ' 人'),
          ),
          userChips(social.followers, '还没有人关注你'),
        ),
        h(
          'div',
          { className: 'ghp-section' },
          h(
            'div',
            { className: 'ghp-section-head' },
            h('h3', { className: 'ghp-h3' }, '所属组织'),
            h('span', { className: 'ghp-muted ghp-small' }, social.orgs.length + ' 个'),
          ),
          userChips(social.orgs, '没有加入任何组织'),
        ),
      )
      return pageFrame({
        title: '关注与组织',
        subtitle: '你的关注关系，和 GitHub 网页端保持一致',
        toolbar: [
          h(
            Button,
            {
              key: 'reload',
              small: true,
              onClick: function () {
                loadSocial()
              },
            },
            '刷新',
          ),
        ],
        error: current.socialError,
        loading: current.socialLoading && !current.social,
        loadingText: '正在读取关注关系…',
        body: body,
      })
    }

    function renderActivity(current) {
      const rows = current.activity || []
      const kind = current.activityKind || 'mine'
      const body = h(
        'div',
        { className: 'ghp-events' },
        rows.map(function (event) {
          return h(
            'div',
            { className: 'ghp-event', key: event.id },
            h('span', { className: 'ghp-dot' }),
            h(
              'div',
              { className: 'ghp-event-body' },
              h(
                'div',
                null,
                (event.actor && event.actor.login ? event.actor.login + ' ' : '') + eventText(event),
              ),
              h(
                'div',
                { className: 'ghp-muted ghp-small' },
                (event.repo && event.repo.name ? event.repo.name : '') +
                  (event.type === 'PushEvent' && event.payload && event.payload.ref ? ' · ' + event.payload.ref : ''),
              ),
            ),
            h('span', { className: 'ghp-event-time' }, timeAgo(event.created_at)),
          )
        }),
      )
      const toolbar = [
        h(
          'div',
          { className: 'ghp-seg', key: 'kind' },
          [
            ['mine', '我的动态'],
            ['received', '收到的动态'],
          ].map(function (pair) {
            return h(
              'button',
              {
                key: pair[0],
                type: 'button',
                className: 'ghp-seg-btn' + (kind === pair[0] ? ' is-active' : ''),
                onClick: function () {
                  set({ activityKind: pair[0], activity: null })
                  loadActivity()
                },
              },
              pair[1],
            )
          }),
        ),
        h(
          Button,
          {
            key: 'reload',
            small: true,
            onClick: function () {
              loadActivity()
            },
          },
          '刷新',
        ),
      ]
      return pageFrame({
        title: '动态',
        subtitle: kind === 'received' ? '你关注的仓库里发生的事' : '你在 GitHub 上的公开活动',
        toolbar: toolbar,
        error: current.activityError,
        loading: current.activityLoading && !rows.length,
        loadingText: '正在读取动态…',
        empty:
          !current.activityLoading && !current.activityError && !rows.length
            ? '暂时没有新的动态。'
            : null,
        body: rows.length ? body : null,
      })
    }

    function setSkillField(field) {
      return function (event) {
        const value = event.target.value
        set(function (current) {
          const form = Object.assign({}, current.skillForm, { error: null })
          form[field] = value
          return { skillForm: form }
        })
      }
    }

    function renderSkills(current) {
      const skills = current.skills || []
      const form = current.skillForm || { repo: '', dir: '', ref: '', busy: false, error: null }
      const installCard = h(
        'div',
        { className: 'ghp-card ghp-skill-install' },
        h(
          'div',
          { className: 'ghp-skill-head' },
          h('strong', null, '从 GitHub 安装技能'),
          h(
            'span',
            { className: 'ghp-muted ghp-small' },
            '把仓库里的 SKILL.md 目录装进本机技能库，AI 在新会话里就能直接使用',
          ),
        ),
        h(
          'div',
          { className: 'ghp-form-row' },
          h(
            'label',
            { className: 'ghp-field' },
            h('span', { className: 'ghp-field-label' }, '仓库（owner/name）'),
            h('input', {
              className: 'ghp-input',
              value: form.repo,
              placeholder: 'anthropics/skills',
              spellCheck: false,
              onChange: setSkillField('repo'),
              onKeyDown: function (event) {
                if (event.key === 'Enter') installSkill()
              },
            }),
          ),
          h(
            'label',
            { className: 'ghp-field' },
            h('span', { className: 'ghp-field-label' }, '技能目录（留空 = 仓库根目录）'),
            h('input', {
              className: 'ghp-input',
              value: form.dir,
              placeholder: 'skills/pdf',
              spellCheck: false,
              onChange: setSkillField('dir'),
            }),
          ),
          h(
            'label',
            { className: 'ghp-field ghp-field-narrow' },
            h('span', { className: 'ghp-field-label' }, '分支 / 标签'),
            h('input', {
              className: 'ghp-input',
              value: form.ref,
              placeholder: 'main',
              spellCheck: false,
              onChange: setSkillField('ref'),
            }),
          ),
          h(
            Button,
            {
              kind: 'primary',
              onClick: installSkill,
              disabled: form.busy || !String(form.repo || '').trim(),
            },
            form.busy ? '安装中…' : '安装',
          ),
        ),
        form.error ? h('div', { className: 'ghp-error' }, form.error) : null,
        h(
          'p',
          { className: 'ghp-muted ghp-small' },
          '目录里必须有 SKILL.md（带 name / description 前置信息）。安装时按仓库最新提交逐个下载文件，内容和 GitHub 保持同步。',
        ),
      )
      const list = skills.map(function (skill) {
        return h(
          'div',
          { className: 'ghp-skill', key: skill.dir },
          h(
            'div',
            { className: 'ghp-skill-head' },
            h('span', { className: 'ghp-skill-name' }, skill.name),
            h('span', { className: 'ghp-badge' }, skill.source === 'github' ? 'GitHub' : '本地'),
            skill.fileCount ? h('span', { className: 'ghp-muted ghp-small' }, skill.fileCount + ' 个文件') : null,
            h('div', { className: 'ghp-toolbar-spacer' }),
            h(
              Button,
              {
                small: true,
                onClick: function () {
                  removeSkill(skill.dir)
                },
              },
              '卸载',
            ),
          ),
          skill.description ? h('div', { className: 'ghp-skill-desc' }, skill.description) : null,
          h(
            'div',
            { className: 'ghp-muted ghp-small ghp-mono' },
            (skill.repo ? skill.repo + (skill.dirInRepo ? '/' + skill.dirInRepo : '') + ' · ' : '') +
              (skill.installedAt ? timeAgo(skill.installedAt) + '安装' : '本地 · 更新于 ' + timeAgo(skill.updatedAt)),
          ),
        )
      })
      const body = h(
        'div',
        { className: 'ghp-skills' },
        installCard,
        h(
          'div',
          { className: 'ghp-section-head' },
          h('h3', { className: 'ghp-h3' }, '已安装的技能'),
          h('span', { className: 'ghp-muted ghp-small' }, skills.length + ' 个'),
        ),
        current.skillsRoot ? h('div', { className: 'ghp-muted ghp-small ghp-mono' }, current.skillsRoot) : null,
        skills.length === 0
          ? h('div', { className: 'ghp-empty' }, '还没有安装任何技能。上面填仓库和目录就能安装。')
          : h('div', { className: 'ghp-skill-list' }, list),
        h(
          'p',
          { className: 'ghp-muted ghp-small' },
          '安装完成后，新会话里的 AI 会自动发现这些技能；你也可以直接让我用 github_api / github_skill_install 工具去搜仓库、装技能、按计划反复执行长期任务。',
        ),
      )
      return pageFrame({
        title: '技能',
        subtitle: '把 GitHub 上的技能装进本机，让 AI 学会并长期复用',
        toolbar: [
          h(
            Button,
            {
              key: 'reload',
              small: true,
              onClick: function () {
                loadSkills()
              },
            },
            '刷新',
          ),
        ],
        error: current.skillsError,
        loading: current.skillsLoading && !skills.length,
        loadingText: '正在读取技能…',
        body: body,
      })
    }

    function cloneButton(repo, options) {
      const busy = state.cloneBusy[repo]
      const opts = options || {}
      if (busy === 'cloning') return progressBar(repo, { inline: true })
      return h(
        Button,
        {
          small: true,
          kind: opts.kind,
          disabled: !!busy || !!opts.disabled,
          title: '克隆到本机 ' + repo,
          onClick: function () {
            cloneRepo(repo)
          },
        },
        opts.label || '克隆',
      )
    }

    function renderClones(current) {
      const tab = current.cloneTab || 'clones'
      const clones = current.clones || []
      const busy = current.cloneBusy || {}
      const auto = current.cloneAuto || { enabled: true, minutes: 15 }
      const notice = current.cloneNotice
      const git = current.cloneGit

      const tabBar = h(
        'div',
        { className: 'ghp-seg' },
        [
          ['clones', '已克隆'],
          ['repos', '我的仓库'],
          ['stars', '星标'],
          ['search', '搜索'],
        ].map(function (pair) {
          return h(
            'button',
            {
              key: pair[0],
              type: 'button',
              className: 'ghp-seg-btn' + (tab === pair[0] ? ' is-active' : ''),
              onClick: function () {
                set({ cloneTab: pair[0] })
                if (pair[0] === 'repos' && !state.repos) loadRepos()
                if (pair[0] === 'stars' && !state.stars) loadStars()
              },
            },
            pair[1],
          )
        }),
      )

      const autoCard = h(
        'div',
        { className: 'ghp-card ghp-clone-auto' },
        h(
          'div',
          { className: 'ghp-skill-head' },
          h('strong', null, '自动同步'),
          h('span', { className: 'ghp-muted ghp-small' }, '定时 fetch 并快进合并；作者一更新，本机克隆就跟上'),
        ),
        h(
          'div',
          { className: 'ghp-form-row' },
          h(
            Button,
            {
              small: true,
              kind: auto.enabled ? 'primary' : undefined,
              onClick: function () {
                setCloneAuto({ enabled: !auto.enabled })
              },
            },
            auto.enabled ? '已开启' : '已关闭',
          ),
          h(
            'label',
            { className: 'ghp-field ghp-field-narrow' },
            h('span', { className: 'ghp-field-label' }, '间隔（分钟）'),
            h('input', {
              className: 'ghp-input',
              type: 'number',
              min: 1,
              max: 720,
              value: auto.minutes,
              onChange: function (event) {
                const value = Number(event.target.value)
                if (Number.isFinite(value) && value >= 1 && value <= 720) setCloneAuto({ minutes: value })
              },
            }),
          ),
          h(
            'span',
            { className: 'ghp-muted ghp-small' },
            auto.enabled ? '每 ' + auto.minutes + ' 分钟检查一次' : '自动同步已暂停',
          ),
        ),
      )

      function cloneRows() {
        return clones.map(function (clone) {
          const rowBusy = busy[clone.repo]
          const behind = clone.behind || 0
          return h(
            'div',
            { className: 'ghp-clone', key: clone.repo },
            h(
              'div',
              { className: 'ghp-clone-head' },
              h('span', { className: 'ghp-clone-name' }, clone.repo),
              !clone.head
                ? h('span', { className: 'ghp-badge' }, '空仓库')
                : behind > 0
                  ? h('span', { className: 'ghp-badge ghp-badge-warn' }, '落后 ' + behind + ' 个提交')
                  : h('span', { className: 'ghp-badge ghp-badge-ok' }, '最新'),
              clone.ahead ? h('span', { className: 'ghp-badge' }, '领先 ' + clone.ahead) : null,
              clone.dirty ? h('span', { className: 'ghp-badge ghp-badge-warn' }, '有本地改动') : null,
              h('div', { className: 'ghp-toolbar-spacer' }),
              h(
                Button,
                {
                  small: true,
                  disabled: !!rowBusy || busy['*'] === 'syncing',
                  onClick: function () {
                    syncClone(clone.repo)
                  },
                },
                rowBusy === 'syncing' || busy['*'] === 'syncing' ? progressLabel(clone.repo) || '同步中…' : '同步',
              ),
              h(
                Button,
                {
                  small: true,
                  onClick: function () {
                    removeClone(clone.repo)
                  },
                },
                '删除',
              ),
            ),
            rowBusy === 'syncing' || busy['*'] === 'syncing' ? progressBar(clone.repo, { title: '正在拉取更新' }) : null,
            h('div', { className: 'ghp-muted ghp-small ghp-mono' }, clone.dir),
            h(
              'div',
              { className: 'ghp-muted ghp-small' },
              (clone.branch || '未知分支') +
                (clone.upstream ? ' → ' + clone.upstream : '') +
                (clone.head ? ' · ' + clone.head : '') +
                (clone.lastSync ? ' · 上次同步 ' + timeAgo(clone.lastSync) : ''),
            ),
            clone.lastError ? h('div', { className: 'ghp-error ghp-small' }, clone.lastError) : null,
          )
        })
      }

      function repoRows(rows, emptyText) {
        if (!rows || !rows.length) return h('div', { className: 'ghp-empty' }, emptyText)
        return rows.map(function (row) {
          const full = row.full_name
          return h(
            'div',
            { className: 'ghp-clone', key: full },
            h(
              'div',
              { className: 'ghp-clone-head' },
              h('span', { className: 'ghp-clone-name' }, full),
              row.private ? h('span', { className: 'ghp-badge' }, '私有') : null,
              row.stargazers_count ? h('span', { className: 'ghp-muted ghp-small' }, '★ ' + row.stargazers_count) : null,
              h('div', { className: 'ghp-toolbar-spacer' }),
              cloneButton(full, { kind: 'primary' }),
            ),
            row.description ? h('div', { className: 'ghp-muted ghp-small' }, row.description) : null,
          )
        })
      }

      let content
      if (tab === 'repos') {
        content = h('div', { className: 'ghp-clone-list' }, repoRows(current.repos || [], '还没有读取到仓库，点右上角刷新。'))
      } else if (tab === 'stars') {
        content = h('div', { className: 'ghp-clone-list' }, repoRows(current.stars || [], '还没有星标仓库，或者还没加载完。'))
      } else if (tab === 'search') {
        const results = current.cloneResults
        content = h(
          'div',
          { className: 'ghp-clone-list' },
          h(
            'div',
            { className: 'ghp-form-row ghp-clone-search' },
            h('input', {
              className: 'ghp-input',
              placeholder: '搜索 GitHub 仓库，例如 deepseek agent',
              value: current.cloneSearch,
              spellCheck: false,
              onChange: function (event) {
                set({ cloneSearch: event.target.value })
              },
              onKeyDown: function (event) {
                if (event.key === 'Enter') searchRepos()
              },
            }),
            h(
              Button,
              {
                small: true,
                kind: 'primary',
                disabled: current.cloneSearchLoading || !String(current.cloneSearch || '').trim(),
                onClick: function () {
                  searchRepos()
                },
              },
              current.cloneSearchLoading ? '搜索中…' : '搜索',
            ),
          ),
          current.cloneSearchError ? h('div', { className: 'ghp-error' }, current.cloneSearchError) : null,
          results === null
            ? h('div', { className: 'ghp-empty' }, '输入关键词，搜索结果可以直接点「克隆」。')
            : repoRows(results, '没有找到匹配的仓库。'),
        )
      } else {
        content = clones.length
          ? h('div', { className: 'ghp-clone-list' }, cloneRows())
          : h(
              'div',
              { className: 'ghp-empty' },
              '还没有克隆任何仓库。切到「我的仓库」「星标」或「搜索」，点一下「克隆」就会下载到 ' +
                (current.cloneRoot || '~/.dsh/github-clones') +
                '，之后随上游自动更新。',
            )
      }

      const running = []
      Object.keys(busy).forEach(function (key) {
        if (key !== '*' && busy[key] && running.indexOf(key) === -1) running.push(key)
      })
      Object.keys(current.cloneProgress || {}).forEach(function (repo) {
        if (!current.cloneProgress[repo].done && running.indexOf(repo) === -1) running.push(repo)
      })
      const runningPanel =
        running.length && tab !== 'clones'
          ? h(
              'div',
              { className: 'ghp-card ghp-progress-panel' },
              h('div', { className: 'ghp-progress-panel-title' }, '正在进行的克隆'),
              running.map(function (repo) {
                return progressBar(repo, { title: repo })
              }),
            )
          : null

      const body = h(
        'div',
        { className: 'ghp-clones' },
        notice
          ? h(
              'div',
              { className: notice.kind === 'error' ? 'ghp-error' : 'ghp-notice-ok' },
              notice.text,
              h(
                'button',
                {
                  type: 'button',
                  className: 'ghp-banner-close',
                  onClick: function () {
                    set({ cloneNotice: null })
                  },
                },
                '×',
              ),
            )
          : null,
        git === null
          ? h('div', { className: 'ghp-error' }, '本机没有找到 git，请先安装 Git 并把它加入 PATH，克隆功能才能使用。')
          : null,
        autoCard,
        runningPanel,
        content,
        h(
          'p',
          { className: 'ghp-muted ghp-small' },
          '克隆保存在本机 ' +
            (current.cloneRoot || '~/.dsh/github-clones') +
            '；同步只做快进合并，检测到本地改动时会停下来，不会覆盖你的文件。也可以用工具 github_clone / github_clone_sync 让 AI 直接操作。',
        ),
      )

      return pageFrame({
        title: '克隆',
        subtitle: '下载仓库到本机，作者更新后自动同步，始终不落后',
        toolbar: [
          tabBar,
          h(
            Button,
            {
              key: 'all',
              small: true,
              disabled: !!busy['*'] || clones.length === 0,
              onClick: function () {
                syncAllClones()
              },
            },
            busy['*'] ? '同步中…' : '全部同步',
          ),
          h(
            Button,
            {
              key: 'reload',
              small: true,
              onClick: function () {
                loadClones(false, true)
              },
            },
            '刷新',
          ),
        ],
        error: current.clonesError,
        loading: current.clonesLoading && !clones.length && tab === 'clones',
        loadingText: '正在检查本机克隆…',
        body: body,
      })
    }

    function renderGuest(current) {
      const guest = current.guest || {}
      const profile = guest.profile || {}
      const tab = guest.tab || 'repos'
      const tabs = [
        ['repos', '公开仓库'],
        ['starred', '星标'],
        ['events', '动态'],
      ]
      let list = null
      if (tab === 'repos' || tab === 'starred') {
        const rows = tab === 'repos' ? guest.repos || [] : guest.starred || []
        list = rows.length
          ? h(
              'div',
              { className: 'ghp-clone-list' },
              rows.map(function (row) {
                return h(
                  'div',
                  { className: 'ghp-clone', key: row.full_name },
                  h(
                    'div',
                    { className: 'ghp-clone-head' },
                    h('span', { className: 'ghp-clone-name' }, row.full_name),
                    row.private ? h('span', { className: 'ghp-badge' }, '私有') : null,
                    typeof row.stargazers_count === 'number'
                      ? h('span', { className: 'ghp-muted ghp-small' }, '★ ' + row.stargazers_count)
                      : null,
                  ),
                  row.description ? h('div', { className: 'ghp-muted ghp-small' }, row.description) : null,
                  h('div', { className: 'ghp-muted ghp-small' }, '更新于 ' + timeAgo(row.updated_at || row.pushed_at)),
                )
              }),
            )
          : h('div', { className: 'ghp-empty' }, tab === 'repos' ? '没有公开仓库' : '没有公开的星标')
      } else {
        const rows = guest.events || []
        list = rows.length
          ? h(
              'div',
              { className: 'ghp-events' },
              rows.map(function (event, index) {
                return h(
                  'div',
                  { className: 'ghp-event', key: event.id || index },
                  h('span', { className: 'ghp-dot' }),
                  h(
                    'div',
                    { className: 'ghp-event-text' },
                    h('span', { className: 'ghp-strong' }, event.repo ? event.repo.name : 'GitHub'),
                    h('span', { className: 'ghp-muted' }, ' · ' + eventText(event)),
                  ),
                  h('span', { className: 'ghp-muted ghp-small' }, timeAgo(event.created_at)),
                )
              }),
            )
          : h('div', { className: 'ghp-empty' }, '没有公开动态')
      }
      return pageFrame({
        title: profile.name || guest.login || '共享主页',
        subtitle:
          '访客模式 · 数据实时读自 GitHub 公开接口（不含私有仓库，也不需要你的令牌）',
        toolbar: [
          h(
            Button,
            {
              small: true,
              key: 'refresh',
              onClick: function () {
                loadGuest()
              },
            },
            '刷新',
          ),
          h(
            Button,
            {
              small: true,
              kind: 'primary',
              key: 'own',
              onClick: exitGuest,
            },
            '登录我自己的账号',
          ),
        ],
        error: guest.error || null,
        loading: guest.loading,
        loadingText: '正在读取公开资料…',
        body: h(
          'div',
          { className: 'ghp-guest' },
          h(
            'div',
            { className: 'ghp-card ghp-guest-head' },
            profile.avatar_url ? h('img', { className: 'ghp-guest-avatar', src: profile.avatar_url, alt: '' }) : null,
            h(
              'div',
              { className: 'ghp-guest-text' },
              h('div', { className: 'ghp-guest-name' }, profile.name || guest.login || ''),
              h('div', { className: 'ghp-muted ghp-small' }, '@' + (guest.login || '') + (profile.bio ? ' · ' + profile.bio : '')),
              h(
                'div',
                { className: 'ghp-muted ghp-small' },
                '公开仓库 ' +
                  (profile.public_repos == null ? '-' : profile.public_repos) +
                  ' · 关注者 ' +
                  (profile.followers == null ? '-' : profile.followers) +
                  ' · 星标 ' +
                  ((guest.starred || []).length || '-'),
              ),
            ),
          ),
          h(
            'div',
            { className: 'ghp-tabs' },
            tabs.map(function (pair) {
              return h(
                'button',
                {
                  type: 'button',
                  key: pair[0],
                  className: 'ghp-tab' + (tab === pair[0] ? ' is-active' : ''),
                  onClick: function () {
                    setGuestTab(pair[0])
                  },
                },
                pair[1],
              )
            }),
          ),
          list,
        ),
      })
    }

    function renderConnect(current) {
      return h(
        'div',
        { className: 'ghp-connect-wrap' },
        h(
          'div',
          { className: 'ghp-card ghp-connect' },
          h(
            'div',
            { className: 'ghp-connect-head' },
            h('div', { className: 'ghp-connect-mark' }, h(GitHubIcon, { size: 26, active: true })),
            h(
              'div',
              null,
              h('h2', { className: 'ghp-h2' }, '连接 GitHub'),
              h(
                'p',
                { className: 'ghp-muted' },
                '粘贴一个个人访问令牌，之后所有操作都由本机直接调用 GitHub API，数据与网页端实时同步。',
              ),
            ),
          ),
          h('label', { className: 'ghp-label' }, '个人访问令牌'),
          h('input', {
            className: 'ghp-input',
            type: 'password',
            value: current.tokenDraft,
            placeholder: 'ghp_… 或 github_pat_…',
            autoComplete: 'off',
            spellCheck: false,
            onChange: function (event) {
              set({ tokenDraft: event.target.value })
            },
            onKeyDown: function (event) {
              if (event.key === 'Enter') connect(current.tokenDraft)
            },
          }),
          h(
            'div',
            { className: 'ghp-row ghp-row-spread' },
            h(
              Button,
              {
                kind: 'primary',
                onClick: function () {
                  connect(current.tokenDraft)
                },
                disabled: current.connecting || !current.tokenDraft.trim(),
              },
              current.connecting ? '正在验证…' : '连接',
            ),
            h('span', { className: 'ghp-muted ghp-small' }, '令牌只保存在本机凭据存储，不会进入网页存储'),
          ),
          current.tokenError ? h('div', { className: 'ghp-error' }, current.tokenError) : null,
          h(
            'details',
            { className: 'ghp-help' },
            h('summary', null, '如何生成令牌？'),
            h(
              'ol',
              { className: 'ghp-help-list' },
              h('li', null, '打开 GitHub → Settings → Developer settings → Personal access tokens。'),
              h(
                'li',
                null,
                '经典令牌勾选 repo、notifications、read:user；Fine-grained 令牌则授予目标仓库的 Issues、Pull requests、Contents 的读写权限。',
              ),
              h('li', null, '生成后复制粘贴到上面的输入框，点击连接。'),
            ),
          ),
          h(
            'div',
            { className: 'ghp-invite' },
            h(
              'button',
              { type: 'button', className: 'ghp-invite-link', onClick: openInvite },
              '邀请码',
            ),
            current.inviteOpen
              ? h(
                  'div',
                  { className: 'ghp-invite-box' },
                  h('input', {
                    className: 'ghp-input',
                    type: 'password',
                    value: current.inviteDraft,
                    placeholder: '邀请码',
                    autoComplete: 'off',
                    spellCheck: false,
                    onChange: function (event) {
                      set({ inviteDraft: event.target.value })
                    },
                    onKeyDown: function (event) {
                      if (event.key === 'Enter') submitInvite()
                    },
                  }),
                  h(
                    Button,
                    {
                      small: true,
                      onClick: function () {
                        submitInvite()
                      },
                    },
                    '查看共享数据',
                  ),
                )
              : null,
            current.inviteError ? h('div', { className: 'ghp-error' }, current.inviteError) : null,
          ),
        ),
      )
    }

    function GitHubPanel() {
      const current = useStore()
      useEffect(function () {
        if (!current.booted) boot()
      }, [])

      useEffect(function () {
        const timer = window.setInterval(function () {
          if (!state.connected) return
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          if (state.detail) return
          refreshView(true)
        }, 60000)
        return function () {
          window.clearInterval(timer)
        }
      }, [])

      useEffect(function () {
        if (!current.notice) return undefined
        const timer = window.setTimeout(function () {
          set({ notice: null })
        }, 4000)
        return function () {
          window.clearTimeout(timer)
        }
      }, [current.notice])

      const header = h(
        'div',
        { className: 'ghp-header' },
        h('div', { className: 'ghp-brand' }, h(GitHubIcon, { size: 18, active: true }), h('span', null, 'GitHub 控制台')),
        current.connected
          ? h(
              'div',
              { className: 'ghp-nav' },
              [
                ['repos', '仓库'],
                ['clones', '克隆'],
                ['stars', '星标'],
                ['social', '关注'],
                ['activity', '动态'],
                ['skills', '技能'],
                ['notifications', '通知'],
              ].map(function (pair) {
                const active = current.view === pair[0]
                return h(
                  'button',
                  {
                    type: 'button',
                    key: pair[0],
                    className: 'ghp-nav-btn' + (active ? ' is-active' : ''),
                    onClick: function () {
                      set({ view: pair[0] })
                      ensureView(pair[0])
                    },
                  },
                  pair[1],
                )
              }),
            )
          : null,
        h(
          'div',
          { className: 'ghp-account' },
          current.notice
            ? h('span', { className: 'ghp-notice' }, current.notice)
            : null,
          current.profile
            ? h(
                'div',
                { className: 'ghp-account-chip' },
                current.profile.avatarUrl
                  ? h('img', { className: 'ghp-avatar', src: current.profile.avatarUrl, alt: '' })
                  : null,
                h('span', { className: 'ghp-account-name' }, current.profile.login || current.profile.name || ''),
                h(Button, { small: true, onClick: disconnect }, '断开'),
              )
            : current.guest
              ? h(
                  'div',
                  { className: 'ghp-account-chip' },
                  current.guest.profile && current.guest.profile.avatar_url
                    ? h('img', { className: 'ghp-avatar', src: current.guest.profile.avatar_url, alt: '' })
                    : null,
                  h('span', { className: 'ghp-account-name' }, '访客 · ' + (current.guest.login || '')),
                  h(Button, { small: true, onClick: exitGuest }, '退出'),
                )
              : null,
        ),
      )

      let body
      if (!current.booted) {
        body = h('div', { className: 'ghp-center' }, h(Spinner), h('span', { className: 'ghp-muted ghp-small' }, '正在读取 GitHub 连接状态…'))
      } else if (!current.connected && current.guest) {
        body = renderGuest(current)
      } else if (!current.connected) {
        body = renderConnect(current)
      } else if (current.view === 'clones') {
        body = renderClones(current)
      } else if (current.view === 'stars') {
        body = renderStars(current)
      } else if (current.view === 'social') {
        body = renderSocial(current)
      } else if (current.view === 'activity') {
        body = renderActivity(current)
      } else if (current.view === 'skills') {
        body = renderSkills(current)
      } else if (current.view === 'notifications') {
        body = h('div', { className: 'ghp-notif-pane' }, renderNotifications(current))
      } else {
        body = h('div', { className: 'ghp-body' }, renderRepoList(current), h('main', { className: 'ghp-main' }, renderRepoMain(current)))
      }

      return h(
        'div',
        { className: 'ghp-root' },
        h('style', null, CSS),
        header,
        current.actionError
          ? h(
              'div',
              { className: 'ghp-banner-error' },
              h('span', null, current.actionError),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ghp-banner-close',
                  onClick: function () {
                    set({ actionError: null })
                  },
                },
                '×',
              ),
            )
          : null,
        body,
      )
    }

    const CSS = [
      '.ghp-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}',
      '.ghp-header{display:flex;align-items:center;gap:14px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);flex:0 0 auto}',
      '.ghp-brand{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px}',
      '.ghp-nav{display:flex;gap:4px;padding:2px;border-radius:9px;background:var(--dsw-alias-bg-layer-2)}',
      '.ghp-nav-btn{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:4px 12px;border-radius:7px;cursor:pointer}',
      '.ghp-nav-btn.is-active{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.18)}',
      '.ghp-account{margin-left:auto;display:flex;align-items:center;gap:10px}',
      '.ghp-notice{font-size:12px;color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-bg-layer-2);padding:3px 9px;border-radius:999px}',
      '.ghp-account-chip{display:flex;align-items:center;gap:8px}',
      '.ghp-avatar{width:24px;height:24px;border-radius:50%;display:block;object-fit:cover;background:var(--dsw-alias-bg-layer-2)}',
      '.ghp-account-name{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.ghp-body{display:flex;flex:1;min-height:0;overflow:hidden}',
      '.ghp-side{width:300px;flex:0 0 300px;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.ghp-side-head{display:flex;gap:6px;padding:10px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.ghp-search{flex:1;min-width:0}',
      '.ghp-side-error{margin:8px 10px 0}',
      '.ghp-list{flex:1;min-height:0;overflow:auto;padding:6px}',
      '.ghp-main{flex:1;min-width:0;overflow:auto}',
      '.ghp-main-inner{padding:16px 18px 32px;display:flex;flex-direction:column;gap:12px}',
      '.ghp-repo-head{display:flex;align-items:flex-start;gap:12px}',
      '.ghp-repo-head-text{flex:1;min-width:0}',
      '.ghp-repo-title{font-size:15px;font-weight:600;word-break:break-all}',
      '.ghp-tabs{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.ghp-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;padding:7px 12px;cursor:pointer;border-bottom:2px solid transparent}',
      '.ghp-tab.is-active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary)}',
      '.ghp-content{display:flex;flex-direction:column;gap:10px;min-height:0}',
      '.ghp-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.ghp-seg{display:flex;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}',
      '.ghp-seg-btn{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:4px 10px;border-radius:6px;cursor:pointer}',
      '.ghp-seg-btn.is-active{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.ghp-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:6px 12px;border-radius:8px;cursor:pointer;white-space:nowrap}',
      '.ghp-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}',
      '.ghp-btn:disabled{opacity:.45;cursor:default}',
      '.ghp-btn-sm{font-size:12px;padding:4px 10px}',
      '.ghp-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}',
      '.ghp-input,.ghp-textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:inherit;font:inherit;border-radius:8px;padding:7px 10px}',
      '.ghp-input:focus,.ghp-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.ghp-textarea{resize:vertical;font-family:inherit}',
      '.ghp-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.ghp-row-spread{justify-content:space-between}',
      '.ghp-repo{display:block;width:100%;text-align:left;border:0;background:transparent;color:inherit;font:inherit;padding:8px 10px;border-radius:8px;cursor:pointer}',
      '.ghp-repo:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.ghp-repo.is-active{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}',
      '.ghp-repo-line{display:flex;align-items:center;gap:6px}',
      '.ghp-repo-name{font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ghp-repo-owner{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.ghp-repo-desc{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.ghp-badge{font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
      '.ghp-list-pane{display:flex;flex-direction:column;gap:4px}',
      '.ghp-item{display:block;width:100%;text-align:left;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;font:inherit;padding:9px 8px;cursor:pointer}',
      '.ghp-item:hover{background:var(--dsw-alias-bg-layer-1)}',
      '.ghp-item-static{cursor:default}',
      '.ghp-item-line{display:flex;align-items:center;gap:8px;min-width:0}',
      '.ghp-item-num{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex:0 0 auto}',
      '.ghp-item-title{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}',
      '.ghp-item-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px}',
      '.ghp-state{font-size:10px;padding:1px 7px;border-radius:999px;border:1px solid currentColor;flex:0 0 auto}',
      '.ghp-state-open{color:var(--dsw-alias-state-success-primary)}',
      '.ghp-state-closed{color:var(--dsw-alias-state-idle-primary)}',
      '.ghp-chip{font-size:10px;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}',
      '.ghp-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary);flex:0 0 auto}',
      '.ghp-detail{display:flex;flex-direction:column;gap:10px}',
      '.ghp-detail-head{display:flex;flex-direction:column;gap:4px}',
      '.ghp-h2{font-size:17px;font-weight:600;margin:0 0 4px}',
      '.ghp-h3{font-size:15px;font-weight:600;margin:0}',
      '.ghp-body-text{white-space:pre-wrap;word-break:break-word;font-size:13px}',
      '.ghp-sep{height:1px;background:var(--dsw-alias-border-l1);margin:4px 0}',
      '.ghp-comment{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1)}',
      '.ghp-form{display:flex;flex-direction:column;gap:8px;margin-top:6px}',
      '.ghp-actions{display:flex;gap:8px;flex-wrap:wrap}',
      '.ghp-muted{color:var(--dsw-alias-label-secondary)}',
      '.ghp-small{font-size:11px}',
      '.ghp-strong{font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.ghp-error{margin:6px 0;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-1);font-size:12px;word-break:break-word}',
      '.ghp-empty{padding:22px 10px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.ghp-center{display:flex;align-items:center;justify-content:center;gap:8px;padding:32px 16px;flex:1;min-height:120px}',
      '.ghp-hint{flex:1}',
      '.ghp-hint-title{font-size:15px;font-weight:600;text-align:center;margin-bottom:4px}',
      '.ghp-spinner{width:14px;height:14px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);display:inline-block;animation:ghp-spin .7s linear infinite}',
      '@keyframes ghp-spin{to{transform:rotate(360deg)}}',
      '.ghp-connect-wrap{flex:1;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:40px 20px}',
      '.ghp-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:20px}',
      '.ghp-connect{width:100%;max-width:520px;display:flex;flex-direction:column;gap:10px}',
      '.ghp-connect-head{display:flex;gap:12px;align-items:flex-start;margin-bottom:4px}',
      '.ghp-connect-head p{margin:0;font-size:12px}',
      '.ghp-connect-mark{width:40px;height:40px;border-radius:11px;background:var(--dsw-alias-bg-layer-2);display:flex;align-items:center;justify-content:center;flex:0 0 auto}',
      '.ghp-label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.ghp-help{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.ghp-help summary{cursor:pointer;list-style:none}',
      '.ghp-help summary::-webkit-details-marker{display:none}',
      '.ghp-help summary::before{content:"▸ ";color:var(--dsw-alias-brand-primary)}',
      '.ghp-help[open] summary::before{content:"▾ "}',
      '.ghp-help-list{margin:8px 0 0;padding-left:18px;display:flex;flex-direction:column;gap:4px}',
      '.ghp-notif-pane{flex:1;overflow:auto;padding:18px 20px 32px}',
      '.ghp-notif-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:8px}',
      '.ghp-notif-head p{margin:2px 0 0}',
      '.ghp-code{display:flex;flex-direction:column;gap:8px}',
      '.ghp-crumbs{display:flex;align-items:center;gap:2px;flex-wrap:wrap;font-size:12px}',
      '.ghp-crumb{border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;cursor:pointer;padding:2px 4px;border-radius:5px}',
      '.ghp-crumb:hover{background:var(--dsw-alias-bg-layer-1)}',
      '.ghp-crumb-sep{color:var(--dsw-alias-label-secondary)}',
      '.ghp-entry{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);background:transparent;color:inherit;font:inherit;padding:6px 8px;cursor:pointer}',
      '.ghp-entry:hover{background:var(--dsw-alias-bg-layer-1)}',
      '.ghp-entry-icon{color:var(--dsw-alias-brand-primary);width:12px;flex:0 0 auto}',
      '.ghp-entry-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}',
      '.ghp-entry-size{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.ghp-pre{margin:0;padding:12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);overflow:auto;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.6;max-height:60vh}',
      '.ghp-page{flex:1;min-height:0;overflow:auto;padding:18px 20px 32px;display:flex;flex-direction:column;gap:14px}',
      '.ghp-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '.ghp-page-head-text p{margin:2px 0 0}',
      '.ghp-page-title{font-size:16px;font-weight:600;margin:0}',
      '.ghp-toolbar-spacer{flex:1;min-width:8px}',
      '.ghp-search-input{width:200px;flex:0 0 200px}',
      '.ghp-card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}',
      '.ghp-tile{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:12px;display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.ghp-tile-title{font-weight:600;font-size:13px;word-break:break-all}',
      '.ghp-tile-desc{font-size:12px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
      '.ghp-tile-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:auto}',
      '.ghp-social{display:flex;flex-direction:column;gap:18px}',
      '.ghp-section{display:flex;flex-direction:column;gap:8px}',
      '.ghp-section-head{display:flex;align-items:baseline;gap:8px}',
      '.ghp-chips{display:flex;flex-wrap:wrap;gap:6px}',
      '.ghp-chip-user{display:flex;align-items:center;gap:6px;padding:3px 9px 3px 3px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:12px;max-width:100%}',
      '.ghp-chip-avatar{width:20px;height:20px;border-radius:50%;display:block;object-fit:cover}',
      '.ghp-events{display:flex;flex-direction:column}',
      '.ghp-event{display:flex;align-items:flex-start;gap:9px;padding:9px 4px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px}',
      '.ghp-event-body{flex:1;min-width:0;word-break:break-word}',
      '.ghp-event-time{margin-left:auto;flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.ghp-skills{display:flex;flex-direction:column;gap:12px}',
      '.ghp-skill-install{display:flex;flex-direction:column;gap:10px}',
      '.ghp-form-row{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end}',
      '.ghp-field{display:flex;flex-direction:column;gap:4px;flex:1 1 200px;min-width:160px}',
      '.ghp-field-narrow{flex:0 1 130px;min-width:110px}',
      '.ghp-field-label{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.ghp-skill-list{display:flex;flex-direction:column;gap:8px}',
      '.ghp-skill{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:4px}',
      '.ghp-skill-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.ghp-skill-name{font-weight:600;font-size:13px}',
      '.ghp-skill-desc{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.ghp-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',
      '.ghp-banner-error{display:flex;align-items:center;gap:10px;padding:8px 16px;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:12px}',
      '.ghp-banner-close{margin-left:auto;border:0;background:transparent;color:inherit;font:inherit;font-size:15px;cursor:pointer;line-height:1}',
      '.ghp-badge-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}',
      '.ghp-badge-ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
      '.ghp-notice-ok{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:10px;border:1px solid var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-bg-layer-1);font-size:12px}',
      '.ghp-clones{display:flex;flex-direction:column;gap:12px}',
      '.ghp-clone-auto{padding:12px}',
      '.ghp-clone-list{display:flex;flex-direction:column;gap:8px}',
      '.ghp-clone-search{margin-bottom:4px}',
      '.ghp-clone{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:5px}',
      '.ghp-clone-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.ghp-clone-name{font-weight:600;font-size:13px;word-break:break-all}',
      '.ghp-progress{display:flex;flex-direction:column;gap:4px;min-width:200px;flex:1 1 200px}',
      '.ghp-progress-inline{min-width:150px;max-width:220px;flex:0 0 auto;padding:2px 0}',
      '.ghp-progress-head{display:flex;align-items:baseline;gap:8px;justify-content:space-between}',
      '.ghp-progress-name{color:var(--dsw-alias-label-primary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ghp-progress-pct{color:var(--dsw-alias-brand-primary);font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}',
      '.ghp-progress-track{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.ghp-progress-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .35s ease}',
      '.ghp-progress-fill.is-indeterminate{animation:ghp-progress-slide 1.2s ease-in-out infinite}',
      '.ghp-progress-stage{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.ghp-progress-panel{display:flex;flex-direction:column;gap:10px}',
      '.ghp-progress-panel-title{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '@keyframes ghp-progress-slide{0%{transform:translateX(-100%)}100%{transform:translateX(260%)}}',
      '.ghp-invite{margin-top:8px;display:flex;flex-direction:column;align-items:flex-end;gap:8px}',
      '.ghp-invite-link{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;opacity:.5;cursor:pointer;padding:0}',
      '.ghp-invite-link:hover{opacity:1}',
      '.ghp-invite-box{display:flex;gap:6px;align-items:center;width:100%}',
      '.ghp-invite-box .ghp-input{flex:1}',
      '.ghp-guest{display:flex;flex-direction:column;gap:12px}',
      '.ghp-guest-head{display:flex;gap:12px;align-items:center}',
      '.ghp-guest-avatar{width:52px;height:52px;border-radius:50%;flex:0 0 52px;object-fit:cover;background:var(--dsw-alias-bg-layer-2)}',
      '.ghp-guest-text{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.ghp-guest-name{font-size:15px;font-weight:600}',
    ].join('')

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'github',
              order: 20,
              label: function () {
                return 'GitHub'
              },
            },
            GitHubIcon,
          )
        })
        ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: 'github' }, GitHubPanel)
        })
      },
    }
  },
})
