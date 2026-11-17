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
  tagline: '我做的小程序，都放在这里',
  subTagline: '程序存在 AppBox 里，打开就能用，每个都附带使用方法。',
  footer: '个人程序盒子 · 持续更新中',

  /* GitHub 仓库信息：上线前填成你自己的 */
  owner: 'feifeigongzhu123',
  repo: 'AppBox',
  branch: 'main',

  /* 上传密码的哈希（对应初始设置的密码） */
  passwordHash: 'c8a61914d87b314743168483ab8c5b62321ce560d3909f09926bb2591a223576'
};
