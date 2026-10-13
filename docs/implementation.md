# Implementation plan

## 已完成：基础 CLI 闭环

- [x] 单包 TypeScript / Node.js 项目，固定开发依赖与 lockfile。
- [x] Oxlint 真实 JSON 协议验证及适配。
- [x] `verify changed` / `verify full`，支持显式基准。
- [x] 区分 completed / skipped / failed 以及 pass / block / incomplete。
- [x] 紧凑终端报告和版本化 JSON 结果。
- [x] 有界输出、超时、取消及 POSIX 进程组清理。
- [x] 工作树变化检测；失败时不误报通过。
- [x] CLI 端到端回归测试与可保存的运行产物。
- [x] foliosmith/epub 临时副本真实验收：直接工具对照、注入错误、修复。
- [x] GitHub Actions 检查与测试产物上传，四个平台配置均已实际通过。

四个分析器已完成真实协议接入；核心 MVP 已实现，云端平台 matrix 的实际验收单独记录。

## P2：Baseline 与 evidence

- [x] 明确 fingerprint 的工具、规则、符号/上下文与重复问题身份策略；无语义信息时保守处理。
- [x] 显式创建/更新版本化 baseline，记录工具与配置兼容信息；普通验证不自动接受新问题。
- [x] 局部扫描只能比较覆盖范围；只有成功且覆盖充分的检查可以确认 resolved。
- [x] 记录 resolved 历史后才支持 regression；baseline 不兼容时要求显式处理。
- [x] 保存运行证据，实现 `explain <id>`；限制文件访问范围和返回大小。
- [x] 通过 CLI 测试空行移动、重复诊断、局部扫描、修复后重现及并发更新。

## P3：四分析器调度

- [x] 核实并接入 Vitest、Knip、React Doctor 的真实协议。
- [x] 基于工具真实能力制定选择规则和扩大范围条件；保存选择与跳过原因。
- [x] 有界并发和统一取消；单个工具失败不丢失其他已完成结果。
- [x] 用 foliosmith/epub 的实际适用检查验收，不把该项目已有构建、类型检查、Rust/WASM 或 Playwright 验收算成已覆盖。

## P4：MCP 与 benchmark

- [x] stdio MCP 暴露 `check_changes`、`check_project`、`explain`，复用 CLI 的核心执行入口。
- [x] 验证 CLI/MCP 语义一致、取消与输出预算。
- [x] 相同任务/模型/预算/工具版本进行有无 Harness 对照，由独立验收判断逃逸。
- [x] 记录任务成功率、验证逃逸、token、耗时和误报导致的修改。

暂不实现 AST 引擎、跨工具推断式关联、自动修复、云服务、Dashboard 或插件市场。

已修复的真实缺陷：baseline 接纳未提交修复后，恢复到 HEAD 的旧内容不会出现在 Git diff 中；现在通过 baseline 文件内容摘要补入检查范围，避免漏报 regression。

React Doctor 覆盖边界：字符串与对象属性渲染样例的诊断不同。规则实现包含启发式过滤，尚无独立 UI 回归证据；不将该差异统计成已确认漏检。

## 平台与大型仓库

- [x] workspace 工具定位，搜索范围止于 Git 根目录。
- [x] 仓库内部文件链接、已初始化子模块及脏子模块检测；越界链接与未初始化子模块明确失败。
- [x] 四路流式快照与千文件端到端验收。
- [x] Windows 进程树终止实现及跨平台 CI matrix。
- [x] Linux / Windows / macOS 云端 matrix 实际运行并通过。

