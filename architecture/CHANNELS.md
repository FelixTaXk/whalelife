# 文本渠道接口

本文说明现有渠道实现。主干整体状态及渠道职责偏厚的边界问题统一见 [STATUS.md](STATUS.md)。现有接口继续有效；文档整理未迁移或删除渠道代码，也不表示主干应继续增加平台业务。

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

`register({id, name?, account, persona?, permission?, send})` 返回：

| 方法 | 行为 |
| --- | --- |
| `receive({peer,sender,messageId,text}, {signal?}?)` | 生成并发送最终回复，返回带 sessionId/status/deliveryId 的结果 |
| `bind(peer, existingSessionId)` | 首次使用前绑定已有且未删除的会话；相同绑定可重复调用 |
| `rebind(peer,{expectedSessionId,sessionId?})` | 显式切换会话；expectedSessionId为预期旧绑定，null表示首次；省略sessionId则显式新建；在途时拒绝迁移 |
| `send({peer,messageId,text}, {signal?}?)` | 直接发送文本并记录回执，不生成模型回复 |
| `retry(peer,messageId,{direction?:'in'\|'out',signal?}?)` | 只重试已保存文本的投递；默认 in，对直接发送指定 out |
| `context(peer)` | 获取该路由实际人格、历史范围和上下文/token 状态 |
| `dispose()` | 注销账号、取消生命周期信号；可重复调用 |

`ctx.channels.send({channel,account,peer,messageId,text}, options?)` 是同插件已注册账号的直接发送便捷入口。它不能使用其他插件的账号。`send` 不是授权机制：插件须在自己的工具权限与业务授权范围内调用。

## 路由、人格与信任

渠道由插件注册，不在核心维护平台枚举或按平台名称分支。`id` 是稳定渠道标识，`name` 是可选的平台显示名（1–32 个 Unicode 码点、不含控制字符），未填时显示 `id`。核心绑定实际插件归属，将平台来源写入每条消息并传给模型。来源来自注册信息，外部入站消息不能指定 `origin/platform/action` 或路由策略。显示名只是资料，不是提示词指令。

例如插件注册 `{id:'nebula',name:'星港交流',account:'main',persona:'a',send}` 即可接入一个核心从未见过的平台，无需改主干。平台适配、业务动作和配置属于插件；核心只校验通用接口和统一处理会话、记忆及回执。业务经历的扩展方式见 [MEMORY.md](MEMORY.md)。

路由键为 `(channel, account, peer)`；`sender` 不拆分群聊会话。平台插件必须使用不会相互冲突的 peer 命名，例如 `direct:123`、`group:123`。不同 channel、不同登录账号或不同 peer 默认得到不同 `ch_<hash>` 会话；同一路由重启后仍使用原会话。显式绑定让多个渠道共享一个已有会话及其上下文，且不会重置历史。

首次 receive、send 或 context 会建立默认绑定；如需共享上下文，先 bind。已有绑定通过 rebind 显式迁移，须提供预期旧会话ID防止覆盖并发修改。在途收发、上下文查询或会话维护期间拒绝迁移。删除目标会话后不会自动复活；可通过 rebind 选择已有会话或显式新建，旧会话及去重回执保留。历史旧版已删除、且没有独立回执的路由不能猜测恢复，需先取得完整备份。

主干另提供 `ctx.sessions.current()` 获取与Web共用的当前会话，`sessions.run`省略sessionId时直接使用它，规则见[PLUGINS.md](PLUGINS.md)。这不改变现有渠道的持久绑定：渠道插件若按用户选择跟随当前会话，应先读取该ID，再用既有bind/rebind接口管理绑定，并处理在途冲突；不能认为Web切换会自动迁移所有旧渠道，也不能绕开独立回执重放消息。本轮不修改已有平台插件。

人格与权限来源于可信注册参数，未传时读取主配置 `channels[id].accounts[account]`（存在时）或 `channels[id]`，权限再回退到人格配置，最后为 off。人格必须存在，权限只能是 off/ask/full。注册值固定在实例中；未覆盖的主配置在调用时读取。收件消息不得指定 persona、permission、session、sessionId、channel、account 或 owner。适配器负责验证外部事件，核心不会把事件中自称的账号、发送者或管理员身份当作授权。

安装插件在独立进程执行，但仍属于受信任代码；这些门面提供归属和生命周期约束，不是恶意代码安全沙箱。插件停止、加载失败或父插件卸载时，注册自动清理，旧门面及旧 handle 拒绝新调用。相同账号只能有一个活动注册，持久绑定也保存原插件归属。

Web 的 `/ws/chat` 通过同一可信生成入口进入 Sessions，保留显式 session、chunk/context/done 流式协议与 expectedPersona 冲突检查。切换或编辑人格不会改变 Web session。Web 没有平台稳定消息 ID，因此不采用外部消息回执去重；默认历史范围仍是 session，显式 persona 隔离仍然可用。

## 去重与失败边界

