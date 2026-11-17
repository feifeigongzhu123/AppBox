/* =========================================================
   AppBox · 页面逻辑
   两种模式：
   - server：列表来自 api/apps，上传走本地 server.py
   - github：列表来自 data/apps.json，上传用 GitHub API 提交到仓库
   ========================================================= */

(function () {
  'use strict';

  const CONFIG = window.APPBOX_CONFIG || {};
  const GH = window.AppBoxGitHub || null;
  const MODE = CONFIG.mode === 'github' ? 'github' : 'server';
  const GH_READY = !!(MODE === 'github' && CONFIG.owner && CONFIG.repo);
  const GH_TOKEN_PREFIX = 'appbox-gh-token:';
  const GH_MAX_FILE = 50 * 1024 * 1024;
  const GH_MAX_TOTAL = 100 * 1024 * 1024;
  const SERVER_MAX_FILE = 300 * 1024 * 1024;

  let apps = [];
  let byId = new Map();
  let serverError = false;
  let authed = false;
  let authPassword = '';
  let ghToken = '';

  const state = { query: '', category: '全部' };

  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  const searchInput = $('#searchInput');
  const themeBtn = $('#themeBtn');
  const embedLayer = $('#embedLayer');
  const embedFrame = $('#embedFrame');

  /* ---------------- 工具函数 ---------------- */

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function tint(color, alpha) {
    const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color || '').trim());
    if (!match) return color;
    let hex = match[1];
    if (hex.length === 3) hex = hex.split('').map(ch => ch + ch).join('');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
  }

  function isExternal(url) {
    return /^(https?:)?\/\//i.test(url || '');
  }

  function kindOf(app) {
    if (app.kind === 'web' || app.kind === 'link' || app.kind === 'download') return app.kind;
    if (app.download === true || /\.(exe|msi|zip|rar|7z|apk|dmg|pkg)$/i.test(app.url || '')) {
      return 'download';
    }
    return isExternal(app.url) ? 'link' : 'web';
  }

  function kindLabel(app) {
    const kind = kindOf(app);
    if (kind === 'download') return '可下载文件';
    if (kind === 'link') return '外部网址';
    return '网页程序';
  }

  function iconIsImage(icon) {
    return /\.(png|jpe?g|gif|svg|webp|avif|ico)$/i.test(icon || '');
  }

  function iconMarkup(app, extraClass) {
    const accent = app.accent || '#5b7cfa';
    const bg =
      'background:linear-gradient(140deg, ' +
      tint(accent, 0.26) +
      ', ' +
      tint(accent, 0.07) +
      ');border-color:' +
      tint(accent, 0.2);
    const cls = 'app-icon' + (extraClass ? ' ' + extraClass : '');
    if (iconIsImage(app.icon)) {
      return '<span class="' + cls + ' has-img" style="' + bg + '"><img src="' +
        esc(app.icon) + '" alt=""></span>';
    }
    return '<span class="' + cls + '" style="' + bg + '">' +
      esc(app.icon || '📦') + '</span>';
  }

  function formatBytes(size) {
    const value = Number(size) || 0;
    if (!value) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let number = value;
    let index = 0;
    while (number >= 1024 && index < units.length - 1) {
      number /= 1024;
      index += 1;
    }
    return (index === 0 ? Math.round(number) : number.toFixed(1)) + ' ' + units[index];
  }

  function shareUrl(id) {
    return location.href.split('#')[0] + '#/app/' + encodeURIComponent(id);
  }

  function today() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return now.getFullYear() + '-' + month + '-' + day;
  }

  function timestamp() {
    return new Date()
      .toISOString()
      .replace(/[-:T]/g, '')
      .slice(0, 14);
  }

  function toast(message) {
    let el = $('#appToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'appToast';
      el.className = 'toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('is-show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('is-show'), 2600);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('链接已复制');
    } catch (err) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '-100px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (e) {
        ok = false;
      }
      ta.remove();
      toast(ok ? '链接已复制' : '复制失败，请手动复制');
    }
  }

  function indexApps() {
    byId = new Map(apps.map(app => [app.id, app]));
  }

  function updateStats() {
    document.getElementById('statApps').textContent = apps.length;
    document.getElementById('statCats').textContent = Math.max(categories().length - 1, 0);
  }

  function setMsg(selector, message, isError) {
    const el = $(selector);
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('error', !!isError);
    el.classList.toggle('ok', !isError && !!message);
  }

  function setPanels(state) {
    const panels = {
      auth: '#authPanel',
      setup: '#githubSetup',
      token: '#tokenPanel',
      form: '#uploadForm',
      manage: '#managePanel'
    };
    Object.keys(panels).forEach(key => {
      const el = $(panels[key]);
      if (el) el.hidden = !state[key];
    });
  }

  function setBusy(busy) {
    $('#submitBtn').disabled = busy;
    $('#submitBtn').textContent = busy ? '正在发布…' : '上传并发布';
  }

  function hidePublishNote() {
    const note = $('#publishNote');
    note.hidden = true;
    note.innerHTML = '';
  }

  /* ---------------- 数据加载 ---------------- */

  async function loadApps() {
    try {
      const url =
        MODE === 'github' ? 'data/apps.json?t=' + Date.now() : 'api/apps';
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data) ? data : null;
    } catch (err) {
      return null;
    }
  }

  async function refreshApps() {
    const data = await loadApps();
    if (data === null) {
      serverError = true;
      renderStore();
      return false;
    }
    serverError = false;
    apps = data;
    indexApps();
    updateStats();
    renderChips();
    renderStore();
    if (parseRoute().view === 'upload') renderManageList();
    return true;
  }

  /* ---------------- 列表 ---------------- */

  function categories() {
    return ['全部'].concat(
      Array.from(new Set(apps.map(app => app.category).filter(Boolean)))
    );
  }

  function filteredApps() {
    const query = state.query.trim().toLowerCase();
    return apps
      .filter(app => state.category === '全部' || app.category === state.category)
      .filter(app => {
        if (!query) return true;
        const haystack = [
          app.name,
          app.tagline,
          app.category,
          app.description,
          (app.tags || []).join(' ')
        ]
          .join(' ')
          .toLowerCase();
        return haystack.indexOf(query) !== -1;
      })
      .sort((a, b) => Number(!!b.featured) - Number(!!a.featured));
  }

  function cardHtml(app) {
    const accent = app.accent || '#5b7cfa';
    return (
      '<a class="card" href="#/app/' + encodeURIComponent(app.id) + '">' +
        '<div class="card-top">' +
          iconMarkup(app) +
          '<span class="card-arrow" aria-hidden="true">↗</span>' +
        '</div>' +
        '<div class="card-text">' +
          '<h3>' + esc(app.name) + '</h3>' +
          '<p>' + esc(app.tagline || '') + '</p>' +
        '</div>' +
        '<div class="card-foot">' +
          '<span class="cat-dot" style="background:' + esc(accent) + '"></span>' +
          '<span>' + esc(app.category || '未分类') + '</span>' +
          (app.featured ? '<span class="badge">推荐</span>' : '') +
        '</div>' +
      '</a>'
    );
  }

  function renderChips() {
    $('#categoryChips').innerHTML = categories()
      .map(category =>
        '<button class="chip' + (category === state.category ? ' is-active' : '') +
        '" type="button" data-cat="' + esc(category) + '">' + esc(category) + '</button>'
      )
      .join('');
  }

  function renderGrid() {
    const list = filteredApps();
    $('#appGrid').innerHTML = list.map(cardHtml).join('');
    $('#emptyState').hidden = list.length > 0;
    $('#resultCount').textContent =
      list.length + (state.query.trim() ? ' 个结果' : ' 个程序');
  }

  function renderServerError() {
    serverError = true;
    $('#categoryChips').innerHTML = '';
    $('#resultCount').textContent = '';
    $('#emptyState').hidden = true;
    $('#appGrid').innerHTML =
      '<div class="panel server-error">' +
        '<h2>没有读到程序列表</h2>' +
        (MODE === 'github'
          ? '<p>请确认仓库里存在 <code>data/apps.json</code>，并通过 GitHub Pages 或本地服务器打开页面。</p>' +
            '<p class="muted">直接双击 HTML 时浏览器不允许读取数据文件。</p>'
          : '<p>程序列表需要本地服务才能读取。请双击 <code>start.bat</code>，然后访问 ' +
            '<code>http://localhost:8080</code>。</p>' +
            '<p class="muted">如果服务已经启动，刷新一下页面；还不行就看看 8080 端口是否被占用。</p>') +
      '</div>';
  }

  function renderStore() {
    if (serverError) renderServerError();
    else renderGrid();
  }

  /* ---------------- 详情 ---------------- */

  function renderDetail(app) {
    const accent = app.accent || '#5b7cfa';
    const kind = kindOf(app);
    const canEmbed = kind === 'web' && app.embed !== false;
    const download = kind === 'download';
    const external = kind === 'link';

    const tags = (app.tags || [])
      .map(tag => '<span class="tag">' + esc(tag) + '</span>')
      .join('');

    const paragraphs = String(app.description || '')
      .split(/\n{2,}/)
      .filter(part => part.trim())
      .map(part => '<p>' + esc(part.trim()).replace(/\n/g, '<br>') + '</p>')
      .join('');

    const usage = (app.usage || [])
      .map((step, index) => {
        const title = step && step.title ? step.title : '第 ' + (index + 1) + ' 步';
        const text = step && step.text ? step.text : '';
        return (
          '<li><h4>' + esc(title) + '</h4><p>' +
          esc(text).replace(/\n/g, '<br>') +
          '</p></li>'
        );
      })
      .join('');

    const tips = (app.tips || [])
      .map(tip => '<li>' + esc(tip) + '</li>')
      .join('');

    const metaRows = [];
    if (app.category) metaRows.push(['分类', app.category]);
    if (app.version) metaRows.push(['版本', app.version]);
    if (app.updated) metaRows.push(['更新', app.updated]);
    if (download && app.size) metaRows.push(['大小', formatBytes(app.size)]);
    metaRows.push(['打开方式', download ? '下载文件' : external ? '外部链接' : '站内运行']);

    let actions = '';
    if (app.url) {
      if (download) {
        actions +=
          '<a class="btn primary" href="' + esc(app.url) + '" download>⬇ 下载程序' +
          (app.size ? ' · ' + esc(formatBytes(app.size)) : '') +
          '</a>';
      } else {
        actions +=
          '<button class="btn primary" id="actOpen" type="button">' +
          (canEmbed ? '▶ 打开程序' : '↗ 打开链接') +
          '</button>';
        if (canEmbed) {
          actions +=
            '<button class="btn ghost" id="actWindow" type="button">↗ 新窗口打开</button>';
        }
      }
    } else {
      actions += '<button class="btn primary" type="button" disabled>暂未上线</button>';
    }
    actions += '<button class="btn ghost" id="actCopy" type="button">🔗 复制链接</button>';

    const metaHtml = metaRows
      .map(row =>
        '<div class="meta-row"><dt>' + esc(row[0]) + '</dt><dd>' +
        esc(row[1]) + '</dd></div>'
      )
      .join('');

    $('#view-app').innerHTML =
      '<div class="wrap detail">' +
        '<a class="back" href="#/">← 返回商店</a>' +
        '<section class="detail-hero" style="--app-accent:' + esc(accent) + '">' +
          iconMarkup(app, 'big') +
          '<div class="detail-head">' +
            (app.category ? '<span class="eyebrow">' + esc(app.category) + '</span>' : '') +
            '<h1>' + esc(app.name) + '</h1>' +
            (app.tagline ? '<p class="detail-tagline">' + esc(app.tagline) + '</p>' : '') +
            (tags ? '<div class="tags">' + tags + '</div>' : '') +
            '<div class="actions">' + actions + '</div>' +
          '</div>' +
        '</section>' +
        '<div class="detail-body">' +
          '<article class="panel">' +
            (paragraphs ? '<h2>这是什么</h2>' + paragraphs : '') +
            (usage ? '<h2>使用方法</h2><ol class="steps">' + usage + '</ol>' : '') +
          '</article>' +
          '<aside class="panel side">' +
            (tips ? '<h3>小提示</h3><ul class="tips">' + tips + '</ul>' : '') +
            '<dl class="meta">' + metaHtml + '</dl>' +
          '</aside>' +
        '</div>' +
      '</div>';

    bindDetail(app, kind, canEmbed);
  }

  function bindDetail(app, kind, canEmbed) {
    const openBtn = $('#actOpen');
    if (openBtn) {
      openBtn.addEventListener('click', () => {
        if (canEmbed) openEmbed(app);
        else if (app.url) window.open(app.url, '_blank', 'noopener');
      });
    }

    const windowBtn = $('#actWindow');
    if (windowBtn) {
      windowBtn.addEventListener('click', () => {
        if (app.url) window.open(app.url, '_blank', 'noopener');
      });
    }

    const copyBtn = $('#actCopy');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => copyText(shareUrl(app.id)));
    }
  }

  /* ---------------- 站内窗口 ---------------- */

  function openEmbed(app) {
    $('#embedTitle').textContent = app.name;
    embedFrame.src = app.url;
    embedLayer.hidden = false;
    document.body.classList.add('no-scroll');
    $('#embedClose').focus();
  }

  function closeEmbed() {
    if (embedLayer.hidden) return;
    embedLayer.hidden = true;
    embedFrame.src = 'about:blank';
    document.body.classList.remove('no-scroll');
  }

  /* ---------------- 上传：口令 ---------------- */

  function tokenKey() {
    return GH_TOKEN_PREFIX + (CONFIG.owner || '') + '/' + (CONFIG.repo || '');
  }

  function getStoredToken() {
    try {
      const raw = localStorage.getItem(tokenKey());
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  function clearStoredToken() {
    try {
      localStorage.removeItem(tokenKey());
    } catch (err) {
      /* ignore */
    }
  }

  function updateModeUi() {
    const hint = $('#authHint');
    if (MODE === 'github') {
      hint.innerHTML =
        '密码只在本机校验。第一次上传还需要一个 GitHub 写入令牌，会用密码加密保存在这台浏览器。';
    } else {
      hint.innerHTML =
        '本地模式下，密码在 <code>data/admin-token.txt</code> 里，服务窗口启动时也会显示。';
    }
    if (MODE !== 'github') {
      $('#githubSetup').hidden = true;
      $('#tokenPanel').hidden = true;
    }
  }

  function enterUploadView() {
    hidePublishNote();
    if (authed) {
      if (MODE === 'github') {
        if (!GH_READY) {
          setPanels({ setup: true });
          return;
        }
        if (!ghToken) {
          setPanels({ token: true });
          return;
        }
      }
      setPanels({ form: true, manage: true });
      renderManageList();
      return;
    }
    setPanels({ auth: true });
    $('#tokenInput').focus();
  }

  async function verifyServerPassword(password) {
    try {
      const res = await fetch('api/auth', {
        method: 'POST',
        headers: { 'X-Admin-Token': password }
      });
      return res.ok;
    } catch (err) {
      return false;
    }
  }

  async function unlockGithub() {
    const stored = getStoredToken();
    if (stored) {
      try {
        ghToken = await GH.decryptToken(stored, authPassword);
        setPanels({ form: true, manage: true });
        renderManageList();
        return;
      } catch (err) {
        clearStoredToken();
      }
    }
    setPanels({ token: true });
    $('#ghTokenInput').focus();
  }

  async function tryPassword() {
    const password = $('#tokenInput').value.trim();
    if (!password) {
      setMsg('#authMsg', '请输入上传密码', true);
      return;
    }

    if (MODE === 'github') {
      if (!GH) {
        setMsg('#authMsg', 'GitHub 模块没有加载，请检查 assets/github.js', true);
        return;
      }
      if (!CONFIG.passwordHash) {
        setMsg('#authMsg', '还没有配置 passwordHash，请先看 assets/config.js', true);
        return;
      }
      setMsg('#authMsg', '正在校验…');
      try {
        const hash = await GH.hashPassword(password);
        if (hash.toLowerCase() !== String(CONFIG.passwordHash).toLowerCase()) {
          setMsg('#authMsg', '密码不正确', true);
          return;
        }
        authPassword = password;
        authed = true;
        setMsg('#authMsg', '');
        if (!GH_READY) {
          setPanels({ setup: true });
          return;
        }
        await unlockGithub();
      } catch (err) {
        setMsg('#authMsg', err.message || '校验失败', true);
      }
      return;
    }

    setMsg('#authMsg', '正在校验…');
    const ok = await verifyServerPassword(password);
    if (!ok) {
      setMsg('#authMsg', '密码不正确，请看一下 data/admin-token.txt', true);
      return;
    }
    authPassword = password;
    authed = true;
    setMsg('#authMsg', '');
    setPanels({ form: true, manage: true });
    renderManageList();
  }

  async function saveGhToken() {
    const value = $('#ghTokenInput').value.trim();
    if (!value) {
      setMsg('#ghTokenMsg', '请粘贴 GitHub 令牌', true);
      return;
    }
    if (!GH) {
      setMsg('#ghTokenMsg', 'GitHub 模块没有加载', true);
      return;
    }
    setMsg('#ghTokenMsg', '正在验证令牌…');
    try {
      await GH.verifyRepo({
        owner: CONFIG.owner,
        repo: CONFIG.repo,
        branch: CONFIG.branch || 'main',
        token: value
      });
      const payload = await GH.encryptToken(value, authPassword);
      try {
        localStorage.setItem(tokenKey(), JSON.stringify(payload));
      } catch (err) {
        throw new Error('浏览器不允许保存令牌，请检查隐私设置');
      }
      ghToken = value;
      setMsg('#ghTokenMsg', '');
      setPanels({ form: true, manage: true });
      renderManageList();
      toast('令牌已加密保存');
    } catch (err) {
      setMsg('#ghTokenMsg', err.message || '令牌验证失败', true);
    }
  }

  /* ---------------- 上传：表单 ---------------- */

  function syncKindFields() {
    const kind = $('#fKind').value;
    const fileInput = $('#fFile');
    const embedLabel = $('#fEmbed').closest('label');

    $('#urlField').hidden = kind !== 'link';
    $('#fileField').hidden = kind === 'link';

    if (kind === 'web') {
      if (MODE === 'github') {
        fileInput.removeAttribute('accept');
        fileInput.setAttribute('webkitdirectory', '');
        fileInput.setAttribute('multiple', '');
        $('#fileLabel').textContent = '程序文件夹';
        $('#fileHint').textContent =
          '选择整个程序文件夹，最外层要有 index.html。单个文件不超过 50 MB，整个程序不超过 100 MB。';
      } else {
        fileInput.removeAttribute('webkitdirectory');
        fileInput.removeAttribute('multiple');
        fileInput.accept = '.zip';
        $('#fileLabel').textContent = '程序压缩包（zip）';
        $('#fileHint').textContent =
          '把网页程序文件夹压成 zip，压缩包里最外层要有 index.html。';
      }
      embedLabel.hidden = false;
    } else if (kind === 'download') {
      fileInput.removeAttribute('webkitdirectory');
      fileInput.removeAttribute('multiple');
      fileInput.removeAttribute('accept');
      $('#fileLabel').textContent = '要下载的文件';
      $('#fileHint').textContent =
        MODE === 'github'
          ? '单个文件不超过 50 MB；更大的安装包建议放到 GitHub Releases，再在商店里填外部网址。'
          : '支持 exe、msi、apk、zip、rar、7z、dmg、pdf、docx 等，单个最大 300 MB。';
      embedLabel.hidden = true;
      $('#fEmbed').checked = false;
    } else {
      embedLabel.hidden = true;
      $('#fEmbed').checked = false;
    }
  }

  function splitTags(value) {
    return String(value || '')
      .split(/[,，、\s]+/)
      .map(item => item.trim())
      .filter(Boolean)
      .slice(0, 8);
  }

  function splitLines(value) {
    return String(value || '')
      .split(/\n+/)
      .map(item => item.trim())
      .filter(Boolean)
      .slice(0, 10);
  }

  function parseUsage(value) {
    return String(value || '')
      .split(/\n+/)
      .map(item => item.trim())
      .filter(Boolean)
      .slice(0, 20)
      .map(line => {
        const parts = line.split(/[|｜]/);
        if (parts.length === 1) return { title: line, text: '' };
        return {
          title: parts[0].trim() || '步骤',
          text: parts.slice(1).join(' | ').trim()
        };
      });
  }

  function collectWebFolder(input) {
    const all = Array.from(input.files || []);
    if (!all.length) throw new Error('请选择整个程序文件夹');
    if (!all.some(file => (file.webkitRelativePath || '').split('/').length > 1)) {
      throw new Error('请选择文件夹，而不是单个文件');
    }

    const files = [];
    let total = 0;
    all.forEach(file => {
      const relative = file.webkitRelativePath || file.name;
      const parts = relative.split('/');
      if (parts.length > 1) parts.shift();
      const path = parts.join('/');
      if (!path) return;
      if (/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(path)) return;
      if (path.split('/').indexOf('..') !== -1) throw new Error('文件名里有非法路径');
      if (file.size > GH_MAX_FILE) {
        throw new Error('文件「' + path + '」超过 50 MB');
      }
      total += file.size;
      files.push({ file: file, path: path });
    });

    if (!files.some(item => item.path === 'index.html')) {
      throw new Error('文件夹最外层没有 index.html');
    }
    if (total > GH_MAX_TOTAL) throw new Error('整个程序超过 100 MB，请精简后再上传');
    return { files: files, total: total };
  }

  function collectWebZip(input) {
    const file = input.files && input.files[0];
    if (!file) throw new Error('请选择网页程序 zip 压缩包');
    if (!/\.zip$/i.test(file.name)) throw new Error('网页程序需要打包成 zip 再上传');
    if (file.size > SERVER_MAX_FILE) throw new Error('文件超过 300 MB，请精简后再上传');
    return file;
  }

  function collectDownloadFile(input) {
    const file = input.files && input.files[0];
    if (!file) throw new Error('请选择要上传的文件');
    const limit = MODE === 'github' ? GH_MAX_FILE : SERVER_MAX_FILE;
    if (file.size > limit) {
      throw new Error(
        MODE === 'github' ? '单文件超过 50 MB，请放到 GitHub Releases' : '文件超过 300 MB'
      );
    }
    return file;
  }

  function buildEntry(kind, id, name, url, size) {
    return {
      id: id,
      name: name,
      kind: kind,
      url: url,
      tagline: $('#fTagline').value.trim(),
      icon: $('#fIcon').value.trim() || '📦',
      accent: $('#fAccent').value,
      category: $('#fCategory').value.trim() || '其他',
      tags: splitTags($('#fTags').value),
      embed: kind === 'web' ? $('#fEmbed').checked : false,
      featured: $('#fFeatured').checked,
      description: $('#fDesc').value.trim(),
      usage: parseUsage($('#fUsage').value),
      tips: splitLines($('#fTips').value),
      size: size || 0,
      updated: today()
    };
  }

  function upsertLocal(entry) {
    const index = apps.findIndex(app => app.id === entry.id);
    if (index >= 0) apps[index] = entry;
    else apps.push(entry);
    indexApps();
    updateStats();
    renderChips();
    renderStore();
    renderManageList();
  }

  /* ---------------- 上传：GitHub 发布 ---------------- */

  function pagesHint() {
    const owner = encodeURIComponent(CONFIG.owner);
    const repo = encodeURIComponent(CONFIG.repo);
    return {
      pages: 'https://' + owner + '.github.io/' + repo + '/',
      actions: 'https://github.com/' + owner + '/' + repo + '/actions'
    };
  }

  async function publishGithub(kind, id, name, entry, folder, file) {
    if (!GH_READY || !ghToken) throw new Error('GitHub 还没有配置好');
    const options = {
      owner: CONFIG.owner,
      repo: CONFIG.repo,
      branch: CONFIG.branch || 'main',
      token: ghToken
    };

    let catalog = await GH.getRemoteJson(
      Object.assign({ path: 'data/apps.json' }, options)
    );
    if (!Array.isArray(catalog)) catalog = apps.slice();

    const entries = [];
    const existing = catalog.find(app => app.id === id);
    const newPaths = new Set();

    if (kind === 'web') {
      for (const item of folder.files) {
        const path = 'apps/' + id + '/' + item.path;
        newPaths.add(path);
        entries.push({
          path: path,
          content: await GH.fileToBase64(item.file)
        });
      }
      if (existing) {
        const tree = await GH.getTree(options);
        tree.items.forEach(item => {
          if (
            item.type === 'blob' &&
            item.path.indexOf('apps/' + id + '/') === 0 &&
            !newPaths.has(item.path)
          ) {
            entries.push({ path: item.path, remove: true });
          }
        });
      }
    } else if (kind === 'download') {
      const safeName =
        file.name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').slice(0, 90) || 'file.bin';
      const stored = timestamp() + '-' + safeName;
      entry.url = 'files/' + encodeURIComponent(stored);
      entries.push({
        path: 'files/' + stored,
        content: await GH.fileToBase64(file)
      });
    }

    const index = catalog.findIndex(app => app.id === id);
    if (index >= 0) catalog[index] = entry;
    else catalog.push(entry);

    entries.push({
      path: 'data/apps.json',
      content: GH.encodeUtf8Base64(JSON.stringify(catalog, null, 2) + '\n')
    });

    await GH.commitEntries(
      Object.assign(
        {
          entries: entries,
          message: 'Publish ' + name + ' (' + id + ')'
        },
        options
      )
    );

    upsertLocal(entry);

    const links = pagesHint();
    const note = $('#publishNote');
    note.innerHTML =
      '已提交到 GitHub，Pages 大约 1 分钟后更新。' +
      ' <a href="' + esc(links.actions) + '" target="_blank" rel="noopener">查看部署进度</a>' +
      ' · <a href="' + esc(links.pages) + '" target="_blank" rel="noopener">打开站点</a>';
    note.hidden = false;
    setMsg('#formMsg', '已提交，等待 Pages 部署', false);
    toast('已提交到 GitHub');
  }

  /* ---------------- 上传：本地发布 ---------------- */

  function uploadServerFile(url, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.setRequestHeader('X-Admin-Token', authPassword);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-Filename-Enc', encodeURIComponent(file.name));
      xhr.upload.onprogress = event => {
        if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
      };
      xhr.onload = () => {
        let data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch (err) {
          data = null;
        }
        if (xhr.status >= 200 && xhr.status < 300 && data && data.ok) {
          resolve(data);
        } else {
          reject(new Error((data && data.error) || '上传失败（' + xhr.status + '）'));
        }
      };
      xhr.onerror = () => reject(new Error('网络错误，上传失败'));
      xhr.ontimeout = () => reject(new Error('上传超时'));
      xhr.send(file);
    });
  }

  async function publishServer(kind, id, name, entry, folder, file) {
    let url = entry.url;
    let size = entry.size;

    if (kind === 'web' || kind === 'download') {
      const endpoint =
        kind === 'web'
          ? 'api/upload/webapp?slug=' + encodeURIComponent(id)
          : 'api/upload/file';
      setMsg('#formMsg', '准备上传…');
      const result = await uploadServerFile(endpoint, file, ratio => {
        setMsg('#formMsg', '上传中 ' + Math.round(ratio * 100) + '%');
      });
      url = result.url;
      size = result.size || 0;
    }

    const finalEntry = Object.assign({}, entry, { url: url, size: size });

    setMsg('#formMsg', '正在发布…');
    const res = await fetch('api/apps', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': authPassword
      },
      body: JSON.stringify(finalEntry)
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) {
      if (res.status === 401) {
        authed = false;
        setPanels({ auth: true });
      }
      throw new Error((data && data.error) || '发布失败（' + res.status + '）');
    }

    await refreshApps();
    toast('已发布：' + name);
  }

  /* ---------------- 上传：提交 ---------------- */

  async function submitForm(event) {
    event.preventDefault();
    hidePublishNote();

    if (!authed) {
      toast('请先输入上传密码');
      setPanels({ auth: true });
      return;
    }

    const kind = $('#fKind').value;
    const id = $('#fId').value.trim().toLowerCase();
    const name = $('#fName').value.trim();

    try {
      if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(id)) {
        throw new Error('链接标识只能用小写字母、数字、短横线，长度 2–40');
      }
      if (!name) throw new Error('请填写程序名称');

      let url = '';
      let size = 0;
      let folder = null;
      let file = null;

      setBusy(true);

      if (kind === 'link') {
        url = $('#fUrl').value.trim();
        if (!/^https?:\/\//i.test(url)) {
          throw new Error('网址需要以 http:// 或 https:// 开头');
        }
      } else if (kind === 'web') {
        if (MODE === 'github') {
          folder = collectWebFolder($('#fFile'));
          size = folder.total;
          url = 'apps/' + id + '/';
        } else {
          file = collectWebZip($('#fFile'));
          size = file.size;
          url = 'apps/' + id + '/';
        }
      } else {
        file = collectDownloadFile($('#fFile'));
        size = file.size;
      }

      let entry = buildEntry(kind, id, name, url, size);

      if (kind === 'download') {
        entry.url = 'files/';
      }

      if (MODE === 'github') {
        await publishGithub(kind, id, name, entry, folder, file);
      } else {
        await publishServer(kind, id, name, entry, folder, file);
      }

      event.target.reset();
      syncKindFields();
      if (MODE === 'server') {
        setMsg('#formMsg', '');
        location.hash = '#/app/' + encodeURIComponent(id);
      }
    } catch (err) {
      setMsg('#formMsg', err.message || '出错了', true);
    } finally {
      setBusy(false);
    }
  }

  /* ---------------- 管理列表 ---------------- */

  function renderManageList() {
    const list = $('#manageList');
    if (!apps.length) {
      list.innerHTML = '<li class="muted">还没有发布任何程序</li>';
      return;
    }
    list.innerHTML = apps
      .map(app =>
        '<li>' +
          '<span class="manage-name">' + esc(app.name) + '</span>' +
          '<span class="manage-kind">' + esc(kindLabel(app)) + '</span>' +
          '<span class="spacer"></span>' +
          '<button class="btn ghost sm danger" type="button" data-del="' +
          esc(app.id) + '">删除</button>' +
        '</li>'
      )
      .join('');
  }

  async function deleteGithub(app) {
    const options = {
      owner: CONFIG.owner,
      repo: CONFIG.repo,
      branch: CONFIG.branch || 'main',
      token: ghToken
    };
    let catalog = await GH.getRemoteJson(
      Object.assign({ path: 'data/apps.json' }, options)
    );
    if (!Array.isArray(catalog)) catalog = apps.slice();
    const remaining = catalog.filter(item => item.id !== app.id);
    if (remaining.length === catalog.length) throw new Error('仓库里没有找到这个程序');

    const entries = [];
    if (kindOf(app) === 'web') {
      const tree = await GH.getTree(options);
      const prefix = 'apps/' + app.id + '/';
      const hits = tree.items.filter(
        item => item.type === 'blob' && item.path.indexOf(prefix) === 0
      );
      if (!hits.length) throw new Error('仓库里没有找到程序文件');
      hits.forEach(item => entries.push({ path: item.path, remove: true }));
    } else if (kindOf(app) === 'download' && app.url && app.url.indexOf('files/') === 0) {
      entries.push({ path: decodeURIComponent(app.url), remove: true });
    }

    entries.push({
      path: 'data/apps.json',
      content: GH.encodeUtf8Base64(JSON.stringify(remaining, null, 2) + '\n')
    });

    await GH.commitEntries(
      Object.assign(
        {
          entries: entries,
          message: 'Remove ' + app.name + ' (' + app.id + ')'
        },
        options
      )
    );

    apps = remaining;
    indexApps();
    updateStats();
    renderChips();
    renderStore();
    renderManageList();

    const links = pagesHint();
    const note = $('#publishNote');
    note.innerHTML =
      '已提交删除，Pages 大约 1 分钟后生效。' +
      ' <a href="' + esc(links.actions) + '" target="_blank" rel="noopener">查看部署进度</a>';
    note.hidden = false;
    setMsg('#formMsg', '已提交删除，等待 Pages 部署', false);
    toast('已删除：' + app.name);
  }

  async function deleteServer(app) {
    setMsg('#formMsg', '正在删除…');
    const res = await fetch(
      'api/apps?id=' + encodeURIComponent(app.id) + '&purge=1',
      { method: 'DELETE', headers: { 'X-Admin-Token': authPassword } }
    );
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) {
      if (res.status === 401) {
        authed = false;
        setPanels({ auth: true });
      }
      throw new Error((data && data.error) || '删除失败');
    }
    toast('已删除：' + app.name);
    setMsg('#formMsg', '');
    await refreshApps();
    renderManageList();
  }

  async function onManageClick(event) {
    const btn = event.target.closest('[data-del]');
    if (!btn) return;
    const appId = btn.dataset.del;
    const app = apps.find(item => item.id === appId);
    if (!app) return;

    const message =
      MODE === 'github'
        ? '确定删除「' + app.name + '」？\n会向 GitHub 提交一次删除，Pages 约 1 分钟后生效。'
        : '确定删除「' + app.name + '」？\n存储里的程序文件也会一起删除。';
    if (!window.confirm(message)) return;

    btn.disabled = true;
    try {
      if (MODE === 'github') await deleteGithub(app);
      else await deleteServer(app);
    } catch (err) {
      setMsg('#formMsg', err.message || '删除失败', true);
      btn.disabled = false;
    }
  }

  /* ---------------- 主题 ---------------- */

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('appbox-theme', theme);
    } catch (err) {
      /* ignore */
    }
    const dark = theme === 'dark';
    themeBtn.textContent = dark ? '☀' : '☾';
    themeBtn.setAttribute('aria-label', dark ? '切换到浅色模式' : '切换到深色模式');
    themeBtn.title = dark ? '切换到浅色模式' : '切换到深色模式';
  }

  /* ---------------- 路由 ---------------- */

  function parseRoute() {
    const raw = location.hash.replace(/^#\/?/, '');
    if (raw === 'guide') return { view: 'guide' };
    if (raw === 'upload') return { view: 'upload' };
    if (raw.indexOf('app/') === 0) {
      return { view: 'app', id: decodeURIComponent(raw.slice(4)) };
    }
    return { view: 'store' };
  }

  function route() {
    closeEmbed();
    const current = parseRoute();

    ['store', 'app', 'guide', 'upload'].forEach(name => {
      const el = document.getElementById('view-' + name);
      if (el) el.hidden = name !== current.view;
    });

    $$('.site-nav a').forEach(link => {
      const target = current.view === 'app' ? 'store' : current.view;
      link.classList.toggle('is-active', link.dataset.nav === target);
    });

    if (current.view === 'app') {
      const app = byId.get(current.id);
      if (!app) {
        location.replace('#/');
        return;
      }
      renderDetail(app);
      document.title = app.name + ' · ' + (CONFIG.siteName || 'AppBox');
    } else if (current.view === 'guide') {
      document.title = '使用指南 · ' + (CONFIG.siteName || 'AppBox');
    } else if (current.view === 'upload') {
      document.title = '上传程序 · ' + (CONFIG.siteName || 'AppBox');
      enterUploadView();
    } else {
      document.title =
        (CONFIG.siteName || 'AppBox') + ' · ' + (CONFIG.tagline || '我的程序都在这里');
      renderStore();
    }

    window.scrollTo(0, 0);
  }

  /* ---------------- 初始化 ---------------- */

  async function init() {
    document.getElementById('brandName').textContent = CONFIG.siteName || 'AppBox';
    document.getElementById('brandMark').textContent = CONFIG.siteMark || '▦';
    document.getElementById('heroSub').textContent =
      CONFIG.subTagline || '程序存在 AppBox 里，打开就能用，每个都附带使用方法。';
    document.getElementById('footerText').textContent =
      CONFIG.footer || '个人程序盒子 · 持续更新中';
    document.getElementById('footerYear').textContent = new Date().getFullYear();

    let savedTheme = null;
    try {
      savedTheme = localStorage.getItem('appbox-theme');
    } catch (err) {
      savedTheme = null;
    }
    const prefersDark =
      window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(savedTheme || (prefersDark ? 'dark' : 'light'));

    themeBtn.addEventListener('click', () => {
      applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    });

    $('#categoryChips').addEventListener('click', event => {
      const chip = event.target.closest('.chip');
      if (!chip) return;
      state.category = chip.dataset.cat;
      renderChips();
      renderStore();
    });

    searchInput.addEventListener('input', () => {
      state.query = searchInput.value;
      if (parseRoute().view !== 'store') location.hash = '#/';
      renderStore();
    });

    $('#clearSearch').addEventListener('click', () => {
      searchInput.value = '';
      state.query = '';
      renderStore();
      searchInput.focus();
    });

    $('#tokenBtn').addEventListener('click', tryPassword);
    $('#tokenInput').addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        tryPassword();
      }
    });
    $('#ghTokenBtn').addEventListener('click', saveGhToken);
    $('#ghTokenInput').addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        saveGhToken();
      }
    });

    $('#fKind').addEventListener('change', () => {
      $('#fFile').value = '';
      syncKindFields();
    });
    $('#uploadForm').addEventListener('submit', submitForm);
    $('#manageList').addEventListener('click', onManageClick);
    syncKindFields();
    updateModeUi();

    $('#embedClose').addEventListener('click', closeEmbed);
    $('#embedNewWindow').addEventListener('click', () => {
      const src = embedFrame.getAttribute('src');
      if (src && src !== 'about:blank') window.open(src, '_blank', 'noopener');
    });
    embedLayer.addEventListener('mousedown', event => {
      if (event.target === embedLayer) closeEmbed();
    });

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeEmbed();
      if (
        event.key === '/' &&
        !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)
      ) {
        event.preventDefault();
        searchInput.focus();
      }
    });

    $$('[data-scroll]').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = document.getElementById(btn.dataset.scroll);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    window.addEventListener('hashchange', route);

    const data = await loadApps();
    if (data === null) {
      serverError = true;
      apps = [];
      indexApps();
      renderChips();
      updateStats();
      route();
      return;
    }

    serverError = false;
    apps = data;
    indexApps();
    updateStats();
    renderChips();
    route();
  }

  init();
})();
