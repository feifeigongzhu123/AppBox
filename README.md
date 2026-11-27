# AppBox · 个人程序盒子

> 作者：安得半日闲

一个可以免费挂在 **GitHub Pages** 上的个人「应用商店」：网页程序在线打开，安装包/压缩包提供下载，
每个程序都带介绍和使用方法。上传需要在浏览器里输入密码。

不需要服务器、不需要数据库。上传时，页面通过 GitHub API 把文件提交到你自己的仓库，Pages 自动发布。

## 上线三步

1. **建公开仓库**：在 GitHub 新建仓库（建议叫 `AppBox`），把整个项目推上去。
   免费账号的 Pages 只能发布公开仓库，所以程序源码和文件都是公开的。
2. **打开 Pages**：仓库 Settings → Pages → Source 选 `Deploy from a branch`，
   分支 `main`，目录 `/(root)`，保存。
3. **填仓库信息**：打开 `assets/config.js`，保持 `mode: 'github'`，把 `owner` 填成你的用户名，
   `repo` 填仓库名，推送。站点地址是 `https://用户名.github.io/仓库名/`。

## 上传程序

1. 打开站点的「上传」页，输入上传密码。
2. 第一次还要粘贴一个 GitHub **细粒度令牌**：
   GitHub 头像 → Settings → Developer settings → Personal access tokens → Fine-grained tokens，
   只授权当前仓库，权限设 `Contents: Read and write`。
3. 选类型、填信息、上传，点「上传并发布」。
4. Pages 大约 1 分钟后更新，可在仓库 Actions 里看进度。

令牌只保存在当前浏览器的 `localStorage` 里，并用上传密码加密，**不会写进仓库**，也不会发到第三方服务器。
换电脑或换密码时重新粘贴一次。

### 修改上传密码

`assets/config.js` 只保存密码的 SHA-256 哈希，不存明文。改密码时运行：

```bash
python -c "import hashlib;print(hashlib.sha256(('appbox-v1:'+'新密码').encode('utf-8')).hexdigest())"
```

把结果填进 `passwordHash`。改完后，浏览器里保存的令牌会解密失败，需要重新粘贴一次。
密码只用于本机解锁和令牌加密，真正阻止别人写入的是 GitHub 令牌；建议用足够长的密码。

## 目前挂上的程序

| 程序 | 地址 | 打开方式 |
| --- | --- | --- |
| 志愿宝 build 1126f | https://feifeigongzhu123.github.io/zhiyuanbao/ | 站内嵌入 / 新窗口 |
| 物理动画课 1.0.0 | https://feifeigongzhu123.github.io/physics-course/ | 站内嵌入 / 新窗口 |
| 化学动画课 1.2.0 | https://feifeigongzhu123.github.io/chemistry-course/ | 站内嵌入 / 新窗口 |
| 英语背单词 1.9.0 | https://feifeigongzhu123.github.io/english-daily/ | 站内嵌入 / 新窗口 |
| 越词通 1.1.0 | https://feifeigongzhu123.github.io/viet-daily/ | 站内嵌入 / 新窗口 |
| 我的大学 2026.11 | https://feifeigongzhu123.github.io/universities/ | 站内嵌入 / 新窗口 |

这六个程序已经部署在同一个 GitHub Pages 账号下，AppBox 只负责展示、搜索和使用说明。
`data/apps.json` 里它们的 `kind` 是 `web`，`url` 是完整网址，所以详情页会优先在站内窗口打开。

详情页会读取各站点的 `VERSION` 文件，自动更新显示的版本号。应用内容本身是直接嵌入原网址，
升级部署后打开就是新版；浏览器或 Service Worker 可能缓存旧资源，站内窗口右上角有「刷新」按钮。

## 使用统计

