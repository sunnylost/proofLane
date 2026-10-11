# ProofLane

A local-first verification harness for coding agents.

ProofLane 调度现有分析器，将诊断、覆盖范围、历史状态和证据统一为 CLI / MCP 接口。

## 使用

需要 Node.js >=22.13、Git，以及项目中安装的分析器。默认只启用 Oxlint。

```sh
npm ci
npm run build
node dist/cli.js verify changed --root /path/to/repository
node dist/cli.js verify changed --root /path/to/repository --base main --json
node dist/cli.js verify full --root /path/to/repository
```

`changed` 默认比较 HEAD 与工作目录，包含暂存、未暂存和未忽略的新文件。`--base` 直接与指定 commit 比较，不自动计算 merge-base。Baseline 中记录的文件内容发生变化时也会补入检查，避免恢复到 HEAD 后漏掉回归。

扫描范围始终是 Git 仓库。传入 workspace 子目录时，工具从该目录向 Git 根目录查找，不越过仓库边界。普通修改检查 JavaScript / TypeScript；配置、依赖、文件删除、重命名和子模块修改扩大到项目扫描。

| 退出码 | 结论 | 含义 |
| --- | --- | --- |
| 0 | `pass` | 所选检查没有阻塞项；skipped 与 warning 明确保留 |
| 1 | `block` | 存在新 error、未分类 error 或已确认的 regression |
| 2 | `incomplete` | 执行失败、零测试、协议异常、输入变化、baseline 不兼容等导致无法完成验证 |

默认报告展示至多 20 条诊断和 evidence 查询入口。`--json` 返回完整结果。Pass 仅覆盖本次所选检查。

## 配置分析器

在 Git 根目录创建 `prooflane.json`：

```json
{
  "analyzers": ["oxlint", "vitest", "knip", "react-doctor"],
  "concurrency": 2
}
```

只启用项目实际使用的工具；已启用但未安装的工具使验证 incomplete。所有进程使用本地包，不自动下载工具或执行修复。

| 分析器 | 已验收版本 | changed 策略 |
| --- | --- | --- |
| Oxlint | 1.74.0 / 1.87.0 | 变更文件，结构或配置变化时全量 |
| Vitest | 5.0.3 | 原生 related；没有执行测试时回退完整 suite |
| Knip | 6.41.0 | full 或结构/配置变化时检查项目图 |
| React Doctor | 0.9.17 | 有相关源码变化时检查完整项目 |

Vitest 强制非 watch、不更新 snapshot、不允许 only，也不将零测试算作成功。已有 Playwright 项目引入 Vitest 时，需要显式区分两者的测试文件。React Doctor 关闭远程评分、遥测与供应链联网扫描；本地规则仍受其项目配置控制。

## Baseline 与 evidence

```sh
node dist/cli.js baseline create --root /path/to/repository
node dist/cli.js baseline update --root /path/to/repository
node dist/cli.js baseline reset --root /path/to/repository
node dist/cli.js explain RUN_ID FINDING_ID --root /path/to/repository
node dist/cli.js explain RUN_ID vitest --root /path/to/repository
```

Baseline 命令执行完整验证；create 接纳初始问题，update 显式接纳当前问题并保留修复历史，reset 在配置或版本变化后重新建立基准。执行失败或覆盖范围不可信时拒绝写入。它们使用锁和原子写入，不会自动覆盖其他写入者。

普通验证不接纳新问题、不修改已接受的 baseline。它将确认修复的既有问题记录到本地 observations；问题再次出现即标为 regression。只有成功覆盖的文件、测试实体或项目图范围可以确认修复，未扫描、被忽略或跳过的测试不算已修复。

Baseline 包含 Vitest、Knip 或 React Doctor 历史 finding 时，`changed` 保守扩大到项目检查：诊断所在文件的摘要不能证明其依赖没有变化。这会增加检查成本，但避免被测实现恢复到 HEAD 后跳过历史回归。

Fingerprint 使用工具、规则、相对路径、严重性、诊断上下文及重复次数；测试使用完整测试名称作为实体。空行移动不改变匹配结果，同类问题增加会形成新 finding。任意符号重命名或重构后的语义身份不作保证。

- `.prooflane/baseline.json`：可审查、可提交的已接受状态。
- `.prooflane/observations.json`：本地确认修复历史；通过 baseline update 将历史写入可共享基准。
- `.prooflane/runs/`：诊断和有界原始证据，保留最近 20 次且总量限制为 64 MiB。

建议在目标项目忽略 `.prooflane/runs/`、`.prooflane/observations.*`、`.prooflane/*.lock` 和 `.prooflane/.tmp-*`。运行记录包含本地路径及工具输出，应按项目代码同等对待。

## MCP

```sh
node dist/cli.js mcp --root /path/to/repository
```

stdio 服务提供 `check_changes`、`check_project`、`explain`。项目根目录在启动时固定；工具参数不允许切换到任意目录。验证响应最多展示 20 条 finding，受 32 KiB 输出预算约束，保留总数和截断标记。失败分析器即使没有 finding 也可以通过 explain 查询证据。

## 验收

```sh
npm run check
npm run verify:project -- /path/to/foliosmith/epub
node scripts/benchmark-agent.mjs /path/to/foliosmith/epub --model MODEL
node scripts/benchmark-agent.mjs /path/to/foliosmith/epub --model MODEL --verification-only --output-dir artifacts/verification-benchmark
node scripts/benchmark-agent.mjs /path/to/foliosmith/epub --verification-only --prepare-only --output-dir artifacts/benchmark-preflight
```

`check` 包含类型检查、lint、构建、真实 CLI / MCP 和四个分析器的 E2E。`verify:project` 只在指定项目 HEAD 的临时副本中运行；对照直接工具结果，注入错误，再验证修复，不修改原项目。产物分别在 `artifacts/e2e/` 和 `artifacts/project/`。

Agent benchmark 会调用外部 Codex 模型，需拥有向该服务发送被测源码的授权。它使用相同模型、预算、交错顺序和独立 oracle，保留原始用量、补丁和失败结果。详情见 [benchmark 记录](docs/benchmark.md)。

只验证模式覆盖 8 个场景，默认每组重复 2 次（`--repetitions`），共 32 个会话；修复模式保留原有两个任务。`--prepare-only` 只执行预检和冻结输入重放，不调用模型。输出目录必须不存在，失败后使用新目录；不覆盖或自动重试已记录的会话。实验全部有效但存在错误判定时退出 1，执行不完整时退出 2。

## 边界

支持仓库内部文件符号链接及已初始化的 Git 子模块；外部链接、目录链接或未初始化子模块返回 incomplete，不自动初始化或访问网络。快照以四路并发流式读取文件；单进程输出上限 8 MiB，默认超时 60 秒，可通过 `--timeout-ms` 调整。

扫描前后比较文件、索引、HEAD、子模块状态与已知配置，不能替代原子文件系统快照。依赖目录、仓库外配置和未识别的动态配置依赖必须在扫描期间保持不变。已知根配置即使被 Git 忽略也参与兼容性检查。

Windows 使用系统 taskkill 清理进程树，macOS/Linux 使用进程组。平台验收状态见 [实现进度](docs/implementation.md)。分析器启发式与忽略规则仍会限制覆盖范围；本工具不提供“项目没有任何缺陷”的保证。

[设计文档](<Agent Verification Harness.md>) · [实现计划](docs/implementation.md) · [协议记录](docs/analyzer-protocols.md)

Let tools prove. Let agents decide.
