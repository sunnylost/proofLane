# ProofLane

A local-first verification harness for coding agents.

ProofLane 将现有工程分析工具的结果统一为可验证的工程事实，为 Coding Agent 提供变更检查、baseline 比较和按需展开的证据。

## 使用

需要 Node.js >=22.13、Git，以及目标仓库本地安装的 Oxlint。当前验收平台为 macOS；CI 配置覆盖 Linux。Windows 尚未验收。

```sh
npm ci
npm run build
node dist/cli.js verify changed --root /path/to/repository
node dist/cli.js verify changed --root /path/to/repository --base main --json
node dist/cli.js verify full --root /path/to/repository --json
```

构建后的 CLI 名称为 `prooflane`。运行期间不会下载工具、修复代码或更新 baseline。

`changed` 默认比较 HEAD 与当前工作目录，包含暂存、未暂存和未忽略的新文件。`--base` 直接与指定 commit 比较，不自动计算 merge-base。未创建首个 commit 时检查工作目录中 Git 可见的文件。

普通变更检查 JavaScript / TypeScript 文件；依赖、已知配置、删除、重命名及文件类型变化会扩大到项目扫描。结果包含选择原因、请求范围、分析器版本和实际检查文件数。Oxlint 仍使用目标项目的配置与忽略规则。

| 退出码 | 结论 | 含义 |
| --- | --- | --- |
| 0 | `pass` | 所选 lint 检查没有 error；warning 保留；无适用变更时明确报告 skipped |
| 1 | `block` | 已完成检查，发现 error |
| 2 | `incomplete` | 工具缺失、执行或协议失败、超时、取消、零文件覆盖、输入无效或扫描期间仓库发生变化 |

终端最多展示 20 条 finding，`--json` 返回完整结构化结果。JSON 的 `files` 是变更文件集合，`scope` 是本次请求的扫描粒度，`filesChecked` 是 Oxlint 报告的文件数。

当前只有 Oxlint 适配器；`full` 表示完整项目 lint，不包含类型检查、测试、构建或运行时验收。所有 finding 的 `status` 暂为 `unclassified`，error 均阻塞；不会把旧问题标成新问题。`id` 是当前诊断标识，不是跨编辑稳定的 fingerprint。

## 开发与验收

```sh
npm run check
npm run verify:project -- /path/to/foliosmith/epub
```

`check` 执行类型检查、lint、构建和真实 CLI 端到端测试。测试在临时 Git 仓库运行，使用固定版本 Oxlint；可控进程仅用于模拟执行异常。可复现输出保存在 `artifacts/e2e/`，CI 会上传这些产物。

`verify:project` 克隆指定项目的 HEAD 到临时目录，复用该项目已安装的 Oxlint，对比直接运行与 Harness 的诊断，再注入并修复一个语法错误。源仓库的未提交变更不参与验收，产物保存在 `artifacts/project/`，临时副本自动删除。

## 当前边界

- 已实测 Oxlint 1.74.0 和 1.87.0。其他 1.x 版本会尝试解析并校验协议；其他主版本返回 incomplete。
- 仅从目标 Git 根目录的 `node_modules/oxlint` 加载工具，不向上查找或从 PATH 回退。
- 每次进程输出上限为 8 MiB；分析器默认超时 60 秒，可通过 `--timeout-ms` 调整。macOS/Linux 会终止超时或取消进程的进程组。
- 扫描前后比较 Git 可见文件内容、模式、HEAD 和索引。它不是原子快照；Git 忽略的文件、依赖目录及仓库外配置变化不在保护范围内。扫描期间应保持这些输入不变。
- 存在 Git 可见符号链接、子模块或非普通文件时返回 incomplete。自定义配置依赖变化和复杂跨文件规则应使用 `full`。
- Baseline、稳定 fingerprint、evidence 持久化、Knip、React Doctor、Vitest、MCP 尚未实现。

设计与进度：[原始设计](<Agent Verification Harness.md>) · [实现计划](docs/implementation.md) · [分析器协议](docs/analyzer-protocols.md)

Let tools prove. Let agents decide.
