# 日常工具箱

一个免登录的中文 React 网站，包含久坐提醒、反应与决策训练、篮球康复科普。所有数据仅保存在当前浏览器。

## 本地运行

需要 Node.js 22.12+（本次验证使用 Node.js 24）与 pnpm。

```powershell
cd daily-toolbox
pnpm install --frozen-lockfile
pnpm dev
```

浏览器打开终端显示的本地地址，默认 `http://127.0.0.1:5173/`。依赖安装完成后，可双击 `启动工具箱.cmd`。页面需要通过本地服务打开，不能直接双击 `index.html`。

## 三个工具

- **久坐提醒**：30 分钟一轮，开始、暂停、继续、重置；到时页面提醒、可选声音和系统通知，可开始下一轮或延后 5 分钟。跨站内路由保持计时，同一标签页刷新恢复。
- **反应与决策**：10 次变色反应；20 题方向选择（四方向和禁止操作各 4 题，每题 2 秒）；篮球和 FPS 各 6 道原创情境题及位置示意、选项解析。键盘、鼠标和触屏分别记录，保存最近 30 组。
- **康复科普**：踝、膝、手指、肩、腰背五篇文章；按部位筛选、正文关键词搜索、收藏、文章直达。逐篇列出急诊及就医信号、初期处理、恢复和复出原则、误区、来源及核对日期。

## 使用边界

- 网站关闭后无法后台提醒。浏览器冻结标签页、电脑休眠、锁屏或系统勿扰会影响提醒；恢复时只补一次，不累计轰炸。
- 仅在浏览器报告为 reload 的同标签刷新时恢复计时；新导航和从页面缓存恢复时重置，复制标签页不会继承计时。个别浏览器可能把崩溃或会话恢复报告为刷新，网页无法对这些浏览器内部行为作绝对保证。
- 音频需要用户手势解锁。刷新后，请点击页面控件再启用声音；系统通知需要 HTTPS 或 localhost、浏览器支持及用户主动授权。不能用声音时页面提醒继续可用。
- 训练计时采用 `performance.now()`，在动画帧中展示信号。结果受到屏幕刷新、系统调度、输入设备和浏览器影响，仅供同设备、同模式、同输入方式的个人比较；不提供实战提升承诺。
- 失焦时暂停正在计时的题目，恢复后重出；已完成题目不丢失。离开训练页结束未完成的训练，不保存半组成绩。
- 康复文章是基于公开患者教育资料编辑的通用科普，未经医疗专业人员独立审阅，不用于诊断、用药处方或个性化康复。伤病恢复与复出需结合专业评估。
- localStorage 保存偏好、收藏、30 组训练记录；sessionStorage 保存当前标签页的提醒状态。前缀统一为 `everyday-toolbox:v1:`。存储被禁用时降级为内存状态并显示提示。清空按钮只删除本工具箱的数据。
- 没有服务端、登录、统计追踪、远程字体或运行时外部内容请求。查看医学来源链接时才会离开本站。

## 页面与维护

路由：`/`、`/reminder`、`/training`、`/rehab`、`/rehab/:slug`。

- `src/core.ts`：计时状态转换、统计、方向计分及数据校验。
- `src/training-engine.ts`：训练状态机、输入锁定、计时和暂停恢复。
- `src/store.ts`：本地数据、全局计时、可选通知与 WebMCP 只读状态工具。
- `src/data/scenarios.ts`：12 道原创情境题，每题包含三选一、每个选项的解释和示意图节点。
- `src/data/rehab.ts`：五篇科普正文、就医信号、关键词与逐篇来源。

## 构建与检查

```powershell
pnpm build
pnpm test
# 先保持 pnpm dev 运行，再在另一个终端执行：
pnpm test:browser
pnpm test:edges
```

`pnpm build` 先检查 TypeScript，再生成 `dist/`。可用 `pnpm preview` 检查生产构建。也可直接运行 `node node_modules/typescript/bin/tsc --noEmit`、`node node_modules/vite/bin/vite.js build`、`node --test tests/core.test.mjs`、`node tests/browser.mjs`。

浏览器测试默认使用 Windows 上已安装的 Microsoft Edge；其他系统使用 Playwright Chromium，需要事先安装浏览器。通过 `TOOLBOX_URL` 指定测试地址。截图放在忽略的 `.qa/` 目录。

## 发布

已包含 GitHub Pages 自动部署配置。推送到 `main` 后，工作流会检查、构建和发布。首次使用需在仓库 Settings → Pages 中选择 GitHub Actions，详见 [GitHub Pages 发布说明](GITHUB_PAGES.md)。

Pages 版本使用 `#/reminder`、`#/training`、`#/rehab` 形式的链接，可以直接分享和刷新。普通 `pnpm build` 版本仍使用路径路由，需要静态服务器配置 SPA 回退。

## Chrome 扩展：小乐收集

新增两个独立 Chrome 扩展，源码、安装包与配置说明见 [小乐收集](extensions/xiaole-collector/README.md)。

- **视频采集**：抖音与 B站视频、主页作品采集，导出、飞书同步与可配置的百炼转写。
- **评论助手**：抖音一级评论自动采集，默认采集到页面末尾（最多10万条），刷新续采、去重、排序和 CSV 导出。

[下载两个工具的组合包](extensions/xiaole-collector/downloads/xiaole-collector-bundle-v1.0.2.zip) · [个人网站使用说明](https://jingle-personal-0924.jl2536153560.chatgpt.site/xiaole.html)

公开版需要填写使用者自己的飞书连接与转写配置，不包含个人授权或预设私人资料库。