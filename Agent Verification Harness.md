# Agent Verification Harness

> **A deterministic verification layer between coding agents and engineering tools.**
>
> 不再让 coding agent 自己记住、调用、解析和理解所有检查工具，而是把现有工程工具统一成一个低 token、可验证、可扩展的工程事实接口。

---

## 1. 项目定位

Agent Verification Harness 是一个面向 AI Coding Agent 的本地代码验证基础设施。

它不试图重新实现 Oxlint、Knip、React Doctor、Vitest、Gitleaks、dependency-cruiser 等已有工具，而是将它们作为独立的 **Analyzer**，在其上建立统一的：

- 调度机制
- Scope 判断
- Finding 数据模型
- Baseline
- Fingerprint
- Evidence
- Confidence
- 去重与关联
- Gate Policy
- MCP / CLI / CI 接口

最终目标是让 Agent 不再面对：

```text
大量 CLI
不同参数
不同 JSON
不同日志格式
不同执行时机
不同退出码
不同 severity
不同扫描粒度
```

而只面对一个稳定协议：

```text
Verify this change.
```

以及统一的：

```text
Finding[]
```

---

# 2. 核心问题

现代 TypeScript / React / Electron 项目已经拥有大量优秀的工程检查工具：

```text
Oxlint
React Doctor
@shadcn/lint
Knip
Vitest
Playwright
Gitleaks / TruffleHog
dependency-cruiser
TypeScript
...
```

问题已经不再是：

> 有没有工具能够发现问题？

而是：

> Coding Agent 如何正确、稳定、低成本地使用这些工具？

目前不同工具有完全不同的生命周期。

例如：

```text
Oxlint
→ pre-commit / editor

React Doctor
→ 修改 React 后主动运行

Knip
→ 定期或重构后运行

Vitest
→ 修改逻辑后运行 related tests

Coverage
→ CI / risky change

Secret scanner
→ commit / CI

Architecture checks
→ architecture changes
```

这种差异本身是合理的。

真正的问题是，目前这些知识通常存在于：

```text
AGENTS.md
Skill
Prompt
CI YAML
package.json scripts
开发者经验
Agent 自己的 reasoning
```

Agent 因而需要反复完成大量本可机械化的工作：

```text
我修改了什么文件？
↓
应该运行哪些工具？
↓
每个工具怎么调用？
↓
应该使用哪些参数？
↓
输出意味着什么？
↓
哪些问题是历史问题？
↓
哪些问题是当前修改引入的？
↓
两个工具是不是报告了同一个问题？
↓
这个 warning 是否值得修？
↓
是否已经满足 Definition of Done？
```

这既消耗 token，也降低验证可靠性。

---

# 3. 项目的核心命题

Agent Verification Harness 建立在一个原则上：

> **能由确定性程序判断的事情，不应该反复交给语言模型推理。**

Coding Agent 最稀缺的资源应该用于：

- 理解需求
- 设计方案
- 编写代码
- 判断复杂 trade-off
- 修复真正的问题

而不是用于：

- 阅读 500 行 lint 输出
- grep 整个项目寻找未使用函数
- 手动比对 IPC handler 和 caller
- 判断测试命令应该怎么运行
- 解析不同工具的 JSON schema

Harness 应该尽可能把：

```text
Repository
```

压缩成：

```text
Engineering Facts
```

再把真正需要 reasoning 的事实交给 Agent。

---

# 4. 项目不是什么

## 4.1 不是新的 Linter

本项目不会重新实现：

```text
Oxlint
Knip
React Doctor
Vitest
Gitleaks
dependency-cruiser
```

除非某个项目级 invariant 无法由现有工具表达。

原则：

> **Prefer integration over reimplementation.**

---

## 4.2 不是 MegaLinter

MegaLinter 解决的是：

> 如何统一运行很多 linter。

Harness 解决的是：

