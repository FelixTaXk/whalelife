# 文本渠道接口

通用渠道负责接收适配器规范化的纯文本、选择稳定会话、调用现有聊天流程，并将最终文本交给适配器发送。模型选择、工具权限、会话历史、独立事实、摘要、认知检索和 token 统计仍由 `Sessions` / Memory V2 处理。本实现没有安装任何平台插件，也没有主动调度器。

## 插件接口

`Context.channels` 和 `Context.get('channels')` 返回同一个按完整插件 ID 绑定的接口。类型从 `core/context.ts` 导出。示例中的 transport 是插件自己实现和认证的传输层，不是核心内置服务：

```ts
import type { Context } from '../../core/context.ts';

export async function apply(ctx: Context) {
  const config = await ctx.config.read();
  const transport = ctx.get('my-authenticated-transport');
  const channel = ctx.channels.register({
    id: 'example',
    account: config.accountId,
    persona: config.personaId,
    permission: 'off',
    async send(message, { signal }) {
      // 只有传输层确认完成后才 resolve；失败必须 reject。
      // 若平台支持幂等键，使用稳定的 deliveryId。
      await transport.sendText({
        peer: message.peer,
        text: message.text,
        replyTo: message.replyTo,
        idempotencyKey: message.deliveryId,
        signal,
      });
    },
  });

  // 可选：在该路由首次使用前，按用户明确选择绑定已有会话。
  if (config.sharedSessionId)
    await channel.bind(config.peerId, config.sharedSessionId);

  ctx.effect(() => transport.onText(async (event) => {
    // transport 必须先验证事件来源、账号、目标会话及可接受的发送者。
    const result = await channel.receive({
      peer: event.conversationId,
      sender: event.senderId,
      messageId: event.stableMessageId,
      text: event.text,
    });
    if (result.status !== 'sent')
      ctx.logger.warn('渠道消息未完成', { status: result.status });
    // 不要再次发送 result.text；receive 已负责发送最终回复。
  }));

  // 同一 handle 也可被本插件工具调用；不会调用模型。
  async function sendApprovedText(peer: string, actionId: string, text: string) {
    return channel.send({ peer, messageId: actionId, text });
  }
  ctx.provide('example-send', sendApprovedText);
}
```

`register({id, account, persona?, permission?, send})` 返回：

| 方法 | 行为 |
| --- | --- |
| `receive({peer,sender,messageId,text}, {signal?}?)` | 生成并发送最终回复，返回带 sessionId/status/deliveryId 的结果 |
| `bind(peer, existingSessionId)` | 首次使用前绑定已有且未删除的会话；相同绑定可重复调用 |
| `send({peer,messageId,text}, {signal?}?)` | 直接发送文本并记录回执，不生成模型回复 |
| `retry(peer,messageId,{direction?:'in'\|'out',signal?}?)` | 只重试已保存文本的投递；默认 in，对直接发送指定 out |
| `context(peer)` | 获取该路由实际人格、历史范围和上下文/token 状态 |
| `dispose()` | 注销账号、取消生命周期信号；可重复调用 |

`ctx.channels.send({channel,account,peer,messageId,text}, options?)` 是同插件已注册账号的直接发送便捷入口。它不能使用其他插件的账号。`send` 不是授权机制：插件须在自己的工具权限与业务授权范围内调用。

## 路由、人格与信任

路由键为 `(channel, account, peer)`；`sender` 不拆分群聊会话。平台插件必须使用不会相互冲突的 peer 命名，例如 `direct:123`、`group:123`。不同 channel、不同登录账号或不同 peer 默认得到不同 `ch_<hash>` 会话；同一路由重启后仍使用原会话。显式绑定让多个渠道共享一个已有会话及其上下文，且不会重置历史。

已建立的路由目前不能迁移到另一会话。首次 receive、send 或 context 都会建立默认绑定；如需共享上下文，先 bind。目标被删除后，路由继续命中墓碑并拒绝使用，不会自动复活或新建替代会话。路由迁移、重新建立已删除路由需要另行设计明确的路由版本机制，本轮未实现。

人格与权限来源于可信注册参数，未传时读取主配置 `channels[id].accounts[account]`（存在时）或 `channels[id]`，权限再回退到人格配置，最后为 off。人格必须存在，权限只能是 off/ask/full。注册值固定在实例中；未覆盖的主配置在调用时读取。收件消息不得指定 persona、permission、session、sessionId、channel、account 或 owner。适配器负责验证外部事件，核心不会把事件中自称的账号、发送者或管理员身份当作授权。

