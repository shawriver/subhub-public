# Security Policy / 安全策略

## 中文

请不要在公开 Issue 中提交密码、API 令牌、订阅链接、节点凭据、数据库、主密钥或 SSH 私钥。发现安全问题时，请通过 GitHub 仓库所有者提供的私密联系方式报告，并附上影响范围、复现条件和修复建议。我们会先确认问题，再协调披露时间。

SubHub 会处理高度敏感的访问凭据。部署时应使用 HTTPS、限制管理接口访问、定期备份数据库及匹配的 `master.key`，并验证主机密钥与依赖版本。

## English

Do not post passwords, API tokens, subscription URLs, node credentials, databases, master keys, or SSH private keys in public issues. Report security issues through the repository owner's private contact channel with impact, reproduction conditions, and suggested mitigation. We will confirm the report and coordinate disclosure.

SubHub handles sensitive access credentials. Deploy behind HTTPS, restrict administrative access, back up the database with its matching `master.key`, and verify host keys and dependency versions.