> 当前修改应该运行什么，以及这些结果对 Agent 意味着什么。

运行工具只是底层能力之一。

---

## 4.3 不是 SonarQube 替代品

Harness 不试图成为集中式代码质量平台。

它首先是：

```text
local-first
agent-first
change-aware
repository-aware
```

的 verification runtime。

---

## 4.4 不是 Coding Agent

Harness 不决定：

```text
应该如何重构？
架构是否优雅？
这个 abstraction 是否合理？
```

它只提供证据：

```text
违反了什么 invariant？
哪里违反？
为什么？
这是新问题还是历史问题？
确定性有多高？
```

最终判断仍由 Agent 或开发者完成。

---

# 5. 核心价值

Harness 的价值不来自：

> “支持 20 个 lint 工具。”

而来自以下五个能力。

---

## 5.1 Change-aware Verification

不是：

```text
run everything
```

而是：

```text
What changed?
    ↓
What can this change affect?
    ↓
Which verification is relevant?
```

例如：

```text
修改 Button.tsx

→ Oxlint
→ React Doctor
→ shadcn lint
→ related Vitest

不运行：

→ full Knip
→ full architecture graph
→ full E2E
```

修改：

```text
package.json
src/main/
src/preload/
```

则可能触发：

```text
Oxlint
Knip
dependency graph
Electron boundary checks
IPC graph
related tests
```

Harness 把验证从：

```text
tool-oriented
```

变成：

```text
change-oriented
```

---

# 6. Analyzer Federation

所有底层检查能力统一视为：

```text
Analyzer
```

例如：

```text
Static Analyzer
├── Oxlint
├── TypeScript
└── React Doctor

Graph Analyzer
├── Knip
├── dependency-cruiser
└── custom project graph

Runtime Analyzer
├── Vitest
├── Playwright
└── Coverage

Security Analyzer
├── Gitleaks
└── TruffleHog

Domain Analyzer
└── project-specific rules
```

Analyzer 可以被替换。

例如今天：

```text
dead code → Knip
```

未来可以替换成：

```text
dead code → Fallow
```

而 Agent 完全不需要知道这一变化。

---

# 7. Finding IR

整个项目最核心的 abstraction 是统一的 **Finding Intermediate Representation**。

例如：

```ts
interface Finding {
  id: string
  fingerprint: string

  rule: string
  category: FindingCategory

  severity:
    | "error"
    | "warning"
    | "info"

  confidence:
    | "certain"
    | "high"
    | "medium"
    | "heuristic"

  source: string

  location?: {
    file: string
    line?: number
    column?: number
  }

  message: string

  evidence?: EvidenceRef[]

  status:
    | "new"
    | "existing"
    | "regression"

  fix?: {
    autoFixable: boolean
    description?: string
  }
}
```

任何 analyzer：

```text
Oxlint
Knip
React Doctor
Vitest
Gitleaks
```

最终都必须转换为：

```text
Finding[]
```

Agent 不需要理解底层工具。

---

# 8. Evidence，而不是 Raw Output

Harness 默认不应该把完整输出发送给 Agent。

例如 Knip 产生：

```text
几百条 raw output
```

Harness 默认只返回：

```text
WARN dead-code/unused-export

src/utils/parser.ts:82

Export `legacyParser` has no reachable consumers.
```

如果 Agent 需要更多信息：

```text
explain(finding)
```

再获取：

```text
definition
references
dependency path
analyzer reasoning
related findings
raw source result
```

这是一种：

> **Progressive Disclosure for Agents**

原则：

> Agent context 中的信息密度应该尽可能高。

---

# 9. Fingerprint

Finding 不应该依赖：

```text
file + line number
```

因为一次简单修改就会导致：

```text
line 42
→ line 47
```

Harness 应生成稳定 fingerprint，用于识别：

```text
same issue
new issue
existing issue
fixed issue
regression
```

例如基于：