插件是同进程受信任代码；这些门面提供归属和生命周期约束，不是恶意代码隔离沙箱。插件停止、加载失败或父插件卸载时，注册自动清理，旧门面及旧 handle 拒绝新调用。相同账号只能有一个活动注册，持久绑定也保存原插件归属。

Web 的 `/ws/chat` 通过同一可信生成入口进入 Sessions，保留显式 session、chunk/context/done 流式协议与 expectedPersona 冲突检查。切换或编辑人格不会改变 Web session。Web 没有平台稳定消息 ID，因此不采用外部消息回执去重；默认历史范围仍是 session，显式 persona 隔离仍然可用。

## 去重与失败边界

同一 `(channel,account,peer,direction,messageId)` 的并发重复请求共用在途结果。messageId 必须由适配器提供稳定值，重复 ID 的 sender/text 必须一致。入站与直接出站分开去重。不同入站消息按解析后的会话排队；显式共享会话也遵守这一顺序。直接出站与生成队列分离，工具可以等待当前会话的直接发送；传输按会话串行。

| status | 意义与处理 |
| --- | --- |
| sent | 适配器发送完成且成功回执已持久化；重复消息直接返回已有结果 |
| generated | 最终文本已持久化，但还没有成功投递回执；可显式 retry |
| delivery_failed | 投递未完成或结果不确定；检查 error，可显式 retry 缓存文本 |
| generation_failed | 模型/工具阶段失败；重复收件不会重跑，retry 也拒绝生成 |
| uncertain | 上次进程中断或回执存储失败；需人工核对，不自动重跑模型/工具 |

生成前先写 pending 回执。重启遇到 pending 时返回 uncertain；即使模型可能只执行了一部分，也不会通过重复消息重放工具。完成生成后先保存最终文本再调用 transport。投递失败不会重新调用模型或工具；retry 沿用原 deliveryId。成功回执持久化后不会因为同 ID 重投而再次发送。

本协议**不保证跨平台恰好一次投递**。平台已接收但调用超时、进程在发送后回执落盘前退出、恢复到较早备份，都可能让投递结果不确定。需要平台幂等键或人工核对；不要对失败结果盲目循环 retry。确认业务结果后如需重新生成，应由操作者明确发起新消息 ID，并承担已有动作可能已完成的事实。

取消与卸载会阻止尚未开始的传输，并把 AbortSignal 传给适配器；核心无法撤回已提交的外部发送。生成期间会在模型调用前、返回后、工具调用前检查取消；当前 LLM HTTP 请求和已经开始的工具本身不保证立刻取消。即使适配器忽略取消并返回成功，核心仍记录已确认投递，不把真实成功伪装成失败。

## 存储与记忆

绑定保存在 `memory/index.json` 的会话元数据 `channel_bindings`，并由 Memory 同步到 `sessions/<id>/session.json`。技术回执保存在同一会话的 episodes 中，类型为 `channel_receipt`；读写使用 Memory 队列。技术回执不作为对话历史、persona 分段边界或知识召回片段。入站消息、工具结果、模型最终回复继续使用原聊天事件及记忆提炼流程。

确认成功的直接出站会额外投影通用 experience，来源绑定为 `channel:<plugin-id>`，事件 ID 使用 deliveryId、结果为 succeeded，文本包括发送内容的有限预览。入站回复不重复制造 assistant 事件。失败/不确定的投递只留技术回执，不声称动作成功。经历投影失败只记录日志，不改变成功回执、不触发重发；当前没有自动修复这类投影的任务。

绑定和回执随现有记忆备份、恢复、删除一起管理；不缓存持久路由，恢复后重新读取。删除保留墓碑中的绑定以拒绝重建。活动渠道任务阻止相关会话删除与全局恢复。历史备份恢复也会回退去重记录；它不能撤回备份后已发生的外部动作。

本轮仅提供文本、稳定路由、可靠失败分类和插件生命周期接口；未包含真实 QQ/微信等平台适配器、图片/语音/附件、平台认证、自动重试调度、收件限流或路由迁移 UI。外部消息 ID 不会过期清理，长会话的回执查询目前扫描该会话记录；高吞吐平台应另行规划索引与保留策略。

## 本地验证

使用 Node 24 执行 `tests/channels.test.ts` 以及 `web/core/persona-context` 相关测试，全部使用临时记忆目录、假模型与内存 transport，不访问实际平台或真实模型。专项覆盖路由隔离、跨渠道共享、重启与备份恢复、墓碑、在途去重、投递重试、取消/卸载、归属隔离、persona 历史、工具内发送及记忆/用量路径。