卡片和详情页的「点击次数」来自 [Vercount](https://vercount.one) 公共计数器，无需注册、没有 Cookie。
按进入程序详情页的次数累计；同一人多次进入会重复计数，**不是独立访客数**。
数字会缓存在本机，统计服务不可用时保留上次结果或显示「—」，不影响页面。
新访客第一次看不到数字时，进入一次程序详情就会获取并显示。
计数路径带 `statsVersion`（`assets/config.js`），换一个值即可从 0 重新统计。

## 首次打开较慢

网页程序第一次打开要下载页面、脚本和音频，站内窗口会显示「正在加载…」。
之后浏览器和应用自己的缓存会保留资源；支持离线的应用断网也能用。需要强制更新时，点站内窗口右上角的「刷新」。

应用打开很快时，加载提示会延迟 200ms 才出现，避免只闪一下。

### 应用就绪信号（可选）

如果应用希望在「真正准备好」时再关闭加载提示，可以在页面里通知 AppBox：

```js
if (window.parent !== window) {
  window.parent.postMessage({ type: 'appbox-ready', app: 'yingcitong' }, '*');
}
```

`app` 用 `data/apps.json` 里的 `id`。AppBox 只接受来自当前嵌入窗口的消息；
没有这个信号时，就回退到 iframe 的 load 事件。

## 三种程序类型

| 类型 | 上传内容 | 访客看到 |
| --- | --- | --- |
| 网页程序 | 整个程序文件夹，最外层有 `index.html` | 「打开程序」，站内窗口运行，也可新窗口打开 |
| 外部网址 | 一个 `https://` 地址 | 「打开链接」，新窗口跳转 |
| 可下载文件 | exe / apk / zip / 文档等 | 「下载程序」，从仓库下载 |

## 目录结构

```
AppBox/
├─ index.html              商店首页 + 详情页 + 上传页 + 使用指南
├─ .nojekyll               告诉 GitHub Pages 不要用 Jekyll 处理
├─ assets/
│  ├─ config.js            ★ 模式、仓库名、上传密码哈希
│  ├─ github.js            GitHub API、密码哈希、令牌加密
│  ├─ app.js               页面逻辑
│  └─ style.css
├─ data/
│  ├─ apps.json            ★ 已发布程序的列表
│  └─ admin-token.txt      本地模式的密码（不提交到仓库）
├─ apps/                   上传的网页程序目录（当前为空）
│  └─ .gitkeep
├─ files/                  可下载文件
├─ server.py               可选：本地预览服务器
├─ start.bat               本地启动
└─ README.md
```

## 免费额度（GitHub）

- Pages 站点：不超过 **1 GB**，带宽约 **100 GB/月**（软限制）
- 仓库单文件：**100 MB** 上限，超过 50 MB 会警告
- 上传页把单个文件限制在 **50 MB**，整个网页程序限制在 **100 MB**
- 更大的安装包请放到 **GitHub Releases**（单文件小于 2 GiB），再在商店里用「外部网址」链接过去

## 本地预览（可选）

不联网也能调页面：

1. 把 `assets/config.js` 的 `mode` 改成 `'server'`。
2. 双击 `start.bat`，访问 http://localhost:8080 。
3. 本地模式下，上传保存在 `apps/` 和 `files/`，列表在 `data/apps.json`；
   上传密码是 `data/admin-token.txt` 里的内容。
4. 调好后把 `mode` 改回 `'github'`，`git push` 即可上线。

## 备份

所有内容都在仓库里：`apps/`、`files/`、`data/apps.json`。
备份就是 `git clone`，换电脑不会丢。

## 安全说明

- 仓库里没有密码明文，也没有 GitHub 令牌；令牌只在你自己的浏览器里加密保存。
- 上传页是纯前端实现，密码校验可以被绕过，但没有令牌仍然无法写入仓库。
- 上传的网页程序与商店同源运行，只上传你自己信任的程序。
- 如果公开站点被恶意使用，直接删除 GitHub 令牌即可让上传失效。

## 免责声明

本站为个人学习作品展示，所有程序免费提供，仅供学习交流，不作商业用途。
程序中的教材、词表、图片、音频等版权归原出版社或权利人所有；如有侵权，请通过
[GitHub Issues](https://github.com/feifeigongzhu123/AppBox/issues) 联系删除。
站内嵌入的第三方页面由其各自站点负责，本站不对其内容、可用性或使用后果承担责任。
