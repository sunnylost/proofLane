# P2：真实性能测量与 Policy 评估

2026-10-13 在 Apple M2 Pro（10 核、32 GiB）、macOS Darwin 27、Node 26.11.0、Oxlint 1.87.0 上执行。原工作区已有未提交改动，全部测量使用 HEAD 临时副本；未修改原工作区。

## 方法和范围

```sh
npm run benchmark:performance -- /path/to/repository --output-dir artifacts/performance-run
npm run benchmark:performance -- /path/to/repository --output-dir artifacts/performance-retention --repetitions 5
```

输出目录必须不存在。脚本只在临时副本选择 Oxlint 并链接本仓库的固定版本工具，保留被测项目的 Oxlint 规则。baseline 由真实 CLI 显式创建并提交到临时副本；单文件场景给一个实际检查过的 TS 文件追加换行。另追加非法语法，验证 block，去掉非法文本后验证 pass。直接 Oxlint 诊断与 Harness 的完整诊断逐项对照；任何断言失败均保留已有产物和失败摘要，并非为了计时忽略正确性。

每个场景的每次调用均启动新 Node 进程。首次调用前 clone 已读过文件，且没有清理操作系统缓存；这里的首次调用不等于冷缓存。默认每组 3 次，顺序固定，系统其他工作未被隔离，数字用于定位成本，不作统计显著性或跨机器速度承诺。

- `wallMs`：父进程测得的 CLI 启动至退出时间。
- `analyzerMs`：现有分析阶段计时，包含工具启动、规则检查、覆盖文件列表及校验；不等同于原生 lint 用时。
- `harnessMaxRssKiB`：Node `process.resourceUsage().maxRSS`，仅 Harness 进程，不包含分析器子进程或整个进程树。
- `evidenceBytes`：实际保存的运行 JSON 大小，包括原始工具输出。每次 JSON、stderr、资源记录及持久化证据均复制到输出目录。
- 摘要记录来源 revision、HEAD 文件数/字节数、工具版本、配置覆盖、源码变更哈希及构建产物哈希。原工作区检查比较 HEAD、Git 状态及 tracked diff 哈希；被忽略文件和未跟踪文件内容不属于这项完整性检查。

## 真实样本结果

| 项目 | HEAD | tracked 文件 | JS/TS 文件 | tracked 字节 | Oxlint 实际检查 |
| --- | --- | ---: | ---: | ---: | ---: |
| Tara/1code_sd | `cabcd4d46a9aed209d88e2b1b064af2b527e8c2a` | 2,568 | 1,622 | 24,222,208 | 1,622 |
| foliosmith/epub | `2af31b07735c86d5497eb929583ff6b47b967393` | 193 | 119 | 1,595,402 | 120 |

EPUB 的 Oxlint 文件列表还包含一个 Svelte 文件，统计以真实工具覆盖为准。Tara 是本次较大真实样本；不能外推到数十万文件或 GB 级工作树。

下表墙钟时间为各组 3 次的中位数，包含首次调用；RSS 为优化后各组的最大值，证据大小为该组第一条。优化前为 `bdea89c` 的实现，优化后去掉一次重复工作树遍历，以 Set 查询覆盖文件，未引入跨调用缓存。

| 项目 / 场景 | 优化前 ms | 优化后 ms | 优化后分析阶段中位 ms | Harness 峰值 MiB | 单条证据字节 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Tara full | 1,237 | 1,282 | 416 | 127.5 | 212,175 |
| Tara baseline full | 1,239 | 1,141 | 373 | 128.0 | 212,175 |
| Tara 无修改 changed | 855 | 821 | 0 | 126.1 | 682 |
| Tara 单文件 changed | 1,251 | 1,187 | 306 | 129.0 | 1,390 |
| EPUB full | 589 | 573 | 257 | 79.5 | 14,986 |
| EPUB baseline full | 563 | 548 | 255 | 79.6 | 14,977 |
| EPUB 无修改 changed | 313 | 318 | 0 | 77.7 | 682 |
| EPUB 单文件 changed | 575 | 559 | 240 | 77.7 | 1,406 |

优化前 / 后首个 full 分别为 Tara 1,338 / 1,282 ms、EPUB 635 / 608 ms。直接 Oxlint 单次全量耗时分别为 Tara 171 / 194 ms、EPUB 118 / 120 ms。Harness 在执行规则之外还维护快照、覆盖、baseline 和持久化证据；即使没有修改，也需要验证当前工作树。

Tara 单文件中位耗时降低约 5.1%，有 baseline 的全量降低约 7.9%，但无 baseline 的 full 中位耗时上升约 3.6%；不宣称全面提速。工作树一致性检查仍占明显成本，本次只移除可确认的重复工作，不以 mtime 缓存替换内容快照，也保留非局部历史诊断强制全量的保护。

另以最终实现运行 Tara 每组 5 次，共 23 次 CLI 调用，全部完成。运行目录最终保留 20 条、1,711,308 字节；外部输出目录保留全部 23 次证据，便于审计被轮转的记录。这覆盖条数轮转，未压测 64 MiB 容量边界。

