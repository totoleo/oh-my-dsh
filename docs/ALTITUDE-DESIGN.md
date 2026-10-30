# 高度层设计（v3 · 定稿）

> 设计说明，不是实现契约。契约在 [`plugins/wish-mode/docs/SPEC.md`](../plugins/wish-mode/docs/SPEC.md)，
> 两者冲突以 SPEC 为准。
>
> 灵感来源：[How to be more ambitious: A tutorial for humans with models](https://felixrieseberg.com/how-to-be-more-ambitious-a-tutorial-for-humans-with-models/)（Felix Rieseberg）。
> 文中四类野心 Altitude / Depth / Range / Speed 是本插件四层的直接出处；“回述卡”和
> `surfaced` 门禁是插件自己的扩展，用于把“外化需求”变成可检查的动作。

## 0. 定性

- **目标**：把用户脑子里的需求变成他能点头的外部表示。
- **核心动作**：**从 task 抬到 outcome**——用户说“做一个 X”，这一层要问出“你想让什么发生”。
- **手段**：抬高只是探针之一；其余探针负责把没说出口的部分挖出来。

## 1. 层定义与边界

| 层 | 输入 | 本层只解决 | 不越界（留给谁） |
| --- | --- | --- | --- |
| altitude | 用户原话 | 要什么结果、边界、用户语言的“成了”、这次谈出来的点 | 可量化验收、验证方法（depth）；替代方案（range）；排期（speed） |
| depth | altitude 结论 | 依据、研究/验证方法、可量化验收、推翻条件 | 发散候选（range）；切片排期（speed） |
| range | altitude + depth | 跨领域候选、收敛、排除项 | 重做论证（回 depth）；落地节奏（speed） |
| speed | 前三层 | 切片、并行、关键路径、情景、检查点 | 重新发散/论证（revisit / revise） |

## 2. 核心动作怎么落地（task → outcome）

不做新字段，用三层约束，从软到硬：

1. **回述卡标签**：卡上第一行就叫「结果」，并注明“要发生什么，不是要做什么”；
2. **policy**：`summary` 用结果句式（“让 X 从 A 变成 B”），不用任务句式（“做 X”）；
3. **插件软检查**：`summary` 以“做/写/开发/实现/搭建/设计/加”开头、且不含
   “让/使/变成/降到/达到”时，回述卡上加一行提示：

```
- 结果：做一个新手引导页      ⚠ 这读起来像做法，不像要发生的结果
```

启发式，只提示、不阻断 confirm——写成硬门禁会变成文字游戏。

## 3. 探针库（写进 policy，一轮只用一个）

| # | 探针 | 触发 | 问法 | 落点 |
| --- | --- | --- | --- | --- |
| 1 | 目标 | 用户开口就是做法 | 这件事做成之后，你想看到什么发生？再之后呢？ | `summary` / `surfaced` |
| 2 | 具象 | 用词抽象（更快、更好） | 举一个最近的具体场景；哪个例子算没达成？ | `success` / `surfaced` |
| 3 | 冲突 | 出现互斥要求 | 只能保一个的时候，保哪个？ | `fixed` / `open` |
| 4 | 边界 | 范围不清 | 哪些不让步、哪些能换、这次明确不做什么 | `fixed` / `notDoing` |
| 5 | 代价 | 期望与资源不匹配 | 愿意为它付出什么：时间、钱、还是体验 | `open` |
| 6 | 观察 | 说不清怎么算成 | 到时候你会在哪儿看到它成了？ | `success` |
| 7 | 载体 | 用户已指定产出形式 | 这个形式能直接达成上面的结果吗？去掉它还剩什么？ | `surfaced` |
| 8 | 复用 | 事情会反复发生 | 怎么让它不需要你盯着？需要什么数据或权限？ | `surfaced` / `open` |
| 9 | 回述 | 谈过一轮 | 用另一种结构说回去，请用户逐条改 | 回述卡 + `surfaced` |

规则：一次一个探针、1–3 问、只问不答；载体/复用只记判断，替代方案留给 range；
**用户明确说这是一次性创意交付时，抬高只做一轮，写清楚即可**；用户对回述只回
“差不多”就继续问，不算确认。

## 4. 回述卡（插件生成，模型只负责递）

`record` / `status` 在 altitude 阶段返回：

```
需求回述
- 结果：…            （要发生什么，不是要做什么）
- 怎么算成：…        （用户语言，不追阈值）
- 不让步：…
- 可以换：…
- 明确不做：…
- 这次谈出来的：…
- 还没定：…          （空字段 + 用户拒答项，自动汇总）
```

模型原样发给用户，请逐条确认或纠正。纠正的内容进 `surfaced`。

## 5. 新字段 `surfaced` 与门禁

`fields.altitude.surfaced: string[]`——**用户原话里没有、这次谈出来的点**
（纠正、补充、隐含约束、临时反悔）。

`confirm(altitude)` 门禁：

1. `summaries.altitude` 非空；
2. `surfaced ≥ 1`，或显式写“原话已完整，无需补充”；
3. `userSaid` 非空（已有）。

`surfaced` **不传给 depth 的 objective**：里面可能有“这不是我要的”这类否定信息，
会污染自动轮次。先跑几轮看内容质量。

## 6. 三处越界修复

| 问题 | 改法 |
| --- | --- |
| depth 的 `methods` 读起来像“选方案”，与 range 的 `options` 撞车 | depth `methods` = **研究/验证方法**（查什么、用什么数据、做什么实验）；range `options` = **解决路径** |
| altitude 的 `success` 与 depth 的 `acceptance` 重叠 | altitude = 用户嘴里“成了的样子”（定性）；depth = 可量化、可执行的验收。policy 明确：高度层不追阈值 |
| altitude 的 `materials` 与 depth intake 重复 | 高度层只记线索（“有 3 份访谈”），不追在哪、怎么用；具体取材留给 depth 第一轮 |

## 7. 契约变更

| 项 | 变更 |
| --- | --- |
| `freshState().fields.altitude` | 增加 `surfaced: []` |
| `FIELD_SPEC.altitude.lists` / `LIST_FIELDS` | 增加 `surfaced` |
| `FIELD_RENDER.altitude` | 增加 `{ key: 'surfaced', title: '这次谈出来的' }` |
| 工具参数 | 增加 `surfaced`（字符串数组，仅 altitude） |
| `STATE_VERSION` | 7 → 8 |
| goal objective | 不动 |

## 8. 文案改动清单

- `ALTITUDE_QUESTIONS` 第 3 条 → “到时候你怎么知道它成了？（用你自己的话描述就行）”
- policy 高度段新增五条：task→outcome 句式、九个探针与选法、回述卡原样递送、
  “差不多”不算确认、创意型例外 + `surfaced` 豁免写法
- `TOOL_DESCRIPTION` 高度层一行：补“用探针挖需求，确认前必须 record 出 `surfaced`”
- `STAGE_SPEC.depth.methods` 文案按 §6 改
- 删除前几版里的 `beyond` / `artifact` 字段提案（降级为探针）

## 9. 测试

1. altitude 阶段工具结果含「需求回述」且七节齐全；
2. 只 record summary → confirm 报错并列出 `surfaced`；
3. 写“原话已完整，无需补充”→ 通过；
4. `surfaced` 渲染进 `summary.md`；
5. 空字段时回述卡出现「还没定」；
6. 任务句式 summary 触发警示行；
7. depth objective 不含 `surfaced`；
8. 现有 15 例不回归。

## 10. 文档

SPEC §0 / §3.2 / §3.3 / §9 / §11；两份 README 的四层表与落盘示例；CHANGELOG。

## 11. 实施顺序与验收

SPEC → 实现 → 测试 → 文档 → 真实对话跑一轮。
验收：`pnpm -r test` 全绿；一次真实对话能产出至少一条 `surfaced`，且用户是照着
回述卡说“对”。

## 12. 风险与不做

- **风险**：`surfaced` 可被敷衍；回述卡让每轮多一段文本；句式检查会误报。
- **不做**：自动任务分流、10x 追问、抽象评分、UI 改动、`surfaced` 进 objective。

## 13. 出处

- **来自文章**：四类野心、task→outcome、goal beyond goal、载体质疑（比 deck 更好的方式）、
  durable workflow / 不依赖人、创意型任务不适用。
- **我们的扩展**：四层流水线、goal 编排、守卫、回述卡、`surfaced` 门禁——后两者是给
  “外化”做的可检查化，不是文章主张。
