# ProofLane

A local-first verification harness for coding agents.

ProofLane 将现有工程分析工具的结果统一为可验证的工程事实，为 Coding Agent 提供变更检查、baseline 比较和按需展开的证据。

## 当前状态

项目处于初始化阶段，尚未实现 CLI 或 MCP 服务。

- 设计文档：[Agent Verification Harness](<Agent Verification Harness.md>)。
- MVP 面向 TypeScript / React，计划接入 Oxlint、Knip、React Doctor 和 Vitest。
- 实现顺序：工具协议验证 → CLI 验证闭环 → baseline 与 evidence → 多分析器调度 → MCP 与 benchmark。
- 后续使用 `foliosmith/epub` 作为真实测试项目，按其实际技术栈和已有检查确定验证范围。

Let tools prove. Let agents decide.