本地产物：

- `artifacts/performance-{tara,epub}-before/`：初始测量，全部保留。
- `artifacts/performance-{tara,epub}-after/`：优化后各组 3 次，表格来源。
- `artifacts/performance-tara-retention/`：最终构建 SHA-256 `1c4c0323cd7464f21a90a184a6784ad15b44b02ce835c77f26a466141c8aa233`，每组 5 次及条数轮转验收。

真实仓库性能测量限本机，跨平台 CI 验证的是同一脚本的行为和回归，不将它算作 Windows/Linux 的真实仓库性能结果。

## 验收发现的真实缺陷

带有已接纳历史错误的文件发生解析错误时，Oxlint 暂时只报告解析错误。旧实现把文件列表完整视为规则覆盖完整，错误地把历史错误记为 resolved；恢复原内容后误报 regression 并 block。

`tests/performance.test.mjs` 通过真实 CLI 的 baseline → 追加语法错误 → 恢复链路复现，旧实现最后一步 block 而非 pass。失败记录为 `artifacts/performance-red.log`。修复后解析错误仍 block，但 coverage.complete 为 false，不记录已修复、不允许 baseline 写入；相关 baseline、平台和新流程 14 项通过，记录为 `artifacts/performance-green.log`。后续完整检查和 CI 状态见实现计划。

## 最小 Policy 的需求评估

本项原定为“真实试点需要时增加逐规则阻塞配置”。本次核对两个真实项目并执行直接工具对照：Tara 将 correctness 设为 error；EPUB 将 correctness 设为 error，suspicious/perf 设为 warning，并单独关闭一条 import 规则。实际结果分别为 0 条和 2 条 warning，Harness 与直接工具一致。

现有分析器规则严重性配置加显式 baseline 已能表达这两个项目当前的接纳方式：新增 error 阻塞，已接纳问题保留，确认修复后复现阻塞。没有发现必须由 Harness 单独表达的逐规则条件。因此需求评估完成，暂不增加 Policy 配置或配置解析分支。

若后续项目提出分析器配置无法表达的阻塞条件，再以该真实场景驱动最小配置。执行失败、覆盖异常导致的 incomplete 和默认 gate 不得因 Policy 配置而变成 pass。

## 进程树与多分析器补充验收

`--process-tree` 每 250 ms 请求 PID、父 PID 和 RSS；macOS/Linux 使用 ps，Windows 使用 PowerShell CIM。只累加 Harness 及其后代，排除采样器及其后代。采样可能漏过短命进程或瞬时峰值，RSS 求和也可能重复计算共享内存，不能称为精确物理内存峰值。启用后包括额外采样开销，不与上面的无采样墙钟数据直接比较。受限环境无法采样时记录错误，验收脚本不会将缺失指标算作成功。

本机真实 96 MiB 子进程校准已通过。EPUB 的 Oxlint + Knip 三次完整并发分析耗时为 2.547 / 1.254 / 1.244 秒，进程树 RSS 采样最大值为 328,464 / 314,704 / 317,312 KiB，Harness 自身 maxRSS 为 81,040 / 82,752 / 82,512 KiB。每次两个分析器均 completed，返回 24 条 warning，原项目未修改；这不是对 24 条诊断的逐项业务确认。

首轮只复制根 node_modules，缺少 workspace 本地依赖，Knip 返回 incomplete，保留在 `artifacts/epub-multi-process-tree-sjtDnO`。按实际安装形态补齐各 workspace 的 node_modules 和已构建 dist/pkg 后通过，原始工具证据与目录清单保留在 `artifacts/epub-multi-installed-K8xeNa`。该结果依赖已构建项目，不冒充干净源码构建验收。

性能脚本现可从安装包运行：指定真实源码仓库与 `--tool-root`，原 baseline 仅在临时副本移除，摘要记录其路径。工作区本身与 baseline 不改动。真实 Windows Agent 中断仍需已登录的 Windows 客户端；协议取消和资源采样校准不能替代该项验收。

Windows CI 的 2.5 秒、96 MiB 子进程校准发现逐次启动 PowerShell 的方式只采到主进程；改成三个字段查询仍未解决，两个失败分别保留在 `artifacts/next-ci-windows-red` 和 `artifacts/sampler-projection-windows-red`。Windows 采样现采用持续进程，先等待首帧再启动被测程序；`startupMs` 记录初始化成本，总墙钟仍包含该成本，不延长校准子进程的生命周期。最终可用性以同一 Windows 校准用例的真实结果为准。

持续进程方案在 `3009489` 的 Windows CI 捕获 8 帧和内存子进程；后续同代码运行暴露 5 秒初始化预算过短，记录在 `artifacts/final-windows-red`。0.1.4 将初始化等待单独设为最多 20 秒，随后仍使用原来的 2.5 秒工作负载及原有内存断言；初始化失败保留其原因，不再被后续健康监测改写为 stalled。初始化与测量耗时均保留，不将更长等待当作性能改善。