2026-10-11，提交 `faafa5a` 的 [GitHub Actions 验收](https://github.com/sunnylost/proofLane/actions/runs/38105792791)完成：四组均通过安装、类型检查、lint、构建与 E2E，并上传独立测试产物。

| 平台 | Node | E2E 通过 | 跳过 |
| --- | --- | --- | --- |
| Linux | 22.13.0 | 43 | 0 |
| Linux | 24 | 43 | 0 |
| macOS | 24 | 43 | 0 |
| Windows | 24 | 42 | 1（POSIX SIGINT） |

Windows 的超时进程树清理、MCP stdin EOF 退出及内部/外部文件链接测试均实际通过；SIGINT 用例仅验证 POSIX 信号语义，不将其计为 Windows 已覆盖。

## 验收中发现并修复

- 修复未提交问题后恢复到 HEAD 的旧内容，Git diff 无法单独识别：补充 baseline 内容摘要。
- 普通验证确认修复后再次出现的问题被当成 existing：增加不接纳新问题的本地 observations。
- 删除已诊断文件后不被识别为 resolved：仅在完整覆盖且确认文件不存在时处理。
- 被 Git 忽略的已知根配置变化绕过 baseline 兼容性：加入配置内容摘要。
- 失败工具没有 finding，无法通过 explain 取证：增加分析器级查询与默认报告入口。
- benchmark 中 Vitest 误收集 Playwright spec，以及夹具未使用导入：保留首轮结果，修正测试归属与夹具，并增加完整验证预检。

- 验证摘要缺少断言失败详情，导致 Agent 额外取证：添加真实失败首行并复测，保留 token 反增与改善的全部轮次。
- MCP stdin EOF 后分析器继续运行：增加断连取消、等待清理和 EOF 端到端回归，修复了 Node 26 全量验收挂起。

真实 Agent 数据与样本边界见 [benchmark](benchmark.md)。

## 后续 P0：可信 benchmark 与扩展样本

- [x] Oracle 区分通过、确认缺陷和执行不完整；健康样本覆盖误阻塞。
- [x] 固定输入源码、构建、配置、版本、哈希与每次实际 prompt；拒绝覆盖旧试验。
- [x] 从 Git bundle 与 patch 重建 8 个场景，验证输入树及 oracle 一致。
- [x] 增加配对重复、明确统计分母、缺失用量及失败会话处理。
- [x] 修复真实预检发现的跨文件 baseline 漏检，CLI/Vitest 回归先失败后通过。
- [x] 完成随机目录标识下的 32 个真实 Agent 会话并记录全部结果：对照组 16/16 成功，Harness 15/16，一次保守退出；两组均无观测到的逃逸或误阻塞。Harness 总 token 减少 4.8%，总耗时增加 5.7%，不宣称全面改善。
- [x] 完成本次变更的跨平台 CI：[9776ceb 验收](https://github.com/sunnylost/proofLane/actions/runs/38107881408)，Linux Node 22.13/24 与 macOS Node 24 各 47 项通过，Windows Node 24 为 46 项通过、1 项 POSIX SIGINT 跳过。

## P1：真实接入、安装包与版本矩阵

- [x] 提供 Codex / 通用 stdio MCP 配置和随包交付的薄层 ProofLane Skill。
- [x] 实际 Codex CLI 0.160.0 / gpt-6.1-sol 通过 MCP 完成检查、explain、源码修复、局部复查和全量验收；独立 oracle 通过，只有目标源码变化。
- [x] 实际 Codex 正在等待 MCP 分析器时发送 SIGINT，确认工具已启动、客户端退出、分析器退出；已有 SDK E2E 继续覆盖协议取消后复用连接。
- [x] 修复干净源码 npm pack 缺少 dist 的真实缺陷：增加 prepack 构建。独立目录 omit=dev 安装 tarball，删除打包源码后，通过 CLI bin 和 MCP 完成发现问题、取证、修复后通过。
- [x] 统一最低/推荐/上界版本声明，低版本与预发布版本在启动前拒绝；真实最低/推荐版本测试和四类 baseline 升级拒绝/reset 验收通过。
- [x] 四组平台配置运行新增安装包验收；Linux Node 22.13/24 运行版本矩阵。[9f3e1a3 的六组 CI](https://github.com/sunnylost/proofLane/actions/runs/38110647145)全部通过，六份产物均已上传并核对。

常规检查：Linux Node 22.13/24 与 macOS Node 24 各 48 项通过；Windows Node 24 为 47 项通过、1 项 POSIX SIGINT 跳过。四组均额外通过独立安装包 E2E，Windows 包验收用时约 54 秒。两组 Linux 版本矩阵各完成最低/推荐组 5 项检查及 4 项真实版本 baseline 升级检查。

本地证据：`artifacts/package-red-entrypoint.log` 保留缺失入口的失败；`artifacts/package-green.log` 与 `artifacts/e2e/package-acceptance.json` 记录独立安装后的通过。`artifacts/e2e/compatibility/` 保存各版本报告和依赖锁。

真实 MCP 首轮被 Codex 非交互审批策略拦截，记录保留在 `artifacts/mcp-agent-p1`，没有计为通过。为已授权的三个工具配置临时精确预批准后，`artifacts/mcp-agent-p1-approved` 记录完整调用链和取消结果；全局客户端设置及原 EPUB 工作区保持不变。真实 Agent 取消验收限本机 POSIX；Windows 运行协议层取消与安装包 E2E，不冒充实际 Windows Codex 用户中断验收。

首轮新增 CI 发现两项验收环境问题：npm 10.9.2 在新目录解析最低版本组合时抛出 `edgesOut` 异常，本地使用同版本重现；版本矩阵改用固定 npm 11.20.0 安装，仍使用矩阵指定的 Node 执行所有检查。Windows 在打包夹具内重复 npm ci 超过 90 秒；夹具改为复用 CI 已安装的构建工具，仍从无 dist 的源码构建 tarball，在独立目录真实 omit=dev 安装，并删除打包源码后运行全部 CLI/MCP 断言。

## P2：真实仓库性能与最小 Policy 评估

- [x] 增加可重复的真实 HEAD 副本性能脚本，测量首次/重复调用、全量/局部、baseline、Harness RSS 和实际证据大小，保留失败与全部原始记录。
- [x] 对 Tara 的 2,568 文件 / 1,622 JS/TS 和 EPUB 的真实代码运行直接工具对照、错误注入、恢复验收；原仓库保持不变。
- [x] 按测量结果移除重复文件遍历与线性集合查找，保留内容快照和历史跨文件问题的全量保护；没有增加缓存。
- [x] 真实 CLI 回归发现并修复“解析错误将历史问题误记 resolved，恢复后误报 regression”；保留旧实现失败证据。
- [x] 23 次真实验证后确认只保留最近 20 条 evidence，外部验收目录保存完整记录。
- [x] 完成条件性 Policy 需求评估：两个试点可用现有分析器规则及 baseline 表达要求，暂不新增配置，默认 gate 不变。

方法、完整数字和限制见 [P2 性能与 Policy 记录](performance.md)。本机性能数字不能替代跨平台性能验收。

本地 `npm run check` 的类型检查、lint 和 49 项测试全部通过；独立安装包 CLI / MCP E2E 通过。首次包验收被沙箱对默认 npm 缓存的写入限制阻止；改用仓库内独立缓存完成安装和真实验收，未修改用户缓存权限。记录为 `artifacts/p2-check.log`、`artifacts/p2-package.log` 和 `artifacts/p2-package-isolated.log`。云端使用既有六组 [Check matrix](https://github.com/sunnylost/proofLane/actions/workflows/check.yml) 按提交验收。
