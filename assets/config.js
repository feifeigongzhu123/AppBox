/* ==========================================================================
   AppBox 配置
   --------------------------------------------------------------------------
   mode: 'github'  GitHub Pages 免费上线（上传通过 GitHub API 提交到仓库）
     'server'  本地 server.py（上传保存到本机 apps/ 和 files/）

   改上传密码后，需要重新生成 passwordHash：
     python -c "import hashlib;print(hashlib.sha256(('appbox-v1:'+'新密码').encode('utf-8')).hexdigest())"
   把结果填到下面的 passwordHash 即可。改密码后，浏览器里保存的 GitHub 令牌会失效，需要重新粘贴一次。
   ========================================================================== */

window.APPBOX_CONFIG = {
  mode: 'github',

  /* 站点名称，可自行修改 */
  siteName: 'AppBox',
  siteMark: '▦',
  author: '安得半日闲',
  tagline: '我做的小程序，都放在这里',
  subTagline: '零广告 · 免注册 · 手机 / iPad 点开即用',
  footer: '个人程序盒子 · 持续更新中',

  /* 点击统计的虚拟路径前缀；Vercount 按路径区分程序 */
  statsBase: 'https://feifeigongzhu123.github.io/AppBox/',
  /* 改一个值即可从 0 重新统计 */
  statsVersion: '20261126',

  /* 点击次数使用 Vercount 公开计数器，无需额外配置 */

  /* GitHub 仓库信息：上线前填成你自己的 */
  owner: 'feifeigongzhu123',
  repo: 'AppBox',
  branch: 'main',

  /* 上传密码的哈希（对应初始设置的密码） */
  passwordHash: 'c8a61914d87b314743168483ab8c5b62321ce560d3909f09926bb2591a223576'
};
