# 发布到 GitHub Pages

本项目可以作为独立仓库发布，仓库根目录应直接包含 `package.json`、`src/`、`.github/` 和 `.env.github-pages`。建议仓库名：`daily-toolbox`。

## 自动部署

1. 创建公开仓库，将本目录的源码推送到 `main` 分支。
2. 在仓库 **Settings → Pages → Build and deployment → Source** 中选择 **GitHub Actions**。
3. 打开 **Actions → Publish toolbox to GitHub Pages**，等待推送触发的部署完成；如果设置 Pages 前的首次运行失败，设置完成后重新运行。
4. 从成功的部署或 Settings → Pages 复制实际网站地址。

工作流使用锁定的依赖和官方 Actions：执行核心测试、构建 Pages 专用版本、在无 SPA 回退的静态服务器上检查所有分享链接和刷新，然后上传 `pages-dist/` 并部署。只有部署任务有 Pages 写权限，不需要在仓库中保存个人令牌。

## 给别人分享

部署成功后，网站首页可直接使用。三个工具也能通过各自的链接单独打开，地址结构为网站首页之后的：

- `#/reminder`：久坐提醒。
- `#/training`：反应与决策训练。
- `#/rehab`：康复知识。

例如，某个已发布首页地址后面加上 `#/rehab/ankle`，即可分享踝关节文章。`#` 后面的内容由浏览器处理，因此刷新文章也不需要服务器重写规则。

每位使用者的计时、训练和收藏保存在自己的浏览器中，不会共享，也不会上传 GitHub。关闭页面后，网页提醒停止。

## 本地验证发布版本

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm build:pages
pnpm test:pages
```

`test:pages` 会临时启动只服务构建文件的静态服务器，并检查 `/daily-toolbox/` 子目录下的首页、三个工具及五篇文章。测试结束后自动关闭服务。Windows 使用已安装的 Edge；其他系统先运行 `pnpm exec playwright install chromium`。

`pnpm build` 仍生成使用普通路径的 `dist/`，适合配置了 SPA 回退的静态托管环境；`pnpm build:pages` 使用哈希路由和相对资源路径，生成独立的 `pages-dist/`。

参考：[GitHub 自定义 Pages 工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)、[Vite 静态部署](https://vite.dev/guide/static-deploy)。
