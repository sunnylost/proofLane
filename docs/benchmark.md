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

## 扩展试验协议（schemaVersion 2）

只验证模式现在包含 8 个预先定义的场景：健康的 location 修改、location size 缺陷、cache key 缺陷、CFI/搜索跨文件缺陷、正确的 profile 模块重命名、删除仍被引用的 profile 模块、删除 WASM 运行时依赖声明，以及 baseline 已确认修复后重现的测试缺陷。健康样本用于测量误阻塞；删除模块允许分析器保守返回 incomplete，不强求每个缺陷都被分类为 block。

每个场景默认重复 2 次，两组使用相同模型、high reasoning、240 秒上限。任务和重复轮次交替先运行的组别。修复模式仍使用原有两个任务；只验证模式禁止产品文件、测试、配置与 baseline 修改，并审查运行前后的 Git tree。

模型工作目录使用随机标识，不包含场景名、组别或预期结果；准备时的具名目录在模型启动前删除。第一轮扩展试跑发现目录名暴露了 healthy 标签，已在第四个会话中停止；前三个完整会话和无效原因保留在 `artifacts/benchmark-p0-expanded`，中断会话没有可用用量，整轮不进入有效比较。

独立 oracle 使用单独的 Vitest 配置和模型结束后才放入工作目录的断言。干净源码必须先通过；缺陷注入后必须得到预期结果；冻结输入重建后再次检查。依赖场景只验证运行时依赖声明契约，不声称验证安装、Rust/WASM 编译或浏览器行为。隐藏断言是独立于 Harness 的判定，不是对模型的安全隔离边界。

- `pass`：唯一的 contract 测试执行并通过，报告计数与退出码一致。
- `defect`：唯一的 contract 测试以断言失败结束，报告计数与退出码一致。
- `incomplete`：缺失报告、超时、崩溃、收集失败、跳过测试、非断言异常或矛盾统计。不能计为已确认缺陷。

任务成功率以全部已尝试会话为分母，包括模型调用失败。逃逸率只在模型会话完整且 oracle 确认缺陷时计算；误阻塞率只在会话完整且 oracle 通过时计算。模型的 incomplete 判定单列为 abstention。缺失用量保留为 null，不当作零 token；配对 token 差值只使用两组都完整且有用量的样本。汇总保留每次结果、分母、总量、最小值、中位数、P90、最大值及配对差值；小样本 P90 不能替代统计显著性检验。

输出目录不可复用，单次调用失败不终止剩余会话；失败轮次不覆盖、不自动重试。`summary.complete` 表示全部计划会话完成且证据有效，不等同全部任务正确。全部有效但有错误判定时脚本退出 1；存在执行不完整时退出 2。

### 冻结与重放

每轮保存 `manifest.json`、`frozen/source.bundle`、冻结的 Harness dist/scripts/package/lock、每个场景的增量 Git bundle、工作目录 patch、任务定义与 oracle。manifest 记录源码/代码版本、代码是否含未提交改动、实际 Node/Codex/分析器版本、模型预算、输入 Git tree 和 SHA-256。会话保存实际 prompt、原始 JSONL、stderr、修改 diff、oracle 原始报告和判定。

运行准备检查，无模型请求：

```sh
node scripts/benchmark-agent.mjs /path/to/epub --verification-only --prepare-only --output-dir artifacts/new-preflight
```

重建某个已保存的输入时，从 `frozen/source.bundle` clone，fetch 对应 `frozen/cases/<task>/commits.bundle` 的 HEAD，checkout manifest 中该场景的 head，再 apply 非空 `working-tree.patch`。在冻结目录执行 `npm ci` 后，将其 oxlint/vitest 包链接到重建目录的 node_modules；使用冻结 dist 中的 CLI。脚本自身对每个输入执行这条重建路径，并断言 `git write-tree` 等于记录的 inputTree，再重跑 oracle。重放输入不保证外部模型输出或 token 逐字节相同。

### 扩展预检发现的产品缺陷

Vitest finding 的位置是测试文件；旧的 baseline 文件摘要无法捕获被测实现的变化。实现修复后回退到 HEAD，Git 与测试文件都不变，changed 验证跳过测试并错误返回 pass。扩展场景的冻结重放捕获了此问题；真实 CLI/Vitest 回归在修复前失败，修复后通过。

现在 baseline 中存在 Vitest、Knip 或 React Doctor 历史问题时，changed 扩大到项目检查；在没有完整依赖摘要的情况下，接受额外检查成本。失败预检保存在 `artifacts/benchmark-p0-replay`，修复后的重放保存在 `artifacts/benchmark-p0-replay-fixed`。
