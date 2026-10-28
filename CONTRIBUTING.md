# Contributing / 参与贡献

## 中文

1. 从 `main` 创建功能分支，保持提交范围单一。
2. 前端修改运行 `npm ci && npm run build`。
3. Go 修改运行 `go test ./...` 和 `go vet ./...`。
4. 浏览器验收脚本位于 `tests/e2e/`，使用 `SUBHUB_TEST_BASE` 指定一次性实例。
5. 不得提交数据库、主密钥、面板令牌、订阅链接、SSH 私钥或真实用户截图。
6. 行为变化需要同步更新 `README.md`、`CHANGELOG.md` 和相关测试。

提交前请检查 `git diff --check`，并说明验证方式、已知限制和回滚影响。

## English

1. Branch from `main` and keep each change focused.
2. Run `npm ci && npm run build` after frontend changes.
3. Run `go test ./...` and `go vet ./...` after Go changes.
4. Browser acceptance scripts live in `tests/e2e/`; point `SUBHUB_TEST_BASE` at a disposable instance.
5. Never commit databases, master keys, panel tokens, subscription URLs, SSH private keys, or screenshots containing real users.
6. Update `README.md`, `CHANGELOG.md`, and relevant tests when behavior changes.

Run `git diff --check` before submitting, and describe validation, known limits, and rollback impact.
