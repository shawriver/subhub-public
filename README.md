# SubHub

[中文](#中文) · [English](#english)

## 中文

SubHub 是一个自托管的订阅与节点管理面板，面向个人实验室、家庭网络和小型团队。它将服务器、代理节点、用户、订阅、流量额度、后台任务和只读状态页集中在一个 Go 二进制中，并通过 3x-ui API 与 Komari 监控协同工作。

> **项目定位**：SubHub 管理订阅和节点授权，不包含 VPS、3x-ui、Xray、Komari 或代理协议的安装器。部署前应自行准备并验证这些基础设施。

### 功能

- 管理服务器、节点、用户、可复用订阅和个人订阅。
- 通过 3x-ui API 同步独立用户凭据、流量与授权状态。
- 导出 Mihomo/Clash YAML 和 V2Ray Base64 订阅，支持订阅令牌轮换与撤销。
- 配置订阅默认并发连接策略与用户覆盖值，并明确展示当前协议栈的执行边界。
- 提供加密备份、恢复预览、审计日志、后台任务和只读公开状态页。
- 使用浏览器测量节点连接延迟；可配置 Komari 只读监控与公开机器状态。
- 支持深色、浅色、系统主题、可调透明度与自定义品牌。

### 技术栈

Go 1.26、SQLite、React 19、esbuild、3x-ui v3 API、Komari。

### 快速开始

```bash
npm ci --no-audit --no-fund
npm run build
go test ./...
go build -trimpath -o subhub .
./subhub -data ./data -listen 127.0.0.1:18440 -origin http://127.0.0.1:18440
```

首次启动后，使用部署过程中签发的一次性管理员设置链接完成初始化。生产环境请通过 HTTPS 反向代理暴露服务，并让应用监听 loopback。

Komari 地址可以通过启动参数或环境变量配置：

```bash
export SUBHUB_KOMARI_URL=https://monitor.example.com
./subhub -data /var/lib/subhub -listen 127.0.0.1:18440 -origin https://subhub.example.com -komari-url "$SUBHUB_KOMARI_URL"
```

参考 `.env.example`。请勿将 `.env.local`、数据库、`master.key`、面板令牌、订阅链接或 SSH 私钥提交到仓库。

### 项目结构

| 路径 | 说明 |
|---|---|
| `main.go`, `server.go`, `account.go`, `auth.go` | 启动、路由、账户与安全边界 |
| `store.go`, `records.go`, `backup.go` | SQLite 记录、校验与加密备份 |
| `subscriptions.go`, `export.go`, `panel.go`, `sync.go` | 订阅、导出、面板和同步 |
| `komari.go`, `traffic.go`, `cycles.go` | 监控、流量和额度周期 |
| `web/src/` | React 前端 |
| `tests/e2e/` | Playwright 浏览器验收 |
| `archive/frontend/` | 未参与构建的历史前端资料 |

详细说明见 [架构文档](docs/ARCHITECTURE.md)。

### 安全边界

- 管理员会话使用 HTTP-only Cookie；修改操作要求同源请求头。
- 面板令牌和节点凭据加密存储，备份需要独立口令。
- 公开状态 API 使用独立字段白名单，不暴露地址、用户、订阅链接或节点凭据。
- 外部导入的机场订阅和部分共享凭据节点无法由 SubHub 强制管理。
- 当前 3x-ui 版本没有通用的“每用户 TCP 并发连接数”接口，因此订阅连接上限是策略记录，不等同于协议层强制拦截。

发现安全问题请阅读 [安全策略](SECURITY.md)，不要在公开 Issue 中发布敏感信息。

### 开发与测试

```bash
npm run build
go vet ./...
go test ./...
git diff --check
```

浏览器验收脚本位于 `tests/e2e/`。使用 `SUBHUB_TEST_BASE` 指向一次性实例，测试数据必须与生产环境隔离：

```bash
export SUBHUB_TEST_BASE=http://127.0.0.1:18440
node tests/e2e/public-wall-check.cjs
```

参与贡献前请阅读 [贡献指南](CONTRIBUTING.md) 与 [行为准则](CODE_OF_CONDUCT.md)。更新记录见 [CHANGELOG.md](CHANGELOG.md)。

### 许可证

本项目采用 [MIT License](LICENSE)。

## English

SubHub is a self-hosted subscription and node management panel for personal labs, home networks, and small teams. It combines servers, proxy nodes, users, subscriptions, traffic allowances, background jobs, and a read-only status page in one Go binary, with optional 3x-ui and Komari integration.

> **Scope**: SubHub manages subscriptions and node authorization. It is not an installer for VPS infrastructure, 3x-ui, Xray, Komari, or proxy protocols.

### Features

- Manage servers, nodes, users, reusable subscriptions, and personal subscriptions.
- Synchronize independent credentials, traffic, and authorization through the 3x-ui API.
- Export Mihomo/Clash YAML and V2Ray Base64 subscriptions with rotatable, revocable tokens.
- Define subscription connection policies with optional per-user overrides and clear capability boundaries.
- Use encrypted backups, restore previews, audit logs, background tasks, and an optional public status page.
- Measure node latency from the administrator's browser and integrate optional Komari monitoring.
- Switch between dark, light, and system themes with configurable surface opacity and branding.

### Stack

Go 1.26, SQLite, React 19, esbuild, the 3x-ui v3 API, and Komari.

### Quick Start

```bash
npm ci --no-audit --no-fund
npm run build
go test ./...
go build -trimpath -o subhub .
./subhub -data ./data -listen 127.0.0.1:18440 -origin http://127.0.0.1:18440
```

Complete the one-time administrator setup link after the first launch. In production, expose SubHub through an HTTPS reverse proxy and keep the application listener on loopback.

Set the Komari URL with a flag or environment variable:

```bash
export SUBHUB_KOMARI_URL=https://monitor.example.com
./subhub -data /var/lib/subhub -listen 127.0.0.1:18440 -origin https://subhub.example.com -komari-url "$SUBHUB_KOMARI_URL"
```

See `.env.example`. Never commit `.env.local`, databases, `master.key`, panel tokens, subscription URLs, or SSH private keys.

### Repository Layout

| Path | Purpose |
|---|---|
| `main.go`, `server.go`, `account.go`, `auth.go` | Startup, routes, accounts, and security boundaries |
| `store.go`, `records.go`, `backup.go` | SQLite records, validation, and encrypted backups |
| `subscriptions.go`, `export.go`, `panel.go`, `sync.go` | Subscriptions, exports, panels, and synchronization |
| `komari.go`, `traffic.go`, `cycles.go` | Monitoring, traffic, and quota cycles |
| `web/src/` | React frontend |
| `tests/e2e/` | Playwright browser acceptance |
| `archive/frontend/` | Historical frontend material excluded from builds |

See [Architecture](docs/ARCHITECTURE.md) for more detail.

### Security Boundaries

- Administrator sessions use HTTP-only cookies, and mutations require a same-origin request header.
- Panel tokens and node credentials are encrypted; portable backups require a separate passphrase.
- The public status API uses a dedicated field allowlist and omits addresses, users, subscription URLs, and node credentials.
- Imported airport subscriptions and some shared-credential nodes cannot be fully controlled by SubHub.
- Current 3x-ui versions do not expose a general per-user TCP concurrent-connection counter. Subscription limits are policy metadata, not native enforcement.

Read [SECURITY.md](SECURITY.md) before reporting a vulnerability, and do not publish sensitive information in public issues.

### Development and Testing

```bash
npm run build
go vet ./...
go test ./...
git diff --check
```

Browser acceptance scripts live in `tests/e2e/`. Point `SUBHUB_TEST_BASE` at a disposable instance and keep test data separate from production:

```bash
export SUBHUB_TEST_BASE=http://127.0.0.1:18440
node tests/e2e/public-wall-check.cjs
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before contributing. See [CHANGELOG.md](CHANGELOG.md) for release notes.

### License

[MIT License](LICENSE)
