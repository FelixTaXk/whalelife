# WhaleLife / whalecore

本地机器人核心 M0：OpenAI 兼容模型、人格、流式 Web 聊天、文件记忆、三路日志和 cordis 插件树。

## 启动

1. 安装 Node.js 24，或将官方 Windows x64 ZIP 解压到 `runtime/node-v24.22.1-win-x64/`（本机已配置）。
2. 用 Node 24 的 npm 执行 `npm ci`。本机依赖已安装。
3. 将 `config.example.json` 复制到 `config/config.json`，填写模型密钥。本机已有私有配置，不要覆盖。
4. 双击 `start.bat`，打开 <http://127.0.0.1:9270>，点击登录。

在启动窗口按 Ctrl+C 优雅退出。修改配置后重启。默认仅监听本机；局域网监听必须配置 `web.lan_enabled: true` 和 `web.password`。

## 配置与记忆

支持多供应商与多人格，Web 通过 `channels.web.persona` 选择人格。人格存放于配置指定的 Markdown 文件，首次启动创建占位人设。

会话归档为 `memory/sessions/*.jsonl`，索引为 `memory/index.json`，滚动摘要为 `memory/summaries/*.md`，共享事实为 `memory/facts.md`。说“记下这个……”会让模型调用 `remember_fact` 工具。默认允许事实写入；可设置 `permissions.tools.remember_fact` 为 `ask` 或 `off`。会话 `off` 始终禁止工具。M0 的 `ask` 返回需要审批的提示，不会执行副作用。

日志输出到启动窗口、按天追加的日志文件和 Web 日志页。默认文件保留 14 天，Web 缓冲 1000 行。密钥会脱敏。

## 插件

`plugins/<id>/plugin.yaml` 声明 id、name、description、version、depends 和 sub，`index.ts` 导出 `apply(ctx)`。工具、事件与资源通过 `ctx.tools.register`、`ctx.on`、`ctx.effect(() => cleanup)` 注册。父插件可用 `await ctx.plugin(await import('./sub/extra/index.ts'))` 显式加载导出 `id` 的子插件；省略显式加载时按 manifest 的 `sub` 自动扫描。子插件可以继续嵌套。

根插件服务跨根共享；子插件服务仅对本子树可见。`ctx.get(name)` 追踪依赖，缺失时抛错；`ctx.get(name, false)` 为可选查询。卸载时清理资源及工具，父停级联子停，内置插件不可卸载。插件数据通过 `ctx.config()` 读取，`await ctx.config.save(filename, value)` 原子写入本插件 `data/`。无效配置使用空默认值并记录警告。

插件是可信的进程内代码，隔离指受管理生命周期与捕获边界中的异常处理。插件不得创建未登记资源或绕过上下文直接执行异步副作用。

## 验证

使用 Node 24 执行 `npm test` 和 `npm run check`。`node tests/acceptance.ts` 在核心已监听 9270 时进行真实供应商验收（会消耗少量 token，并写入带“验收测试”标记的记忆）。报告和证据在本机 `docs/M0-REPORT.md`、`docs/acceptance/`。

本机需求文档：`docs/HANDOFF-CODEX.md`、`docs/CORE-DESIGN.md`、`docs/PLUGIN-SPEC.md`。QQ、审批流 UI、长期检索记忆与配置热改留待后续里程碑。

`docs/`、`memory/`、`logs/`、`config/`、`runtime/` 和插件 `data/` 均不提交。公开配置模板仅含占位密钥。
