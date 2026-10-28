# Changelog / 更新记录

All notable public changes are documented here. 中文说明优先，英文摘要随后。

## Unreleased

### 中文

- 重新整理任务与备份页：增加四项运行概览，将同步控制与备份操作并排，任务列表与审计日志按操作顺序排列。
- 任务页支持顶部搜索，桌面和手机布局均重新验证。
- 默认配置改用通用示例域名，生产地址和 Komari 地址通过启动参数或环境变量配置。
- 浏览器验收脚本迁移到 `tests/e2e/`，旧版未引用前端文件迁移到 `archive/frontend/`。
- 补齐开源许可证、贡献指南、安全策略、行为准则和持续集成配置。

### English

- Reorganized Tasks & Backups into an overview, a sync/backup control row, task records, and a dedicated audit section.
- Added task search and verified desktop and mobile layouts.
- Replaced personal defaults with generic examples; deployment URLs now come from flags or environment variables.
- Moved browser checks to `tests/e2e/` and unreferenced legacy frontend files to `archive/frontend/`.
- Added license, contribution, security, conduct, and CI files.

## 0.2.11

- Subscription management, panel synchronization, encrypted backups, public status, device estimates, node latency checks, and subscription connection policies.
