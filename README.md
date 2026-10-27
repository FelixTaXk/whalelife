# WhaleLife / whalecore

本地机器人核心 M0：OpenAI 兼容模型、人格、流式 Web 聊天、文件记忆、三路日志和 cordis 插件树。

## 启动

1. 安装 Node.js 24，或将官方 Windows x64 ZIP 解压到 `runtime/node-v24.22.1-win-x64/`（本机已配置）。
2. 用 Node 24 的 npm 执行 `npm ci`。本机依赖已安装。
3. 首次使用时将 `config.example.json` 复制到 `config/config.json`。本机已有私有配置，不要覆盖。
4. 双击 `start.bat`，打开 <http://127.0.0.1:9270>，进入控制台，在「模型服务」选择「对话」或「嵌入」并新增配置，填写服务地址、Key 和实际模型名称。勾选「使用此配置」或到「使用配置」中明确选择。

在启动窗口按 Ctrl+C 优雅退出。控制台保存的模型配置从下一次请求生效；端口、权限、人格文件路径等其他配置修改后重启。默认仅监听本机；局域网监听必须配置 `web.lan_enabled: true` 和 `web.password`。

## 模型控制台

侧栏按概览、模型服务、使用配置、人格配置、聊天测试、插件管理、运行日志组织。模型服务旁的数字只统计已启用、类型已接入且配置有效的模型，不计待修复记录。

人格页可新建或编辑名称、专用模型和人格内容，使用一个保存动作统一提交。“保存”仅保留配置；“保存并启用”指定为当前 Web 聊天人格，并开始新会话，旧记录仍保留。内容保存在人格文件，下一次请求读取；当前人格也可点击“开始新会话测试”，避免旧对话影响观察。聊天标题与头像跟随当前人格。插件管理仅显示扩展插件。页面、样式与请求逻辑拆分在 `core/ui/`，新增页面可接入 `app.js` 的页面注册表。

「模型服务」按模型类型隔离列表。左侧选择一条模型配置，右侧直接编辑完整连接设置。新增时选择对应服务类型；配置名称由用户命名，实际模型名称以服务商文档为准，两者不能混淆。DeepSeek 对话连接不会出现在嵌入服务列表中。历史误配保留为「待修复」，不能被绑定或调用。

支持 OpenAI 兼容协议，以及百炼 DashScope 原生嵌入协议。对话接口为 `/chat/completions`，OpenAI 兼容嵌入接口为 `/embeddings`；DashScope 原生嵌入接口为 `/services/embeddings/text-embedding/text-embedding`。API 根地址可编辑，包含服务要求的版本前缀，并与 Key 的地域一致。

「测试」与「自动检测」使用当前表单中的设置，不会自动保存。嵌入维度记录预期向量长度，自动检测会读取实际返回值并回填，需点击保存；普通测试发现维度不一致会报错。若模型支持缩减输出维度，可在高级参数中填写 OpenAI 的 `dimensions` 或 DashScope 的 `dimension`，随后重新检测。超时（1–600 秒）和可选 HTTP/HTTPS 代理会实际作用于模型请求；代理地址不支持内嵌认证信息。

「使用配置」分别选择对话、Embedding 等用途，以及各人格的对话模型覆盖。没有选择的用途不会自动使用第一条连接。Embedding 当前提供配置、绑定与接口测试，记忆检索尚待后续接入；重排序、图像和语音在模型页明确标注「未接入」。

密钥从不回传到浏览器；编辑时留空保留，勾选清除才删除。更换带密钥连接的 API 地址或协议时需要重新输入或明确清除密钥。保存采用原子替换与版本校验；不同页面或外部文件编辑冲突时会提示刷新。旧版 `providers[].model` 会兼容迁移，第一次保存时写入新的 `models` 和 `model_bindings` 结构。旧配置若共用连接，会明确提示地址、密钥等字段的影响范围；新建配置使用独立连接。

插件可显式调用 `ctx.llm.chat({ model: '<模型配置 ID>', messages })`，模型 ID 对应 `config.models[].id`。配置 ID 与提供方的模型名称是两个字段。

## 配置与记忆

支持多供应商与多人格，Web 通过 `channels.web.persona` 选择人格。人格存放于配置指定的 Markdown 文件，首次启动创建占位人设。

人格内容中的“我”指助手自身。切换人格或修改人格内容后，下一轮使用新的人格上下文；旧对话仍保存在档案中，不再混入本轮历史或摘要。每条新记录保存当时的人格及内容版本，页面中的历史头像不会随当前人格一起变更。

概览与导航统一统计已启用、配置有效的对话和向量模型；运行插件数仅统计扩展插件，进入概览或插件页时同步当前状态。

会话归档为 `memory/sessions/*.jsonl`，索引为 `memory/index.json`，滚动摘要为 `memory/summaries/*.md`，共享事实为 `memory/facts.md`。说“记下这个……”会让模型调用 `remember_fact` 工具。默认允许事实写入；可设置 `permissions.tools.remember_fact` 为 `ask` 或 `off`。会话 `off` 始终禁止工具。M0 的 `ask` 返回需要审批的提示，不会执行副作用。

日志输出到启动窗口、按天追加的日志文件和 Web 日志页。默认文件保留 14 天，Web 缓冲 1000 行。密钥会脱敏。

## 插件

`plugins/<id>/plugin.yaml` 声明 id、name、description、version、depends 和 sub，`index.ts` 导出 `apply(ctx)`。工具、事件与资源通过 `ctx.tools.register`、`ctx.on`、`ctx.effect(() => cleanup)` 注册。父插件可用 `await ctx.plugin(await import('./sub/extra/index.ts'))` 显式加载导出 `id` 的子插件；省略显式加载时按 manifest 的 `sub` 自动扫描。子插件可以继续嵌套。

根插件服务跨根共享；子插件服务仅对本子树可见。`ctx.get(name)` 追踪依赖，缺失时抛错；`ctx.get(name, false)` 为可选查询。卸载时清理资源及工具，父停级联子停，内置插件不可卸载。插件数据通过 `ctx.config()` 读取，`await ctx.config.save(filename, value)` 原子写入本插件 `data/`。无效配置使用空默认值并记录警告。

插件是可信的进程内代码，隔离指受管理生命周期与捕获边界中的异常处理。插件不得创建未登记资源或绕过上下文直接执行异步副作用。

## 验证

使用 Node 24 执行 `npm test` 和 `npm run check`。`node tests/acceptance.ts` 在核心已监听 9270 时进行真实供应商验收（会消耗少量 token，并写入带“验收测试”标记的记忆）。报告和证据在本机 `docs/M0-REPORT.md`、`docs/acceptance/`。

本机需求文档：`docs/HANDOFF-CODEX.md`、`docs/CORE-DESIGN.md`、`docs/PLUGIN-SPEC.md`。QQ、审批流 UI、长期检索记忆与其他核心配置热改留待后续里程碑。控制台改造记录和截图见 `docs/CONSOLE-REPORT.md`、`docs/console-redesign/`。

`docs/`、`memory/`、`logs/`、`config/`、`runtime/` 和插件 `data/` 均不提交。公开配置模板不预选任何提供商或模型。
