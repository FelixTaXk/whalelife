# WhaleLife 主干现状与开发说明

核对日期：2026-10-29。本轮在161d15b文档基线之后落实插件独立执行、公开契约与版本检查、统一模型连接入口；验证记录见第6节。

**本文是主干整体状态的唯一入口**，说明已经做了什么、现在怎样运行、代码为何这样组织，以及现存问题。接口细节见[PLUGINS.md](PLUGINS.md)，记忆算法见[MEMORY.md](MEMORY.md)，现有渠道接口见[CHANNELS.md](CHANNELS.md)。旧设计稿和阶段报告是历史材料，不能作为另一份当前任务清单。

## 1. 当前结论与固定边界

当前已有本地聊天、人格、文件记忆和管理控制台。已安装插件独立执行、具备故障切割；公开接口有独立数据契约、加载前API检查和冻结旧插件回归。模型连接可供插件按配置ID读取。主干已具备进入插件开发的基础，本轮不再扩展平台或主动性业务。

用户确定的主干职责只有五块：

| 职责 | 范围 |
| --- | --- |
| 模型 API 配置 | 服务连接、密钥、模型条目、参数、模型选择和插件使用这些配置的入口 |
| LLM 人格与记忆 | 人格、会话、事实、经历、摘要、认知、检索、上下文及现有 token 统计 |
| 插件运行与调用 | 加载、启停、依赖、能力注册、调用、取消和故障切割 |
| 日志与权限 | 记录行为和结果，按用户授权允许或拒绝调用 |
| 统一配置与管理入口 | 公共设置、插件配置存储、控制台和插件页面入口 |

驱动人格、记忆和工具所需的对话请求归主干。QQ/微信/B站接入、外部发送、主动性、意图与计划、语音/图像等具体能力、向量召回、插件业务频率/预算/重试归插件。配置某种模型，不等于主干必须实现对应业务。

主干升级不得要求已有合规插件同步修改；插件升级不得要求修改主干或无关插件。提供方负责维持公开契约。插件可以出错，但主干须能切割它，让无关功能继续运行。完整约束见[AGENTS.md](../AGENTS.md)。

以下“已实现”指有实际代码和调用路径。代码存在、测试通过、真实平台长期运行验证分别说明，不能相互替代。

## 2. 已经做成的功能

### 2.1 模型配置与对话请求

- 提供商连接与模型条目分开：连接保存地址、密钥、协议、代理、超时；一个连接可管理多个模型，各自设置名称、用途、参数和启停。
- 控制台可新增、编辑、删除配置，获取兼容接口的模型列表并批量添加，也能手动添加。配置ID与供应商实际模型名称分开。
- 按用途选择模型；人格专用对话模型优先，否则使用工作空间对话选择。缺少有效选择时提示配置，不自动选列表第一项。
- OpenAI兼容对话链路支持流式回复、工具调用、返回用量、超时、代理和取消。
- Embedding已有配置、绑定、连通测试和维度检测，支持OpenAI兼容接口与DashScope原生接口；当前记忆检索不使用Embedding。
- 密钥输入有显示/隐藏按钮；已保存密钥不回传浏览器。留空保留，明确操作才清除；更换带密钥连接的地址/协议需重新输入或清除密钥。
- 配置保存有版本冲突检查和原子替换。已保存的模型、人格选择供后续请求读取。

插件可通过 models.connection(id) 获取各用途的连接和参数。用途含chat/embedding/rerank/image/stt/tts/custom，协议允许自定义标识；未知协议保留给插件执行，不能被选为核心聊天或伪装成核心可测试。配置语音、图像等条目不代表对应业务已实现。

代码：[model-config.ts](../core/model-config.ts)、[model-http.ts](../core/model-http.ts)、[llm.ts](../core/llm.ts)、[models.js](../core/ui/models.js)。

### 2.2 人格、会话与上下文

