# 社区插件发行包与一键安装

公开仓库和安装说明就能投稿收录。发布正式 GitHub Release 后，已安装旧版的用户可以收到更新提醒。希望用户直接点「安装」的作者，还要上传可运行的发行包，并请维护者审核该附件。商店按用户的 WhaleLife 版本、操作系统和架构提供已审核的安装版本。

## 作者打包

1. 在插件仓库固定本次发布的提交。检查根目录的 `plugin.yaml` 和 `index.ts`，确认 ID 和版本正确。包内子插件放在 `sub/<子插件 ID>/`，每个子插件均需自己的 `plugin.yaml` 和入口。安装时需要的模板、静态文件和运行依赖要一并准备好。
2. 在 WhaleLife 主仓安装 Node.js 24 或更新版本，运行一次 `npm ci` 获得主仓工具依赖。以下命令从主仓根目录运行。示例插件仓库位于同级的 `my-plugin`，输出目录选在插件目录之外。

   ```sh
   node tools/build-community-package.mjs ../my-plugin ../release-output
   ```

   默认使用 Git 跟踪的文件，要求已跟踪文件与所选提交一致。如果需要构建或捆绑运行依赖，先按照插件自己的发布流程生成干净的发行目录，再将这个目录交给工具。可以使用实际运行 ID 为子插件命名。

   ```sh
   node tools/build-community-package.mjs ../my-plugin/dist ../release-output --from-dir
   node tools/build-community-package.mjs ../douyin/dist ../release-output --from-dir --id surf/douyin
   ```

3. 核对输出文件列表。工具会过滤插件和子插件的 `data/`、用户配置、隐藏文件和常见凭据文件，遇到私钥内容标记会终止。请从清单中逐项确认只有公开程序、必要依赖与授权材料，检查源码或其他命名的文件内是否嵌入了账号资料。用户安装时无需运行作者机器上的构建步骤。
4. 在**插件自己的公开 GitHub 仓库**发布正式 Release。例如插件 `1.2.0` 对应标签 `v1.2.0`。将生成的 `.wlpkg.gz` 作为 Release 附件上传。GitHub 自动提供的源码下载仍可用于手动安装。
5. 在原投稿 Issue 回复发行页和附件链接，附上打包工具输出的 `sizeBytes`、`sha256`、适用的 WhaleLife 版本、已测试的操作系统与架构，以及必需插件的完整 ID 和版本。子插件请同时写明父插件及版本。可选集成单独说明，帮助用户判断是否需要额外能力。

## 维护者审核

1. 从主仓已收录条目的 `repository` 进入作者原仓库，核对 Release 已正式发布、标签、附件名、源码提交与 `plugin.yaml`。对照代码、构建步骤和打包清单，核对文件读写、网络、账号访问、子插件和随包依赖的用途。
2. 从该 Release 下载**将给用户安装的同一附件**。核对压缩文件字节数和 SHA-256，与作者提交的信息和 GitHub 的附件元数据交叉验证。Windows 上可用 `Get-FileHash -Algorithm SHA256 <附件路径>` 计算摘要。文件清单内每个文件的摘要与整个压缩包的摘要用途不同，两者均需正确。
3. 在与登记版本、平台和架构相符的独立测试环境，用本地目录草稿试装。复制 `market/catalog.json` 为草稿，按下表填入待审记录。主仓带有以下试装命令，从空实例、空缓存读取草稿，安装时使用与商店相同的下载、校验和依赖处理流程。可在提交收录前完成验证。

   ```sh
   node tools/trial-community-package.mjs ../draft-catalog.json sample 1.2.0
   node tools/trial-community-package.mjs ../draft-catalog.json sample 1.2.0 --install --serve
   ```

   第一条输出安装计划。第二条会实际安装并启用插件，打印随机的本机控制台地址。打开临时控制台的「插件管理」验证已安装插件的功能，回到终端按回车结束试用。本地草稿仅用于命令行的试装计划；控制台商店仍使用公开目录。对于涉及真实账号、外部程序或系统文件的插件，请使用专用测试环境和合成资料。另检查依赖已安装或停用时如何复用或启用，验证安装失败后的撤回情况，记录所用宿主、平台、附件版本及提交。
4. 通过后，在主仓 `market/catalog.json` 对应 `community` 条目加入可选 `verifiedReleases` 数组。每个元素代表一个已实测的附件和兼容条件。这些字段由主仓维护者登记，安装入口读取审核记录。[商店目录](catalog.json)

   | 字段 | 登记内容 |
   | --- | --- |
   | `version`、`hostRange` | 插件正式版本和最低实测宿主，例如 `1.2.0`、`0.1.0`。宿主有上限时填 `>=0.1.0 <0.2.0` 或 `>=0.1.0 <=0.1.1`，仅适配单一版本时填 `=0.1.0`。 |
   | `platform`、`arch` | 对应 Node 的平台和架构，例如 `win32`、`x64`。该维度确实通用时可填 `any` |
   | `assetUrl` | 同一作者仓库下的 `/releases/download/v1.2.0/<文件名>.wlpkg.gz` 附件直链 |
   | `sizeBytes`、`sha256` | 实际压缩文件的字节数和 64 位小写十六进制摘要 |
   | `dependencies` | 必需插件完整运行 ID 对应实测精确版本，如 `{"surf":"0.1.1"}`。没有时填 `{}`；条目的 `dependencies` 列表与这些 ID 对应 |
   | `bundledPluginIds` | 可选，随同该附件安装的子插件完整 ID，例如 `["sample/calendar"]` |

5. 在主仓根目录运行 `node market/tools/generate-catalog.mjs` 生成展示文件，再运行 `node market/tools/generate-catalog.mjs --check` 核对。发布后在控制台回读条目，核对安装版本、依赖提示和作者链接，再到原 Issue 告知作者结果。作者可以在同一 Issue 提交修订版。

每个新发行包都独立审核。换包请发布新版本并重新报审。已登记附件如被替换，大小或摘要不匹配会中止安装。
