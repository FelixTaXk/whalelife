# 冻结插件兼容样本：2026-10-29

取自本日可运行的 contract-check 示例，页面改用自身样式、类型走包公开入口后冻结。该日期是测试基线，不是已实现的加载器 API 版本。

`index.ts`、`plugin.yaml` 与 `sha256.json` 不得为迁就主干升级而修改。SHA256 对 LF 换行文本计算，避免 Git/Windows 换行转换造成误报。新契约另加样本并保留旧样本和断言；日常演示修改 `examples/plugins/contract-check/`。

`tests/plugin-contract.test.ts` 原有验收默认加载此副本，验证配置、页面、会话人格与记忆、统计、事件、启停和关闭；仅在临时目录运行。测试通过只证明覆盖到的行为，不等于全面故障隔离。
