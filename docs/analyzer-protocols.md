# Analyzer protocol notes

## Oxlint

已执行验证：1.87.0（端到端测试依赖）、1.74.0（foliosmith/epub 本地依赖）。适配器通过目标项目包声明的 Node CLI 入口运行 `--format json -- <paths>`，保留原项目配置和默认 severity。

| 场景 | 退出码 | 输出 | Harness |
| --- | --- | --- | --- |
| 无问题 | 0 | `diagnostics: []` | pass |
| 仅 warning | 0 | warning diagnostics | pass，保留 findings |
| lint error | 1 | error diagnostics | block |
| 语法错误 | 1 | 无 code 的 error diagnostic | block，规则名暂记为 `parse-error` |
| 无效配置 | 1 | 非 JSON 的配置错误信息 | incomplete |
| 无效/不完整 JSON、未知 severity、退出码矛盾 | 任意 | 无法可信解释 | incomplete |
| 超时、取消、输出超限 | 不确定 | 不完整输出 | incomplete |

当前读取的报告字段：`diagnostics`、`number_of_files`。诊断字段为 `message`、可选 `code`、`severity`、`filename`、`labels[].span.line/column`。未知附加字段不影响解析。路径必须位于仓库内，位置必须为正整数；零文件扫描不作为通过。

不根据工具名称提升 confidence；第一版统一保守标为 medium。已解析的 findings 在执行状态异常时仍保留，但总体结论为 incomplete。

## 后续分析器

初始化时查询到的候选版本为 Knip 6.41.0、React Doctor 0.9.17、Vitest 5.0.3。这些版本仅核对了 npm 元数据，尚未安装或验证 CLI 协议，不属于已支持范围。

接入各分析器前，需要记录真实的成功、发现问题和执行失败样例，核实结构化输出、退出码、项目配置、扫描范围和 related-test 能力。不能复用 Oxlint 的退出码解释，也不能只凭工具帮助文本声明支持。
