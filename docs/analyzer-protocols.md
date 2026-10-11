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

## Vitest 5.0.3

真实用例验证了：实现错误产生失败 assertion，修复后通过，related 选择对应测试，全跳过返回 incomplete。JSON reporter 默认写文件，适配器指定独立临时报告路径并在 finally 清理，不能把控制台的“report written”当作 JSON。

读取 `success`、通过/失败测试数、`testResults` 和 assertion 身份、位置、失败原因。默认摘要包含失败首行；完整细节可通过 explain 获取。测试实体只在 passed/failed 时计入覆盖，跳过的测试不能确认 resolved。

## Knip 6.41.0

真实 unused-file 用例验证：发现闲置文件，删除后诊断消失。使用 JSON reporter，退出 1 表示存在 issues，不直接等同 Harness block。unlisted/unresolved 映射为 error，其余问题保守映射 warning，保留工具和问题类型。

Knip 完整项目图扫描有明确的检查域，但不提供完整已检查文件清单；coverage 标明 project，不虚构 filesChecked 数值。

## React Doctor 0.9.17

真实字符串列表用例验证了数组下标 key 的诊断及改成稳定值 key 后诊断消失。使用 schemaVersion 3 的项目结果、diagnostics、analyzedFiles、complete 和 skippedChecks；不完整或跳过检查不能作为完成。

显式关闭评分、遥测、供应链网络扫描和缓存。对象属性渲染样例与字符串样例的诊断不同；该规则带启发式过滤，没有独立 UI oracle 时不把差异称为已确认漏检。

## 版本边界

已验收上述固定版本。适配器对 Oxlint 1.x、Vitest 5.x、Knip 6.x、React Doctor 0.9.x 尝试解析，但仍严格校验报告；未经实测的其他版本不作兼容保证。

覆盖范围、执行状态和 gate 分开保留。JSON、退出码或结果统计矛盾时返回 incomplete；一个分析器失败不会丢失其他分析器的诊断。