- 人格可新建、编辑、保存、启用及指定专用模型；每轮读取当前人格正文。
- 人格与会话分开：切换人格保留会话和历史，显式新建才另起会话。档案记录最后使用的人格，原始消息保留当时的人格和版本。
- 会话档案可选择继续、改名、确认删除；删除后进入回收目录。进行中的会话或记忆恢复会阻止冲突操作。
- 默认使用同一会话不同人格的历史，也可选择当前人格版本对应的历史范围。事实、历史、短期摘要和长期整理等开关分别保存。
- 可配置历史预算、短期时间窗口和保底条数。模型上限优先使用手动值，否则读取服务商模型元数据；未知时显示未知。
- 上下文占比使用最近完成回复所记录的模型请求输入加输出token，除以已知窗口上限；会话累计量另外统计。该比例不是整个历史累计量，也不是下一次请求的精确预测。

代码：[persona.ts](../core/persona.ts)、[persona-config.ts](../core/persona-config.ts)、[session.ts](../core/session.ts)、[session-context.ts](../core/session-context.ts)、[personas.js](../core/ui/personas.js)、[context.js](../core/ui/context.js)。

### 2.3 记忆

| 已实现内容 | 当前行为 |
| --- | --- |
| 原始经历 | 按会话、按月保存JSONL，记录对话、工具结果与来源；摘要和淡忘不删除原文 |
| 共享事实 | 保留共同资料，用户可编辑，AI只读 |
| 独立事实 | 新会话默认为空；AI通过专用工具追加、替换或清空，整份正文硬上限100个Unicode码点，full也不能绕过 |
| 短期/长期划分 | 默认7天，至少保留最近100条消息；只有既超期又超出保底范围的旧消息进入长期，100条不是上限 |
| 短期摘要 | 短期历史超过上下文预算时，在回复前压缩为最多200字，不产生长期认知 |
| 长期概览与认知 | 旧材料达到条件后，一次整理生成最多200字概览及最多2条、每条80字认知；短期与长期进度独立 |
| 认知维护 | 根据新证据替代、合并或标记待复核；保留来源、版本和依据，可确认或撤回最新修订 |
| 检索与淡忘 | 本地分词/词频、相关性和时间降权；默认最多6条、约800估算token；明确查旧事可检索历史，不物理遗忘原文 |
| 显式共享 | 会话默认独立；跨会话需加入空间并明确分享记录，不自动共享全部历史 |
| 插件扩展 | 插件可记录实际经历、注册自己的记忆类型并保存状态；所属插件由主干绑定 |
| 管理操作 | 查看占用、档案、原文、摘要、事实、认知和用量；支持检索、置顶/归档、备份和恢复 |
| 数据保护 | 迁移前备份；恢复前校验并备份当前状态，失败回滚；恢复与正在进行的写入互斥 |

整理最多每轮一次，短期优先。长期未处理旧消息一般至少10条才触发，长消息续处理按游标继续；整理发生在最终回复落盘后、该轮结束前，没有空闲自主循环。短期最多400输出token，长期最多1000；两者使用核心记忆自己的预算，默认每会话每日20,000估算token，不管理插件额度。

磁盘可保留完整档案，送给模型的仍是经过筛选和预算控制的片段。当前没有意图生成、计划执行或主动联系用户的功能；这些归主动性插件。

代码分工：[memory.ts](../core/memory.ts)管存储，[memory-engine.ts](../core/memory-engine.ts)管记忆规则和检索，[memory-lifecycle.ts](../core/memory-lifecycle.ts)管整理，[cognition.ts](../core/cognition.ts)管认知变更校验，[memory-tools.ts](../core/memory-tools.ts)提供模型可调用工具，[memory-admin.ts](../core/memory-admin.ts)管查看、维护和恢复。细节见[MEMORY.md](MEMORY.md)。

### 2.4 插件宿主与调用

- Cordis管理插件树；plugin.yaml与index.ts接入，支持父子插件和服务依赖。
- 启停选择持久保存，重启保持。依赖暂不可用与用户主动停用分开；恢复依赖不擅自启用用户关掉的插件。
- 插件可注册工具、页面、HTTP接口、事件和资源清理。入口有插件归属；停用后工具/页面移除，旧实例的受管理接口拒绝新调用。
- ctx.models、ctx.personas提供选择项；ctx.sessions支持显式新建会话，并让插件在已有会话里复用人格、记忆、工具与统计。
- ctx.models.connection(id) 返回后端连接快照；控制台及元数据列表不回传已存密钥。
- ctx.llm.chat是直接模型调用，不自动添加人格/历史或执行工具；usage交给插件，不自动纳入会话账本。
- ctx.config保存本插件私有配置；ctx.web提供统一鉴权、设置按钮和导航入口，表单与业务由插件实现。
- 消息、记忆、工具和生命周期提供提交后通知；不是拦截器或可恢复任务队列。插件自定义事件带自身命名空间。
- 工具路径检查权限，记录结果并形成带来源的经历；工具完成不必然代表外部业务完成。

