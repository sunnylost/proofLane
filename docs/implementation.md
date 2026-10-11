# Implementation plan

## 当前交付：P1 Oxlint CLI 闭环

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

P0 的 Oxlint 协议已完成；其余三个分析器的协议验证随各自接入完成。当前交付不代表完整 MVP。

## P2：Baseline 与 evidence

- [ ] 明确 fingerprint 的工具、规则、符号/上下文与重复问题身份策略；无语义信息时保守处理。
- [ ] 显式创建/更新版本化 baseline，记录工具与配置兼容信息；普通验证不自动接受新问题。
- [ ] 局部扫描只能比较覆盖范围；只有成功且覆盖充分的检查可以确认 resolved。
- [ ] 记录 resolved 历史后才支持 regression；baseline 不兼容时要求显式处理。
- [ ] 保存运行证据，实现 `explain <id>`；限制文件访问范围和返回大小。
- [ ] 通过 CLI 测试空行移动、重复诊断、局部扫描、修复后重现及并发更新。

## P3：四分析器调度

- [ ] 核实并接入 Vitest、Knip、React Doctor 的真实协议。
- [ ] 基于工具真实能力制定选择规则和扩大范围条件；保存选择与跳过原因。
- [ ] 有界并发和统一取消；单个工具失败不丢失其他已完成结果。
- [ ] 用 foliosmith/epub 的实际适用检查验收，不把该项目已有构建、类型检查、Rust/WASM 或 Playwright 验收算成已覆盖。

## P4：MCP 与 benchmark

- [ ] stdio MCP 暴露 `check_changes`、`check_project`、`explain`，复用 CLI 的核心执行入口。
- [ ] 验证 CLI/MCP 语义一致、取消与输出预算。
- [ ] 相同任务/模型/预算/工具版本进行有无 Harness 对照，由独立验收判断逃逸。
- [ ] 记录任务成功率、验证逃逸、token、耗时和误报导致的修改。

暂不实现 AST 引擎、跨工具推断式关联、自动修复、云服务、Dashboard 或插件市场。