```text
rule
+
semantic entity
+
symbol
+
AST context
+
stable source identity
```

生成 fingerprint。

这是 Baseline 和增量验证成立的基础。

---

# 10. Baseline

成熟项目第一次运行 Harness 很可能出现：

```text
537 findings
```

Harness 不要求：

```text
fix everything
```

而是支持：

```text
537 existing

Current change:

+2 new
-4 fixed
```

默认 Policy：

```text
historical issue
→ 不阻塞

new error
→ 阻塞

regression
→ 阻塞
```

Harness 的目标不是强迫老项目一次达到理想状态，而是：

> **保证代码库不会因为 Agent 的修改继续退化。**

---

# 11. Confidence

不同工具的判断确定性不同。

例如：

```text
Syntax Error
→ certain

Missing Type
→ certain

Unused export
→ high

Possible dead API
→ medium

Possible architecture smell
→ heuristic
```

Harness 明确保留这一差异。

Agent 可以据此采用不同策略：

```text
certain
→ 必须处理

high
→ 默认处理

medium
→ 检查证据

heuristic
→ reasoning / human judgement
```

这样能够避免：

> lint 越多，Agent 被误报拖得越慢。

Harness 的原则是：

> **Precision before Recall.**

---

# 12. Correlation

统一 Finding 后，可以实现单个 analyzer 无法完成的事情：

```text
Knip:
unused export

dependency-cruiser:
unreachable module

Vitest:
no coverage

Git:
6 months untouched
```

Harness 可以将它们关联为：

```text
Possible dead subsystem
confidence: high
```

因此长期价值不仅是：

```text
aggregate
```

而是：

```text
correlate
```

从：

```text
tool result
```

逐渐升级成：

```text
engineering fact
```

---

# 13. Policy Engine

Analyzer 负责发现事实。

Policy 决定事实意味着什么。

例如：

```ts
policy({
  "lint/error": "block",

  "dead-code/unused-export": {
    severity: "warning",
    blockWhen: "new"
  },

  "coverage/regression": {
    threshold: -5,
    block: true
  },

  "security/secret": "block",

  "architecture/cycle": {
    blockWhen: "new"
  }
})
```

因此：

```text
Analyzer
≠
Policy
```

这能够避免把团队决策硬编码进 analyzer。

---

# 14. Verification Profiles

Harness 不应该只有：

```text
verify all
```

而应该提供语义化 Profile。

例如：

```text
verify changed
```

日常 Agent 修改后的快速检查。

---

```text
verify commit
```

提交前 gate。

---

```text
verify architecture
```

重构或架构修改。

---

```text
verify security
```

安全相关修改。

---

```text
verify full
```

CI / PR / release。

底层 analyzer 组合由 Harness 决定。

Agent 不需要指定：

```text
run knip
run oxlint
run react-doctor
```

---

# 15. Execution Model

推荐架构：

```text
                     Repository
                         │
                         ▼
                     Git Diff
                         │
                         ▼
                Change Classifier
                         │
                         ▼
                  Policy / Profile
                         │
                         ▼
                    Scheduler
                         │
       ┌─────────────────┼──────────────────┐
       ▼                 ▼                  ▼
    Oxlint              Knip          React Doctor
       │                 │                  │
       ├───── Vitest ────┼── Security ─────┤
       │                 │                  │
       └─────────────────┴──────────────────┘
                         │
                         ▼
                      Adapter
                         │
                         ▼
                    Finding IR
                         │
             ┌───────────┼────────────┐
             ▼           ▼            ▼
          Dedupe     Fingerprint   Correlate
             │           │            │
             └───────────┼────────────┘
                         ▼
                      Baseline
                         │
                         ▼
                       Policy
                         │
                         ▼
                Verification Result
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
         CLI            MCP             CI
                          │
                          ▼
                     Coding Agent
```

---

# 16. CLI / MCP / Skill 的职责

## CLI

确定性入口：