每个安装插件在自己的子进程内执行；启动/调用超时、心跳失联、进程退出、V8堆耗尽及未处理的工具/页面/事件错误会标记失败并撤销入口，取消在途请求，限时清理后终止进程。明确依赖的插件暂停，无关插件和核心继续工作。用户启停选择、配置和历史保留，故障不自动重放外部动作。可恢复的业务错误应由插件自行捕获并返回明确结果。

manifest.apiVersion 在 import 之前检查，省略仍按旧1.x兼容；公开Context使用独立数据类型而非内部实现类。新进程重载也刷新静态import子模块。同步配置和跨插件服务方法保留调用语义，Web处理器仍使用真实Node req/res，经主干鉴权转发。

代码：[runtime.ts](../core/runtime.ts)管生命周期，[plugin-process.ts](../core/plugin-process.ts)、[plugin-worker.ts](../core/plugin-worker.ts)、[plugin-rpc.ts](../core/plugin-rpc.ts)、[plugin-http-bridge.ts](../core/plugin-http-bridge.ts)管隔离执行和转发，[plugin-api.ts](../core/plugin-api.ts)、[context.ts](../core/context.ts)、[plugin-compatibility.ts](../core/plugin-compatibility.ts)管公开契约与兼容检查。另见[plugin-state.ts](../core/plugin-state.ts)、[plugin-services.ts](../core/plugin-services.ts)、[plugin-events.ts](../core/plugin-events.ts)、[plugin-web.ts](../core/plugin-web.ts)、[tools.ts](../core/tools.ts)。

### 2.5 日志、权限与控制台

- 日志输出到终端、按天文件和控制台；日志服务遮蔽已登记模型密钥，配置接口不回传已存密钥。
- off禁止工具，full按授权执行；ask中可直接放行的调用可运行，需要批准的调用没有队列和批准界面，目前拒绝。full不等于操作系统提权，也不能绕过数据规则。
- 控制台已有概览、模型服务、使用配置、人格、测试聊天、记忆、插件管理和日志。插件管理只展示扩展；运行数按实际状态统计，模型数使用有效配置过滤口径。
- 插件页面可自动出现在设置按钮/导航中，停用后移除；页面容器不是恶意代码沙箱。
- HTTP和WebSocket有登录及来源校验，默认本机访问。当前会话选择在浏览器本地保存，记忆在服务端。

代码：[logger.ts](../core/logger.ts)、[permission.ts](../core/permission.ts)、[web.ts](../core/web.ts)、[app.js](../core/ui/app.js)、[views.js](../core/ui/views.js)、[memory.js](../core/ui/memory.js)、[extensions.js](../core/ui/extensions.js)。

### 2.6 已在主干中的通用渠道

[channels.ts](../core/channels.ts)已经包含平台/账号/对象到会话的绑定、入站去重、回复生成、外部投递、独立回执、显式重试与重绑。Web聊天也先经过它的Web入口，再进入Sessions。这不是单纯的包装函数。

平台认证与实际协议仍由插件提供。插件描述平台/动作，主干注入真实归属；来源随原文、检索、摘要、认知保存，没有QQ/B站/微信业务判断分支。生成完成与实际发送完成分开记录，不确定动作不自动重放。

按最新边界，会话接入与来源记忆属于公共能力，外部投递/回执/重试在主干中偏厚。此处记录现状，本次未搬迁或删除。未来调整归属必须保持旧接口及行为，不能让渠道插件同步重写。见[CHANNELS.md](CHANNELS.md)、[provenance.ts](../core/provenance.ts)。

## 3. 当前代码的组织和开发思路

### 3.1 运行形态与启动

