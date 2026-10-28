# Architecture / 项目结构

## 中文

SubHub 是一个嵌入式 Go Web 应用：Go 后端负责认证、SQLite 存储、加密凭据、订阅导出和后台任务；React 前端由 esbuild 打包后嵌入同一二进制。

| 路径 | 用途 |
|---|---|
| `main.go`, `server.go`, `account.go`, `auth.go` | 启动、路由、账户与安全边界 |
| `store.go`, `records.go`, `backup.go` | SQLite 记录、输入校验和加密备份 |
| `subscriptions.go`, `export.go`, `panel.go`, `sync.go` | 订阅、节点导出与 3x-ui 同步 |
| `komari.go`, `traffic.go`, `cycles.go` | 监控关联、流量和额度周期 |
| `web/src/` | React 页面、主题和前端 API 客户端 |
| `tests/e2e/` | Playwright 浏览器验收脚本 |
| `archive/frontend/` | 仅供历史参考、当前不参与构建的旧前端 |

运行数据不进入仓库。`master.key`、SQLite、面板凭据、订阅令牌和 SSH 私钥都属于部署环境，不属于源码。

## English

SubHub is a single embedded Go web application. The Go backend handles authentication, SQLite storage, encrypted credentials, subscription export, and background jobs. The React frontend is bundled with esbuild and embedded into the same binary.

| Path | Purpose |
|---|---|
| `main.go`, `server.go`, `account.go`, `auth.go` | Startup, routes, accounts, and security boundaries |
| `store.go`, `records.go`, `backup.go` | SQLite records, validation, and encrypted backups |
| `subscriptions.go`, `export.go`, `panel.go`, `sync.go` | Subscriptions, node exports, and 3x-ui synchronization |
| `komari.go`, `traffic.go`, `cycles.go` | Monitoring links, traffic, and quota cycles |
| `web/src/` | React pages, theme, and frontend API client |
| `tests/e2e/` | Playwright browser acceptance scripts |
| `archive/frontend/` | Legacy frontend kept for reference and excluded from builds |

Runtime data never belongs in the repository. `master.key`, SQLite files, panel credentials, subscription tokens, and SSH private keys belong to the deployment environment.