```bash
verify changed
verify commit
verify full
verify architecture
```

用于：

```text
开发者
Git hook
CI
脚本
```

---

## MCP

Agent-facing capability interface。

只暴露少量高层工具：

```text
verification.check_changes
verification.check_files
verification.check_project
verification.explain
verification.status
```

不要暴露：

```text
run_knip
run_oxlint
run_react_doctor
run_gitleaks
...
```

Agent 应该表达：

> 我要验证当前修改。

而不是：

> 我要运行工具 X。

---

## Skill

Skill 只负责薄薄一层 workflow guidance：

```text
After implementing code:
→ check_changes

After architecture changes:
→ architecture profile

Before completing a task:
→ no unresolved new errors
```

Skill 不负责：

```text
CLI 参数
输出格式解析
工具选择
baseline
severity conversion
```

这些属于 Harness。

---

# 17. Agent 与 Harness 的责任边界

Harness：

```text
发现
归一化
过滤
去重
关联
提供证据
提供风险等级
执行 policy
```

Agent：

```text
理解原因
判断修改方式
实施修复
处理 trade-off
决定特殊情况下是否 suppress
```

因此系统不是：

```text
Harness decides everything
```

也不是：

```text
Agent decides everything
```

而是：

```text
Program establishes facts.
Agent makes decisions.
```

---

# 18. Custom Rules 的定位

自定义 analyzer 只应用于已有工具无法表达的项目 invariant。

例如 Electron 项目：

```text
electron/no-node-api-in-renderer

electron/orphan-ipc-handler

electron/missing-ipc-handler

electron/ipc-contract-mismatch

electron/unsafe-context-bridge

architecture/no-renderer-main-import

api/no-unused-trpc-procedure

api/schema-boundary-validation

agent/unhandled-tool-result
```

原则：

> 通用问题交给通用 analyzer。

> 项目知识才进入 custom analyzer。

---

# 19. 与现有项目的差异

## Fallow

Fallow：

```text
build a better unified analyzer
```

Harness：

```text
federate the best existing analyzers
```

Harness 不需要在 dead-code analysis 上打败 Knip。

只需要知道：

```text
什么时候应该运行 Knip
如何解释 Knip
如何与其他证据关联
```

---

## MegaLinter

MegaLinter：

```text
run many linters
```

Harness：

```text
decide what verification matters for this change
```

---

## SonarQube

Sonar：

```text
centralized code quality platform
```

Harness：

```text
local agent verification runtime
```

---

## reviewdog

reviewdog：

```text
normalize diagnostics
→ review / CI reporting
```

Harness：

```text
normalize engineering evidence
→ Agent decision making
```

---

## Repowise

Repowise：

```text
precomputed code intelligence
```

Harness：

```text
deterministic verification
```

未来两者甚至可以互补：

```text
Code Intelligence
+
Verification Facts
```

共同为 Agent 提供环境。

---

# 20. Design Principles

项目需要坚持以下原则。

### 1. Deterministic before probabilistic

可以由代码检查的，不让 LLM 猜。

---

### 2. Integrate before reimplement

已有成熟工具优先复用。

---

### 3. Intent over tools

Agent 表达：

```text
verify my change
```

而不是：

```text
run tool X
```

---

### 4. Change-aware by default

默认只验证与当前修改相关的内容。

---

### 5. Progressive disclosure

默认提供最少但充分的信息。

需要时再展开 Evidence。

---

### 6. Local-first

核心分析不依赖 SaaS。

---

### 7. Agent-agnostic

不绑定：

```text
Codex
Claude Code
Cursor
OpenCode
```

MCP / CLI 都只是 Adapter。

---

### 8. Analyzer-agnostic

不绑定：

```text
Knip
Oxlint
React Doctor
```

Analyzer 可以替换。

---

### 9. Precision over noise

10 个可信问题胜过 100 个可疑 warning。

---