当前为Node.js 24 + TypeScript应用，直接运行.ts；后端使用Node HTTP/WebSocket，前端是原生JavaScript/CSS。主进程管理核心服务，每个安装插件独占一个可终止子进程，其中worker执行插件，转发层维持同步接口。记忆与模型配置仍由主进程提供，没有拆成多个部署服务。Runtime.load的闭包路径仅供可信核心组装及测试，安装插件统一走loadPath隔离路径。

[index.ts](../core/index.ts)负责组装：读配置 → 建立日志/模型配置 → 初始化及迁移记忆、恢复摘要副本 → 准备人格 → 建立LLM、工具、会话和渠道 → 注册核心服务 → 启动Web → 扫描插件 → 发布就绪通知。

核心服务也经Cordis内置注册提供依赖，但不是用户可随意卸载的扩展。控制台隐藏内置服务只影响展示，它们仍在运行链路中。

### 3.2 一次交流的实际调用链

~~~mermaid
flowchart TD
  W[Web测试聊天] --> CW[Channels.web]
  P[插件 sessions.run] --> S[Sessions 会话服务]
  E[外部渠道插件] --> C[Channels 绑定与去重]
  CW --> S
  C --> S
  S --> A[读取人格、模型、记忆和上下文策略]
  A --> L[LLM 对话请求]
  L --> Q{是否调用工具}
  Q -->|是| T[Tools 权限检查与插件工具]
  T -->|结果加入本轮消息| L
  Q -->|否| R[保存最终回复与用量]
  R --> M[满足条件时整理长期记忆]
  M --> O[返回文本]
  O --> UI[Web界面]
  O --> PR[调用插件]
  O --> CP[Channels 投递与回执]
  CP --> D[插件发送函数]
~~~

实际顺序：检查会话、维护状态及并发锁；读取人格与模型；记录用户消息；筛选事实、检索片段、短期历史和摘要；必要时先短期压缩，再按历史预算与已知模型上限裁剪并预留输出空间。

模型要求调用工具时，主干检查权限、执行工具，将结果加入本轮请求；当前最多6轮模型请求。最终回复及用量落盘后，本轮未进行短期整理且满足条件时再整理长期记忆。流式片段可能先到界面，但完整会话操作尚未结束。

插件直接调用ctx.llm.chat则只走模型请求，不经过完整会话链路；不能将其记忆和统计与sessions.run混为一谈。

### 3.3 已采用的设计选择

| 选择 | 解决什么问题 | 当前边界 |
| --- | --- | --- |
| 连接、模型、用途绑定分开 | 一个API连接管理多个模型，用户明确选用 | 自定义协议由插件执行，不扩大核心模型业务 |
| 人格与会话分开 | 切换角色不丢经历、不增生会话 | 人格历史隔离仍可显式选择 |
| 原文与提炼内容分开 | 保留证据和纠正空间，不把全部历史塞进上下文 | 文件读取与索引规模仍有限制 |
| 短期压缩与长期认知分开 | 密集交流节省上下文，裁剪不等于长期记忆或遗忘 | 整理质量不能仅凭格式校验保证 |
| 插件经受管理接口接入 | 复用人格/记忆，平台行为留在插件 | 独立执行与版本化契约，不是恶意代码安全沙箱 |
| 来源与结果分开 | 知道经历来自哪里，不把排队当完成 | 实际平台结果仍靠插件准确报告 |
| 写入排队和原子替换 | 减少并发覆盖、半写入，恢复时挡住新工作 | 不构成跨文件和外部平台的整体事务 |
| 冻结样本与演示分开 | 主干更新时验证旧插件原样可用 | 版本检查与行为回归并行，不能证明所有未来插件 |

隔离保护的是主干可继续运行，不是保证每次外部操作成功。进程终止不能撤销已经发生的外部行为；整机资源耗尽、恶意文件操作、插件另起的外部进程仍超出当前保护范围。

index集中组装核心服务，Sessions复用模型、记忆和工具；Runtime提供生命周期门面，隔离层仅传送公开调用和数据。插件不持有核心实现对象，logger等不暴露私有字段。内部仍有动态编排，但公开类型、版本检查和冻结契约测试共同约束兼容；不能借内部重构要求插件改代码。

### 3.4 生命周期

用户启停选择与实际状态分开。父插件或依赖不可用时相关插件等待，保留原开关；重新启用时恢复注册，旧实例不能发起新工作。

