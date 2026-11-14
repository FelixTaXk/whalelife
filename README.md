# WhaleLife

WhaleLife 是一个在本机运行、通过插件扩展能力的 AI 伙伴框架。你可以选择模型、编辑人格，在网页里与它聊天，再按需接入 QQ、网页浏览、B 站和视听理解等能力。

主干负责模型配置、人格与记忆、插件运行、日志和权限；具体能力由各自独立的插件提供。

- **延续交流**：网页与渠道插件使用同一会话时，可以接着之前的内容聊；切换人格不会自动新建会话。
- **自己决定何时整理记忆**：自动整理为日记默认关闭，需要时可按上下文占用比例开启。有效日记替代对应原文进入上下文，原始记录仍保留。
- **按需添加能力**：先完成本地聊天，再安装需要的插件；在控制台管理插件设置与启停。

## 开始使用

1. 下载本仓库源码，安装 **Node.js 24 或更新版本**，用 `node --version` 确认版本。
2. 在项目目录打开终端，执行 `npm ci` 安装依赖。
3. 首次使用时创建 `config` 文件夹，将根目录的 `config.example.json` 复制为 `config/config.json`。升级已有安装时保留原配置。
4. 执行 `npm start`；Windows 也可以双击 `start.bat`。打开 [本地控制台](http://127.0.0.1:9270)。
5. 在“模型服务”添加服务连接和聊天模型，在“使用配置”选择模型与人格，然后到“对话”页开始聊天。已提供默认人格“鲸鲸”，可以在“人格”页编辑或新建。

模型服务可配置云端或本地的 OpenAI 兼容接口，具体模型需支持所用的对话及工具调用能力。首次启动会初始化记忆目录和缺失的默认人格文件，无需提前准备聊天记录。

默认仅供本机访问。需要局域网访问时，在配置中开启 `web.lan_enabled` 并设置密码。模型与人格选择保存后供后续对话使用；端口等启动参数变更后需重启。终端中按 `Ctrl+C` 退出。

## 插件

各插件独立维护，安装和配置方法见对应仓库。按插件说明使用发行包或构建产物，无需把整个源码仓库放进 `plugins`。

| 插件 | 能力 |
| --- | --- |
| [QQ](https://github.com/iinukami/whalelife-plugin-qq) | 在 QQ 收发消息，与当前会话衔接 |
| [QQ 空间](https://github.com/iinukami/whalelife-plugin-qzone) | QQ 空间浏览与互动，作为 QQ 的子插件安装 |
| [自主性](https://github.com/iinukami/whalelife-plugin-autonomy) | 管理意图与主动行动，按配置调用已有能力 |
| [图库](https://github.com/iinukami/whalelife-plugin-gallery) | 管理图片，供模型查看和其他插件使用 |
| [网上冲浪](https://github.com/iinukami/whalelife-plugin-surf) | 搜索网页、阅读正文、沿链接继续浏览 |
| [B 站](https://github.com/iinukami/whalelife-plugin-bilibili) | 搜索与浏览视频、按配置互动，作为网上冲浪的子插件安装 |
| [视听理解](https://github.com/iinukami/whalelife-plugin-vision) | 准备图片、视频片段和声音证据，供当前模型理解 |

QQ 空间依赖 QQ，B 站依赖网上冲浪；媒体处理等可选能力和资源要求以各插件说明为准。

## 进一步了解

| 文档 | 内容 |
| --- | --- |
| [主干现状与开发说明](architecture/STATUS.md) | 当前能力、架构、代码分工及已知限制 |
| [记忆系统](architecture/MEMORY.md) | 完整上下文、日记、上下文容量与原文追溯 |
| [插件扩展契约](architecture/PLUGINS.md) | 插件接口、生命周期、页面与调用方式 |
| [渠道接口](architecture/CHANNELS.md) | 会话绑定、消息收发与来源记录 |
| [开发规则](AGENTS.md) · [插件开发规则](plugins/AGENTS.md) | 开发范围、兼容要求与验证方式 |

开发时使用 Node.js 24 执行 `npm run check`；`npm test` 运行自动化测试，`npm run test:compat` 验证插件兼容性。测试与验证范围统一记录在[主干现状](architecture/STATUS.md#6-现有验证与证据边界)中。