### 10. Verification is evidence, not judgement

Harness 提供事实。

复杂工程决策由 Agent / Human 做。

---

# 21. MVP

第一版明确控制范围。

只支持：

```text
TypeScript
React
```

集成：

```text
Oxlint
Knip
React Doctor
Vitest
```

实现：

```text
Finding IR

Analyzer Adapter

changed-file detection

basic scheduler

parallel execution

baseline

fingerprint

compact CLI reporter

JSON output

MCP server
```

CLI：

```bash
verify changed
verify full
verify explain <id>
```

MCP：

```text
check_changes
check_project
explain
```

---

# 22. MVP 不做

第一版不做：

```text
自建 AST linter

复杂 TypeScript semantic engine

完整 dependency graph engine

自动修改代码

AI review

云平台

IDE extension

Dashboard

几十种语言

几十种 analyzer
```

MVP 的目标不是：

> 覆盖所有代码质量问题。

而是验证：

> **统一 Verification Layer 是否真的能让 Agent 更可靠、更省 token。**

---

# 23. 项目的核心 Benchmark

这个项目最终必须用 Agent benchmark 证明价值。

对同一组真实工程任务：

## Control

```text
Agent
+ AGENTS.md
+ standalone tools
+ standalone skills
```

## Harness

```text
Agent
+ Verification Harness
```

记录：

```text
Task success rate

Verification escape rate

Forgotten checks

Tool calls

Input tokens

Output tokens

Verification tokens

Wall-clock verification time

False-positive-induced edits

Regression rate
```

最核心的三个指标：

```text
Verification escape ↓

Verification token cost ↓

Task success rate ↑
```

项目的价值不是：

> 我们支持 14 个 analyzer。

而是：

> **Agent 在更少上下文、更少工具调用下，完成了更可靠的工程验证。**

---

# 24. 长期方向

MVP：

```text
Analyzer Federation
```

之后：

```text
Finding Correlation
```

再之后：

```text
Project Invariants
```

最终可能发展为：

```text
Repository Verification Graph
```

其中节点包括：

```text
File
Symbol
Module
Package
API
IPC Channel
Test
Dependency
Rule
Finding
Commit
```

然后回答的不再只是：

```text
有没有 lint error？
```

而是：

```text
这次修改破坏了哪些工程 invariant？

哪些风险是当前 change 引入的？

哪些 API 已经成为 orphan？

哪些 architecture boundary 被突破？

哪些问题由多个 analyzer 独立确认？

Agent 是否已经获得足够证据证明任务完成？
```

---

# 25. 项目最终愿景

今天的 Coding Agent 工作方式往往是：

```text
Read code
↓
Guess
↓
Change code
↓
Run random tools
↓
Read logs
↓
Guess again
```

Harness 希望把它逐渐变成：

```text
Understand task
↓
Change code
↓
Verify
↓
Receive structured engineering facts
↓
Fix actual violations
↓
Prove Definition of Done
```

最终：

> **让 Agent 不再通过阅读整个 repository 来重新发现已经可以由程序证明的事实。**

---

# 26. 一句话定义

**Agent Verification Harness is a local-first verification runtime that federates existing engineering analyzers, turns their outputs into structured engineering facts, and gives coding agents the minimum evidence required to safely complete code changes.**

中文：

> **Agent Verification Harness 是位于 Coding Agent 与现有工程工具之间的本地验证层：它不重新发明分析器，而是统一调度、归一化和关联现有工具的分析结果，以最低上下文成本向 Agent 提供可验证的工程事实。**

---

# 27. 项目 Slogan

推荐：

> **Let tools prove. Let agents decide.**

备选：

> **Engineering facts for coding agents.**

或者更强调 token：

> **Less context. More certainty.**

但最推荐：

> **Let tools prove. Let agents decide.**

因为它准确表达了项目最核心的边界：

```text
Tool
→ establish facts

Agent
→ make decisions
```