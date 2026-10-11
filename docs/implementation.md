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
- [x] GitHub Actions 检查与测试产物上传配置；远端执行待推送后确认。

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
- [ ] Linux / Windows / macOS 云端 matrix 实际运行，待推送后确认。

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
