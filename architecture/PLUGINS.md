# 插件扩展契约

本文描述当前实现。插件作者以本文、`core/context.ts` 和可运行示例为入口，不依赖私有设计稿，也不需要修改核心菜单、平台判断或记忆结构。

尚未完成的扩展能力与已知边界集中记录在 [STATUS.md](STATUS.md)。尤其新模型协议/用途尚无插件注册适配器契约，不能由本文推断全部未来模型能力已支持插件化接入。

## 设计原则

WhaleLife 是独立于交流平台的机器人。主干统一提供模型、人格、会话、工具、记忆、渠道传输及插件生命周期。插件扩展能力和业务；各平台通过注册接入，核心不维护平台名称的条件分支。

会话承载持续经历，切换人格不创建会话。各会话默认独立，可显式共享上下文或记忆空间。共享事实仅用户可编辑；模型只能编辑本会话的独立事实，整份正文硬限制100个Unicode码点。经历记录来源和实际结果；意图、计划及自主执行策略由主动性插件引入，未安装时核心不运行自主意图循环。

插件自行决定模型调用时机、频率、预算、是否限额、超额处理及重试策略。核心不统一扣减或限制插件额度。核心聊天和记忆整理有各自的统计；插件直接调用 `ctx.llm` 不会自动纳入会话账本，用量由返回值交给插件处理。

## 安装、归属与停用

`plugins/<id>/plugin.yaml` + `index.ts`，导出 `apply(ctx)`。配置位于本插件 `data/`，读取与保存使用 `ctx.config.read(file?)`、`ctx.config.save(file,value)`；缺省文件为manifest配置或`config.json`。JSON损坏会记录日志并读为空对象，插件要校验字段、呈现初始化状态，不能静默填入真实账号或替用户选择模型。

用 `ctx.provide/get` 暴露和使用插件服务，manifest的 `depends` 声明必需依赖。停用选择会持久化；父子与依赖级联的规则见README。插件能力接口绑定完整插件ID；`ctx.get('web'|'tools'|'llm'|'memory'|'channels'|'models'|'personas'|'sessions')` 与对应属性使用同一封装。

`ctx.signal` 在停用、加载失败、重载旧实例和核心关闭时取消。定时器、连接、文件句柄和异步工作要通过 `ctx.effect(() => cleanup)` 管理，并将signal传到自己的请求。模型请求、工具执行和插件Web处理器已传递signal。旧实例不能继续注册入口、保存配置或发起模型调用；旧回调的迟到失败不会误停新实例。

插件是同进程可信代码，完整执行权限不构成操作系统提权。核心无法强制撤回已经发生的外部操作，也无法让忽略signal且永不返回的插件任务成功结束。工具实际返回成功就记录成功，不能因停用伪报撤销。

## 设置页与独立页面

```ts
ctx.web.page('/plugins/example/settings', (req, res, { signal }) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('插件自己的设置页面');
}, { title: '示例设置', settings: true, navigation: true });

ctx.web.api('/plugins/example/config', async (req, res, { signal }) => {
  // 解析并限制请求大小、校验字段、读写 ctx.config，最后 res.end(...)
});
```

第三参数可选。`settings:true` 在插件卡片添加设置按钮（每个插件一个）；`navigation:true` 添加侧栏入口。两者可独立使用。页面在控制台内展示，页面内容和表单由插件负责。未注册页面的插件不显示空设置按钮。静态脚本、样式等也可用无入口参数的 `page` 注册。

路径必须在 `/plugins/<完整插件ID>/` 下，不包含查询串、编码绕行或路径跳转。请求按pathname匹配，查询参数从`req.url`读取。全部继承控制台登录和来源校验；页面和接口在插件停用/失败时撤销，进行中的请求收到signal。控制台刷新、切页或重新聚焦会更新入口；设置页内普通聚焦同步不会重载表单。

handler使用Node的`(req,res,{signal})`，不是框架请求上下文。插件负责请求大小、参数校验、响应类型、转义用户内容和密钥展示；不要另开无鉴权管理端口。iframe是页面容器，不能当作不可信插件的隔离沙箱。

完整可运行示例：`examples/plugins/contract-check/`，不会自动装进正式plugins目录。

## 模型、人格与会话

