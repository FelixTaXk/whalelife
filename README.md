# WhaleLife / whalecore

本地机器人主干：模型 API 配置、LLM 人格与记忆、插件运行与调用、日志与权限、统一配置和管理入口。平台与业务能力由插件实现。

**了解目前做到了哪里，先读[主干现状与开发说明](architecture/STATUS.md)。** 该文档统一记录能力清单、实际调用链、代码分工、数据归属、验证证据与现存问题；本页只负责启动和导航，不另维护一份状态清单。

## 启动

1. 使用Node.js 24。本机提供 runtime/node-v24.22.1-win-x64/，系统Node 20不适用。
2. 用Node 24环境执行 npm ci 安装依赖；已安装时无需重复。
3. 首次运行将 config.example.json 复制为 config/config.json；已有配置不可覆盖。
4. 运行 start.bat，或在Node 24终端执行 npm start，打开本地控制台 http://127.0.0.1:9270 。
5. 在模型服务中配置自己的连接和模型，到使用配置/人格页明确选择对话模型和人格。公开模板不预选真实服务。

默认仅监听本机；局域网访问需配置web.lan_enabled与密码。Ctrl+C触发退出。控制台保存的模型和人格选择供后续请求读取；端口等启动参数变更需重启。安装插件独立执行，清理超时后主干终止其进程。

## 文档分工

| 入口 | 负责的内容 |
| --- | --- |
| [主干现状与开发说明](architecture/STATUS.md) | 整体能力、当前架构、源码地图、统一问题表及验证范围 |
| [开发硬约束](AGENTS.md) | 主干/插件职责、独立升级、兼容和故障切割要求 |
| [插件扩展契约](architecture/PLUGINS.md) | 插件可用接口、生命周期、页面、事件与调用语义 |
| [记忆系统](architecture/MEMORY.md) | 存储、短期/长期、认知修订、检索与成本规则 |
| [现有渠道接口](architecture/CHANNELS.md) | 已实现的绑定、收发、回执和来源约定 |
| [插件开发规则](plugins/AGENTS.md) | 插件会话的修改范围和约束 |

本机开发者另读 docs/HANDOFF-CODEX.md 或 docs/HANDOFF-PLUGINS.md。早期设计稿、阶段报告保留为历史材料，不覆盖当前代码和公开契约。

## 开发与验证

- 核心与插件分别维护，禁止通过修改对方内部实现完成自己的功能。
- 使用Node 24执行 npm run check。契约/生命周期改动执行 npm run test:compat，其他按影响范围选择测试；npm test运行自动化测试文件。
- [冻结旧插件样本](tests/fixtures/plugin-contract/2026-10-29/README.md)不得为了迁就主干升级而修改；可维护演示位于 examples/plugins/，不会默认安装。
- tests/acceptance.ts及真实模型验收脚本不是日常回归入口，不要用正式记忆或真实模型跑普通测试。
- 当前远端CI未启用，原因与已有验证结果统一记录在主干说明。

## 私有数据

docs/、config/、memory/、logs/、runtime/、备份和插件data不提交。实际密钥由用户配置；公开示例不得包含真实账号、记忆或凭据。不要覆盖已有配置或为了测试安装演示插件到正式plugins目录。