同一 `(channel,account,peer,direction,messageId)` 的并发重复请求共用在途结果。messageId 必须由适配器提供稳定值，重复 ID 的 sender/text 必须一致。入站与直接出站分开去重。不同入站消息按解析后的会话进入Sessions统一队列，与Web及插件enqueue系列共用执行位；显式共享会话也遵守这一顺序，不再因另一入口正在回复立即报忙。真人消息同优先级按入队顺序保留，主干接收时间在等待前固定，来源/人格/权限也不随等待期间配置变化漂移。直接出站与生成队列分离，工具可以等待当前会话的直接发送；传输按会话串行。队列取消、容量和兼容策略见[PLUGINS.md](PLUGINS.md#统一会话队列)。

| status | 意义与处理 |
| --- | --- |
| sent | 适配器已确认发送完成；若落盘失败会附error说明，不能把真实成功改成发送失败 |
| generated | 最终文本已持久化，但还没有成功投递回执；可显式 retry |
| delivery_failed | 投递未完成或结果不确定；检查 error，可显式 retry 缓存文本 |
| generation_failed | 模型/工具阶段失败；重复收件不会重跑，retry 也拒绝生成 |
| uncertain | 上次进程中断或回执存储失败；需人工核对，不自动重跑模型/工具 |

生成前先写 pending 回执，发送前先写 delivering。重启遇到 pending/delivering 时返回 uncertain；即使模型可能只执行了一部分，也不会通过重复消息重放工具。完成生成后先保存最终文本再调用 transport。投递失败不会重新调用模型或工具；retry 沿用原 deliveryId。成功回执持久化后不会因为同 ID 重投而再次发送。

本协议**不保证跨平台恰好一次投递**。平台已接收但调用超时、进程在发送后回执落盘前退出、恢复到较早备份，都可能让投递结果不确定。需要平台幂等键或人工核对；不要对失败结果盲目循环 retry。确认业务结果后如需重新生成，应由操作者明确发起新消息 ID，并承担已有动作可能已完成的事实。

取消与卸载会阻止新操作，并把 AbortSignal 传给适配器、模型HTTP、模型窗口查询、摘要和工具的 session.signal；核心无法撤回已提交的外部发送。忽略signal的工具或适配器需要自行清理，核心关闭会等待实际结束。适配器返回成功时仍记录真实投递结果，不把成功伪装成取消。

## 存储与记忆

普通渠道回复是聊天正文：即使生成过程中使用临时工具，也保存完整最终答复及投递回执，保留下一句交流所需的提问和约定，不因工具标记而设为transient。工具临时原文和后续参数仍隔离，自动工具明细不作日常召回。显式投递重试只使用已生成正文，不重新执行模型或工具；旧的临时回执没有正文时继续拒绝重试，不能恢复已丢失内容。

绑定和权威去重回执保存在 `memory/index.json` 的 `channel_routes`；会话元数据 `channel_bindings` 与 `sessions/<id>/session.json` 为投影。每条回执保留原sessionId，重绑后旧消息返回原回执，新消息进入新会话；未完成的旧回执不支持跨会话重试。技术审计同时写入会话episodes，类型为 `channel_receipt`；读写使用Memory队列。技术回执不作为对话历史、persona 分段边界或知识召回片段。入站消息、工具结果、模型最终回复继续使用原聊天事件及记忆提炼流程。

确认成功的直接出站会额外投影通用 experience，来源绑定为 `channel:<plugin-id>`，事件 ID 使用 deliveryId、结果为 succeeded，文本包括发送内容的有限预览。入站回复不重复制造 assistant 事件。失败/不确定的投递只留技术回执，不声称动作成功。经历投影失败只记录日志，不改变成功回执、不触发重发；当前没有自动修复这类投影的任务。

绑定和回执随记忆备份保存；删除会话仍保留独立去重回执和绑定墓碑。活动渠道任务阻止相关删除与全局恢复。恢复旧备份会合并当前已经发生的渠道回执，不把已执行的消息变回未执行；备份里不存在的现有路由保留回执，缺少会话时补墓碑并要求显式重绑。原子提交失败保持旧绑定，冲突或损坏数据拒绝恢复。

本轮仅提供文本、稳定路由、可靠失败分类和插件生命周期接口；未包含真实 QQ/微信等平台适配器、图片/语音/附件、平台认证、自动重试调度、收件限流或路由迁移 UI。外部消息ID不会自动过期清理；独立回执索引随路由消息量增长，高吞吐部署需规划存储容量。平台连接、自动重试和业务限流属于插件。

## 本地验证

使用 Node 24 执行 `tests/channels.test.ts`、`tests/channel-rebinding.test.ts`、`tests/plugin-cancellation.test.ts` 以及 `web/core/persona-context` 相关测试，全部使用临时记忆目录、假模型与内存 transport，不访问实际平台或真实模型。专项覆盖路由隔离、跨渠道共享、重启与备份恢复、墓碑、在途去重、投递重试、取消/卸载、归属隔离、persona 历史、工具内发送及记忆/用量路径。
