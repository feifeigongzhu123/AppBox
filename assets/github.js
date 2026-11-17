/* ==========================================================================
   AppBox · GitHub 接口与本地加密
   --------------------------------------------------------------------------
   - 上传密码只用于：校验解锁、加密保存 GitHub 写入令牌
   - GitHub 令牌保存在 localStorage，用 AES-GCM 加密，不会写进仓库
   - 发布时通过 GitHub Git Data API 提交 blobs / tree / commit / ref
   ========================================================================== */

(function () {
  'use strict';

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function apiBase() {
    return window.APPBOX_GH_API || 'https://api.github.com';
  }

  /* ---------------- base64 ---------------- */

  function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = atob(String(value || '').replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function encodeUtf8Base64(text) {
    return bytesToBase64(encoder.encode(text));
  }

  function decodeBase64Utf8(value) {
    return decoder.decode(base64ToBytes(value));
  }

  async function fileToBase64(file) {
    const buffer = await file.arrayBuffer();
    return bytesToBase64(new Uint8Array(buffer));
  }

  /* ---------------- 密码 ---------------- */

  async function hashPassword(password) {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error('当前环境不支持加密，请用 https 或 localhost 打开');
    }
    const digest = await crypto.subtle.digest(
      'SHA-256',
      encoder.encode('appbox-v1:' + password)
    );
    return Array.from(new Uint8Array(digest))
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  /* ---------------- 令牌加密 ---------------- */

  async function deriveKey(password, salt) {
    const baseKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt, iterations: 210000, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptToken(token, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      key,
      encoder.encode(token)
    );
    return {
      v: 1,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      data: bytesToBase64(new Uint8Array(encrypted))
    };
  }

  async function decryptToken(payload, password) {
    if (!payload || !payload.salt || !payload.iv || !payload.data) {
      throw new Error('没有保存的令牌');
    }
    const key = await deriveKey(password, base64ToBytes(payload.salt));
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(payload.iv) },
      key,
      base64ToBytes(payload.data)
    );
    return decoder.decode(decrypted);
  }

  /* ---------------- GitHub API ---------------- */

  function encodePath(path) {
    return String(path || '')
      .split('/')
      .map(segment => encodeURIComponent(segment))
      .join('/');
  }

  async function api(path, options) {
    const opts = options || {};
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    let response;
    try {
      response = await fetch(apiBase() + path, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        cache: 'no-store'
      });
    } catch (err) {
      throw new Error('连不上 GitHub，请检查网络');
    }

    if (!response.ok) {
      let message = '';
      try {
        const data = await response.json();
        message = data.message || '';
      } catch (err) {
        message = '';
      }
      const error = new Error(
        response.status === 401
          ? 'GitHub 令牌无效或已过期，请重新设置'
          : response.status === 403
          ? (message || '没有写入权限') +
            '：令牌需要这个仓库的 Contents 读写权限，且不能过期'
          : response.status === 404
          ? '找不到仓库或分支，请检查 config.js 里的 owner / repo / branch'
          : message || 'GitHub 请求失败（' + response.status + '）'
      );
      error.status = response.status;
      throw error;
    }

    if (response.status === 204) return null;
    return response.json();
  }

  async function verifyToken(token) {
    const user = await api('/user', { token: token });
    return user && user.login ? user.login : 'ok';
  }

  async function verifyRepo(options) {
    const ref = await api(
      repoPath(
        options.owner,
        options.repo,
        '/git/ref/heads/' + encodeURIComponent(options.branch || 'main')
      ),
      { token: options.token }
    );
    return ref && ref.ref ? ref.ref : 'ok';
  }

  function repoPath(owner, repo, suffix) {
    return '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + suffix;
  }

  async function getRemoteJson(options) {
    const path =
      repoPath(options.owner, options.repo, '/contents/' + encodePath(options.path)) +
      '?ref=' + encodeURIComponent(options.branch);
    try {
      const data = await api(path, { token: options.token });
      if (!data || !data.content) return null;
      return JSON.parse(decodeBase64Utf8(data.content));
    } catch (err) {
      if (err && err.status === 404) return null;
      throw err;
    }
  }

  async function getTree(options) {
    const base = repoPath(options.owner, options.repo, '');
    const ref = await api(
      base + '/git/ref/heads/' + encodeURIComponent(options.branch),
      { token: options.token }
    );
    const commit = await api(base + '/git/commits/' + ref.object.sha, {
      token: options.token
    });
    const tree = await api(
      base + '/git/trees/' + commit.tree.sha + '?recursive=1',
      { token: options.token }
    );
    if (!tree || tree.truncated) {
      throw new Error('仓库文件太多，GitHub 返回了不完整的列表，请在电脑上用 git 删除');
    }
    return {
      commitSha: ref.object.sha,
      treeSha: commit.tree.sha,
      items: tree.tree || []
    };
  }

  /**
   * entries:
   *   { path: 'apps/xxx/index.html', content: '<base64>' }
   *   { path: 'files/xxx.zip', remove: true }
   */
  async function commitEntries(options) {
    const entries = options.entries || [];
    const base = repoPath(options.owner, options.repo, '');
    const ref = await api(
      base + '/git/ref/heads/' + encodeURIComponent(options.branch),
      { token: options.token }
    );
    const parentSha = ref.object.sha;
    const parent = await api(base + '/git/commits/' + parentSha, {
      token: options.token
    });
    const baseTree = parent.tree.sha;

    const treeItems = [];
    for (const entry of entries) {
      if (entry.remove) {
        treeItems.push({
          path: entry.path,
          mode: '100644',
          type: 'blob',
          sha: null
        });
        continue;
      }
      const blob = await api(base + '/git/blobs', {
        token: options.token,
        method: 'POST',
        body: { content: entry.content, encoding: 'base64' }
      });
      treeItems.push({
        path: entry.path,
        mode: '100644',
        type: 'blob',
        sha: blob.sha
      });
    }

    const tree = await api(base + '/git/trees', {
      token: options.token,
      method: 'POST',
      body: { base_tree: baseTree, tree: treeItems }
    });
    const commit = await api(base + '/git/commits', {
      token: options.token,
      method: 'POST',
      body: {
        message: options.message || 'Update AppBox',
        tree: tree.sha,
        parents: [parentSha]
      }
    });
    await api(base + '/git/refs/heads/' + encodeURIComponent(options.branch), {
      token: options.token,
      method: 'PATCH',
      body: { sha: commit.sha, force: false }
    });
    return { commitSha: commit.sha, commitTree: tree.sha };
  }

  window.AppBoxGitHub = {
    apiBase: apiBase,
    hashPassword: hashPassword,
    encryptToken: encryptToken,
    decryptToken: decryptToken,
    verifyToken: verifyToken,
    verifyRepo: verifyRepo,
    getRemoteJson: getRemoteJson,
    getTree: getTree,
    commitEntries: commitEntries,
    encodeUtf8Base64: encodeUtf8Base64,
    decodeBase64Utf8: decodeBase64Utf8,
    fileToBase64: fileToBase64,
    bytesToBase64: bytesToBase64,
    base64ToBytes: base64ToBytes
  };
})();