| 接口 | 行为 |
| --- | --- |
| `ctx.models.list(type?)` | 读取已启用且配置有效的模型元数据；包含配置ID、名称、类型、提供商ID、上下文上限及callable；不返回密钥/连接凭据 |
| `ctx.personas.list()` | 读取人格ID、名称、专用模型配置ID；不修改当前Web人格 |
| `ctx.llm.chat({model,messages,signal?,...})` | 使用明确选择的对话模型配置ID，返回text/toolCalls/usage；不隐式添加人格、记忆或执行工具 |
| `ctx.sessions.list()` | 已存在的未删除会话ID、名称、更新时间 |
| `ctx.sessions.create(name?)` | 显式创建空会话，返回ID |
| `ctx.sessions.context(id,persona)` | 当前指定人格下该会话的上下文与用量状态 |
| `ctx.sessions.run({sessionId,persona,text,permission?,origin?,signal?,onChunk?})` | 在已有会话走完整人格、记忆、模型、权限、工具及用量统计流程 |

`model` 是配置ID，不是提供商的裸模型名称。模型和人格必须明确指定；人格的模型选择遵循已有配置。`models.list()`可显示已配置的其他用途，但目前`callable`仅对chat为true，不能把Embedding模型交给chat调用。

`sessions.run` 不自动创建未知会话，也不改变Web当前人格。一次run产生一次交流；自主插件如何形成意图、何时run、调用哪些工具都属于插件策略。`origin`可提供platform/action，核心注入真实插件归属。需要外部收发、稳定消息ID及重投去重时使用 `ctx.channels`，详见 [CHANNELS.md](CHANNELS.md)。直接run不替插件提供外部事件幂等。

## 事件通知

`ctx.on(name,handler)` 返回可重复调用的解除订阅函数，并随插件卸载清理。通知异步派发，发生在来源操作提交之后，不持有记忆写锁；每个订阅收到独立数据副本。通知不是拦截器，不修改已经保存的消息，不等待插件完成才继续用户回复。

| 事件 | 载荷与时机 |
| --- | --- |
| `whalelife/ready` | `{at}`；启动就绪，之后启用的插件也会收到一次 |
| `whalelife/shutdown` | `{at}`；关闭前通知，随后signal取消；清理资源使用effect和signal |
| `channel/message` | 已保存的user消息，含id/session/来源/正文等；Web、外部渠道和插件会话共用 |
| `channel/reply` | 已保存的助手最终回复；表示生成完成，不等于外部投递成功 |
| `memory/recorded` | 已追加的原始事件；包含技术回执，订阅者须按type筛选 |
| `memory/updated` | `{session}`；事实、认知或摘要状态已经写入，按需通过记忆接口读取 |
| `tool/called` | `{id,name,source,origin,session,ok,result}`；调用结果，业务完成状态仍由插件明确记录 |

插件通过 `ctx.emit('plugin:<自身完整ID>:<事件>', payload)` 发布自定义通知，不能冒充核心事件。通知不持久化、不重放，也不保证外部任务恰好一次执行；需恢复的业务状态通过插件配置、扩展记忆或私有数据保存。避免收到自己的记忆写入通知后无条件再次写入而形成循环。

事件处理错误会记录日志、隔离失败插件及清理其资源，不回滚已经提交的核心记录。插件应自行捕获可恢复的业务错误。

## 记忆与能力经历

通过 `ctx.memory` 的公开接口检索、记录实际经历、注册和保存插件专属类型，详见 [MEMORY.md](MEMORY.md)。不要直接写会话内部状态文件或共享事实，不通过修改人格塞入平台来源。通用经历说明实际做了什么，插件扩展状态保存业务结构；例如主动性插件可以注册自己的意图类型，其他插件也可以注册不同类型。

关闭插件会取消其注册能力并清理运行资源，已经产生的事实和经历仍然保留。重新启用同ID插件可读取自己的持久配置和扩展状态。

## 验收与边界

`tests/plugin-contract.test.ts` 将示例复制到临时plugins目录，通过真实boot验证入口、鉴权、配置保存、启停、模型/人格选择、同会话切人格、来源、token统计、记忆事件和重载代际隔离；使用模拟模型。`plugin-cancellation.test.ts` 用本机HTTP验证取消。`channel-rebinding.test.ts` 验证重绑、回执和恢复旧备份不重放。

核心关闭先通知并取消会话、渠道和插件，再等待在途任务、插件清理及记忆队列。插件必须配合signal和effect；测试要覆盖迟到结果、异常、重复回调、父子/依赖停止与重启后的状态。只在临时目录测试，不把演示插件或验收事实装入正式环境。

新建会话同时受记忆恢复屏障和生命周期约束，排队提交前会再次检查。Web关闭会等待已接收的插件handler结束；核心还会等待已经开始的事件handler，而不是仅关闭HTTP响应就退出。

当前通用模型调用与渠道消息以文本为基础；多模态模型协议、真实平台连接和主动性策略由对应实现扩展。审批UI与模块依赖图的完全热重载也不在本契约中：修改插件静态import的子模块后，开发验证应使用新进程；不要假定入口重载必然刷新所有ESM缓存。