关闭主干先通知并取消会话、渠道及插件，再等待Web处理器、会话/渠道操作、事件和记忆写队列。安装插件清理有时限，不配合的进程会被终止，其未完成RPC拒绝，避免无限等待。核心仍等待已开始的持久化写入，不能靠丢弃记忆队列加快退出。具体超时默认值及配置见PLUGINS。

## 4. 数据归属与读取依据

| 位置 | 归属与用途 |
| --- | --- |
| config/config.json | 主干公共配置：模型连接、模型条目、选择、人格索引和公共设置 |
| config/plugins.json | 主干保存的用户停用选择，不等于进程实际状态 |
| 配置指定的人格文件 | 当前人格正文及其内容版本 |
| memory/facts.md | 用户维护的共享事实 |
| memory/index.json | 会话元数据、删除标记及现有渠道绑定/回执的读取依据 |
| sessions/&lt;id&gt;/episodes/*.jsonl | 记忆目录内的按月原始流水 |
| sessions/&lt;id&gt;/knowledge/state.json | 独立事实、认知、摘要正文/进度、记忆设置与用量 |
| sessions/&lt;id&gt;/session.json、summaries/*.md | 元数据/摘要的展示副本，可由权威状态恢复 |
| sessions/&lt;id&gt;/extensions/&lt;owner-hash&gt;/ | 通过主干接口保存的插件专属记忆；插件负责payload含义与迁移 |
| memory/shared/spaces.json、memory/trash/ | 显式共享引用、已删除会话的可恢复档案 |
| plugins/&lt;id&gt;/data/ | 插件自己的配置和业务数据，主干不解释业务结构 |
| backups/memory/、backups/memory-migration/ | 记忆与迁移备份；不是整个应用的备份 |
| logs/ | 按天运行日志 |

插件不得绕过接口修改主干记忆或其他插件数据；主干迁移自己的数据时保持插件可见契约，不改写插件payload。私有配置、记忆、日志、备份、插件data和密钥不进Git。

## 5. 统一问题记录

下表仅保留仍存在的边界，**不是进入插件开发前必须继续扩建的清单**。其他交接引用本表，不另起一套待办。原C01故障切割、C02公开边界、C03连接接入、C04版本检查及C05子模块重载已落实到上文能力说明。

| 编号 | 当前事实与影响 | 与目标的关系 |
| --- | --- | --- |
| C06 交互审批 | off/full及ask直接允许的调用可用；无审批队列/批准界面 | 完全授权不依赖审批，不能称ask已完整实现 |
| C07 渠道职责 | 外部投递、回执和重试已在核心 | 与最新边界有偏差；调整须保留旧公开契约 |
| C08 容量与联调 | 读取完整会话文件，渠道回执全局增长；缺少大规模及真实平台长期验证 | 不能许诺高容量性能或真实QQ/微信/B站效果 |

平台、主动性/意图/计划、向量召回及其他模型业务、插件预算和业务重试属于插件，不列为主干缺口。插件直接调用模型目前也没有统一用量汇总；是否增加展示能力不自动成为本轮任务。

## 6. 现有验证与证据边界

- 4e78541：修复插件新建会话绕过记忆恢复屏障、退出遗漏Web/事件任务等待；当轮43项专项测试与TypeScript检查通过。
- 7c72acd：冻结插件样本及test:compat落地；当轮56项专项测试与TypeScript检查通过，使用临时数据、模拟模型和本机测试服务。
- 31c5823：只补切割规则，没有实现新切割机制，不能套用旧测试结果声称它已验收。
- 本轮实现：最终全量261项通过（含16项进程隔离、7项RPC、2项注册释放、9项HTTP桥接）；npm run test:compat独立106项通过，npm run check通过。冻结旧插件与原断言未修改。1000次异步调用、100次反复注册/撤销验证引用回收。测试均使用临时配置、插件和记忆。
- 经用户明确授权，真实模型验收通过Web流式聊天、事实工具、独立事实100字限制、同会话切人格与记忆延续、隔离插件llm和sessions调用、流式回调及token统计，另验证真实短期压缩和长期整理。浏览器实测模型获取/多模型添加、密钥显示开关、聊天布局、人格切换、插件页面/停用/计数同步、会话改名和确认删除。界面测试后使用模拟回复，避免额外付费调用。
- 已自动重启正式服务；启动无错误，控制台可访问，部署前后38份配置/记忆文件哈希一致、正式会话数不变；部署前已创建记忆备份。验收记录保存在本机.artifacts/，不提交密钥、正式记忆或临时配置。

不同提交的计数不能相加当作一次完整测试。以下是测试入口索引，不代表本轮重新执行：

| 领域 | 现有测试 |
| --- | --- |
| 模型与配置 | [model-config](../tests/model-config.test.ts)、[model-multi](../tests/model-multi.test.ts)、[model-context](../tests/model-context.test.ts)、[bindings](../tests/bindings.test.ts) |
| 人格与会话 | [persona-context](../tests/persona-context.test.ts)、[session-management](../tests/session-management.test.ts)、[session-context](../tests/session-context.test.ts)、[console-layout-persona](../tests/console-layout-persona.test.ts) |
| 记忆与恢复 | [memory-engine](../tests/memory-engine.test.ts)、[memory-lifecycle](../tests/memory-lifecycle.test.ts)、[cognition](../tests/cognition.test.ts)、[memory-admin](../tests/memory-admin.test.ts)、[memory-v2-resilience](../tests/memory-v2-resilience.test.ts)、[memory-storage-v2](../tests/memory-storage-v2.test.ts) |
| 插件运行 | [plugin-contract](../tests/plugin-contract.test.ts)、[plugin-state](../tests/plugin-state.test.ts)、[plugin-cancellation](../tests/plugin-cancellation.test.ts)、[plugin-isolation](../tests/plugin-isolation.test.ts)、[plugin-rpc](../tests/plugin-rpc.test.ts)、[plugin-http-bridge](../tests/plugin-http-bridge.test.ts)、[plugin-compatibility](../tests/plugin-compatibility.test.ts)、[plugin-model-connection](../tests/plugin-model-connection.test.ts)、[core](../tests/core.test.ts) |
| 渠道及来源 | [channels](../tests/channels.test.ts)、[channel-rebinding](../tests/channel-rebinding.test.ts)、[provenance](../tests/provenance.test.ts) |
| Web及界面 | [web](../tests/web.test.ts)、[console](../tests/console.test.ts)、[model-ui](../tests/model-ui.test.ts)、[memory-v2-ui](../tests/memory-v2-ui.test.ts)、[temporal-memory-ui](../tests/temporal-memory-ui.test.ts) |

用Node 24。契约/生命周期改动运行npm run test:compat与npm run check，其他按影响范围选测试。[冻结样本](../tests/fixtures/plugin-contract/2026-10-29/README.md)不得为迁就不兼容改动而修改、重算摘要或弱化断言。

CI工作流因GitHub凭据缺workflow权限未部署，准备文件仅在本机.artifacts/plugin-compatibility.workflow.yml；没有这项远端检查或新增合并保护，也没有多历史宿主版本兼容矩阵。tests/acceptance.ts及真实模型验收脚本不能当日常回归入口。

## 7. 后续开发保持一致的方式

1. **先定位再改。** 从本文确定能力归属和已有调用链；先给出当前行为及最小改动范围，不临时扩出一串前置项目。
2. **在责任方修复。** 保留调用方，补最小复现，再修改违反契约的模块。必须跨边界调整时先明确旧行为如何保留，不能多项目一起改来凑通过。
3. **实现和验证一起交付。** 检查实际调用、落盘和失败路径，不只看页面能保存；测试受影响范围，保留旧插件原样验收。
4. **维护现状，不追加对话流水。** 解决的问题移出问题表、并入能力说明；接口细节更新PLUGINS，记忆算法更新MEMORY，现有渠道更新CHANNELS。阶段报告仅保留证据。
5. **报告准确。** 写规则、加测试、功能落地、部署、真实平台验证分开说；未验证不称已验收。暂停实现时不借文档整理重构代码。

阅读顺序：本文 → [AGENTS.md](../AGENTS.md) → 对应子系统文档和源码。插件作者另读[plugins/AGENTS.md](../plugins/AGENTS.md)。本机HANDOFF-CODEX与HANDOFF-PLUGINS只提供操作和职责入口；旧设计稿、旧报告不覆盖当前契约。
