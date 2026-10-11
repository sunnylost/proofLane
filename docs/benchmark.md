# Real agent benchmark

这是真实 EPUB 代码上的小规模故障注入实验，不是生产事故统计或普遍性能保证。保留所有轮次，包括 Harness 更慢、更耗 token 的结果。

## 方法

- 来源：foliosmith/epub，commit `2af31b07735c86d5497eb929583ff6b47b967393`，仅使用临时副本。
- 两个任务：恢复正整数 location size 归一化；恢复书籍 location cache key 的组件转义。
- 同一模型 `gpt-6.1-sol`，reasoning effort `high`，每个 session 240 秒上限，Codex CLI 0.160.0。任务间交错执行 control/harness 顺序。
- 独立 oracle 先在原始实现上通过，再确认能发现注入缺陷；模型结束后验证不同边界输入。修复任务禁止修改测试、配置与 baseline，并审查实际补丁。
- 只验证阶段禁止修改源码，以模型最终 verdict 与独立 oracle 比较；该阶段的实际 input/output usage 才计作 verification token，不从整段修复会话臆测归因。
- 原项目 Git 状态前后相同。源码发往 Codex 前取得了用户明确授权。

## 全部结果

每行汇总两个任务；cached input 是 input 的子集，不重复相加。Token 不是费用，未用未核实价格计算金额。耗时含独立验收。

| 轮次 | 组别 | Input | Cached input | Output | 全部命令 | 耗时秒 | 正确结果 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 初轮：配置未隔离 | control | 393,167 | 347,136 | 2,584 | 22 | 110.2 | 2/2 |
| 初轮：配置未隔离 | harness | 707,908 | 638,336 | 4,209 | 22 | 162.7 | 2/2 |
| 修复任务：明确测试归属 | control | 387,080 | 341,760 | 3,238 | 21 | 130.7 | 2/2 |
| 修复任务：明确测试归属 | harness | 267,510 | 236,288 | 1,669 | 13 | 112.1 | 2/2 |
| 只验证：简略失败摘要 | control | 196,452 | 138,880 | 1,415 | 12 | 72.9 | 2/2 |
| 只验证：简略失败摘要 | harness | 210,947 | 156,800 | 1,551 | 16 | 82.8 | 2/2 |
| 只验证：包含失败原因 | control | 259,579 | 197,760 | 1,677 | 22 | 85.4 | 2/2 |
| 只验证：包含失败原因 | harness | 187,690 | 134,400 | 1,690 | 15 | 81.3 | 2/2 |

## 发现与修正

1. 初轮 Vitest 把 EPUB 的 Playwright spec 纳入自己的默认扫描，夹具又有未使用导入。Harness 正确返回 incomplete，但 Agent 被迫额外排查或调用原始工具；该轮不用于宣称收益。已在临时副本明确 Vitest 的测试归属、移除无效夹具导入，并增加完整验证预检。原有 Playwright 检查没有被宣称已覆盖。
2. 明确测试归属后的修复任务，两组均通过独立 oracle；Harness 总 input+output 为 269,179，对照为 390,318，少约 31.0%。审查四个实际补丁，只修改了目标函数，没有无关改动。
3. 第一轮只验证任务，Harness 为 212,498 token，对照为 197,867，反而多约 7.4%。轨迹显示测试摘要只含测试名，缺少 expected/actual，增加了取证成本。
4. 增加真实断言失败首行后，另做一次相同任务、相同模型与预算的只验证测量：Harness 为 189,380 token，对照为 261,256，少约 27.5%。四次 verdict 均为 block，与独立 oracle 一致，没有源码修改。

## 解释边界

- 两个任务同属一个模块，样本小；模型随机性、上下文缓存和工具选择均影响结果。无法把不同轮次的差额全部归因于单一代码修改。
- 这些样本未出现验证逃逸或独立 oracle 检出的回归，也未观察到无关修改；不能外推为通用逃逸率、回归率或可自动归因的误报修改率。
- React Doctor 对两种数组 key 样例给出不同诊断，规则实现带启发式过滤；没有独立 UI 回归证明，未计入已确认漏检。
- 初轮和修复任务轮保留 JSONL、patch 和 oracle 输出；后续只验证轮还保存了冻结的 Harness 构建及 package lock。旧轮次没有单独保存构建，不作可逐字节重建的声明。
- 外部模型能力、费用和大型跨项目收益不在这次验收结论内。

## 复现与产物

```sh
npm run build
node scripts/benchmark-agent.mjs /path/to/foliosmith/epub --model gpt-6.1-sol --output-dir artifacts/benchmark-repair
node scripts/benchmark-agent.mjs /path/to/foliosmith/epub --model gpt-6.1-sol --verification-only --output-dir artifacts/benchmark-verification
```

产物在 `artifacts/benchmark*`：summary、原始 JSONL 用量、stderr、模型 patch、独立 oracle 输出，以及后续运行的冻结构建。默认不提交源码输出和会话轨迹。

Codex JSONL 用量接口依据 [OpenAI 官方非交互模式文档](https://learn.chatgpt.com/docs/non-interactive-mode)。
