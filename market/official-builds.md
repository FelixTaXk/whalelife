# 官方插件安装包

控制台使用本机缓存中的已核验安装包。宿主发行维护者可在发布前准备缓存，普通用户在控制台查看即将安装的版本和依赖，然后点击安装。当前清单适用于 Windows x64、WhaleLife 0.1.0。

| 插件 | 版本 | 程序文件数 | 此版验证的必需插件 |
| --- | --- | ---: | --- |
| QQ | 0.22.0 | 2925 | — |
| QQ 空间 | 0.5.2 | 136 | QQ 0.22.0 |
| 自主性 | 0.6.3 | 16 | — |
| 图库 | 0.1.2 | 381 | — |
| 网上冲浪 | 0.1.1 | 1239 | — |
| B 站 | 0.2.8 | 335 | 网上冲浪 0.1.1 |
| 视听理解 | 0.5.0 | 386 | — |

## 从公开源码重建缓存

使用 Windows x64 版 Node.js 24.22.1、随附的 npm 11.19.1 和 Git。构建机上的 Git 检出使用 `core.autocrlf=true`。换行、打包器和压缩库都会影响最终字节，因此这些参数也是复现条件。宿主无需在插件安装时运行 npm 或构建脚本。

以下 PowerShell 命令从**主仓根目录**运行。将 `$pluginId` 换成所需插件标识，源码目录选择一个空位置。清单中保存了每款插件的原仓库、精确提交、缓存字节数和 SHA-256。[发行清单](official-releases.json)

```powershell
$pluginId = 'gallery'
$hostRoot = (Get-Location).Path
$market = Get-Content -Raw ./market/official-releases.json | ConvertFrom-Json
$plugin = $market.plugins | Where-Object id -eq $pluginId
$release = $plugin.verifiedReleases | Where-Object { !$_.recognitionOnly -and $_.platform -eq 'win32' -and $_.arch -eq 'x64' } | Select-Object -First 1
$source = Join-Path (Split-Path $hostRoot) ("whalelife-plugin-" + $pluginId)
git -c core.autocrlf=true clone --no-checkout $plugin.repository $source
if ($LASTEXITCODE) { throw '获取源码失败' }
git -C $source -c core.autocrlf=true checkout --detach $release.sourceCommit
if ($LASTEXITCODE) { throw '检出指定提交失败' }
Push-Location $source
try {
  npm ci --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE) { throw '安装构建依赖失败' }
  if ($pluginId -eq 'qq') {
    $vendor = New-Item -ItemType Directory -Force .artifacts/vendor
    $upstream = 'https://github.com/iinukami/whalelife-plugin-qq/releases/download/v0.19.3'
    foreach ($name in 'NapCat.Shell.Windows.Node.zip', 'NapCat.Framework.zip') {
      Invoke-WebRequest "$upstream/$name" -OutFile (Join-Path $vendor.FullName $name) -ErrorAction Stop
    }
    foreach ($step in 'prepare:engine', 'prepare:desktop', 'prepare:attach') {
      npm run $step
      if ($LASTEXITCODE) { throw "准备桌面组件失败 $step" }
    }
    node scripts/build.mjs --desktop
  } else {
    npm run build
  }
  if ($LASTEXITCODE) { throw '插件构建失败' }
} finally {
  Pop-Location
}
node ./market/tools/cache-official.mjs $pluginId $source
```

缓存工具读取插件构建脚本生成的 `BUILD.json`，校验所有程序文件并按路径排序。gzip 解包后的首行是 `{"format":1,"files":[...]}` 加 LF，记录每个文件的相对路径、字节数和 SHA-256，随后依清单顺序连接原始内容。封装完成后再次比较整包摘要、文件数和字节数，通过后保存到 `.artifacts/official-packages/<sha256>.wlpkg.gz`。第三个参数可指定另一台实例的缓存准备目录。

### QQ 桌面组件

QQ 0.22.0 桌面版需要 NapCat 4.18.41 的 Shell 与 Framework 原包，还有锁定的 Frida 原生绑定。维护者可以使用插件作者 v0.19.3 Release 已提供的同版本原包，两项资产的 GitHub 摘要与当前 `engine.lock.json`、`desktop-engine.lock.json` 一致。第三方使用和再分发条件见插件的 `THIRD_PARTY_NOTICES.md` 与 NapCat 原许可证。[Shell 原包](https://github.com/iinukami/whalelife-plugin-qq/releases/download/v0.19.3/NapCat.Shell.Windows.Node.zip) · [Framework 原包](https://github.com/iinukami/whalelife-plugin-qq/releases/download/v0.19.3/NapCat.Framework.zip)

上方构建命令自动下载两个原包。已有原包的维护者也可以在插件源码根目录的 `.artifacts/vendor/` 放入同名文件并跳过下载。准备脚本核对组件版本和摘要，桌面构建核对最终文件清单。

### 视听理解

当前视听包仅供用户从源码在使用机本地构建。插件构建脚本按照 `vendor/ffmpeg.json` 从固定的上游来源取得并验证 FFmpeg 和 ffprobe。语音模型、Ollama 和视觉模型由用户在插件设置中另行准备。含 FFmpeg 的本地构建会标记为 `binaryReleaseApproved: false`；公开分发该二进制包须先补齐插件仓要求的完整源码材料并通过其 `build:release` 和 `release:check`。[FFmpeg 材料说明](https://github.com/iinukami/whalelife-plugin-vision/blob/c95330d3a8323debd6684113222c729b6418e5fa/vendor/FFMPEG-SOURCE-REVIEW.md)

## 识别手动安装

`recognitionOnly` 条目的 SHA-256 对应 `market/inventories/<sha256>.json` 的原始字节。这些清单用于逐文件识别现有程序及卸载校验，安装按钮只选择可安装包。历史程序保留其发行时的实际换行和文档摘要，校验时严格比较原始字节。

发行清单中的 `installedBuilds` 用于管理页的「官方」标签。宿主按完整运行 ID、版本、平台和架构选取清单，再核对已安装的程序文件。电脑与文件 `computer` 0.1.0 的 Windows x64 清单来自开发者保留的构建产物，对应源码提交 `c05d81d4828e4040d30a7915582ebcc43b2fbbcc`。清单记录了 21 个发行文件及 `BUILD.json` 的摘要，其中原生组件 `SandboxRunner.exe` 按当时构建留存的二进制文件校验。

七款公开开发仓的原构建均对照相应源码提交复核。部分历史 README 与当前版不同，已按旧提交核对。图库 0.1.1 另对照首个公开提交重新构建，核对所有程序与生产依赖。分仓前的文档按独立开发发行目录核对，历史包内的依赖描述只比公开版少许可证或仓库元数据。部分 QQ 和空间手装环境的 Windows npm 启动器已按发行依赖锁独立重建，旧 QQ 的迁移脚本、开发文档以及自主性的旧验证文档均按原开发发行物识别。清单只保存相对文件名、大小与摘要。

每款插件自己的 `data/`、宿主配置和独立子插件由宿主保留。QQ 组件历史上会在 `vendor/napcat/` 写入 `beacon_report.log`、`guild1.db`、`guild1.db-shm` 和 `guild1.db-wal`，插件注册表的 `preserve` 列出了完整路径。它们属于运行资料，装卸及发行文件校验都应跳过。

## 构建验证记录

2026-11-20，在 Windows x64 隔离目录中检出各自公开提交，重建七款程序，复核插件自有构建清单并导入七个正式入口，均可取得 `apply`。图库另用全新源码和 `npm ci` 独立重建，所得压缩包再次符合清单中的 SHA-256。组件发布审批仍由相应插件仓负责。
