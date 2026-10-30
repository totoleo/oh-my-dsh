# 许愿模式 v2 · 实现契约

本文件是 v2 的唯一实现契约：`index.js`（Host）、`client.js`（Web Client）、
`test/harness.mjs`（黑盒测试）三方都以此为准。实现若与本文件冲突，先改本文件。

## 0. 一句话

v2 把四层拆成两种工作方式：

- **高度**：纯对话，不挂 goal。目标是把用户脑子里的需求**外化成他能点头的文字**：
  核心动作是从「做法」抬到「结果」，配一组探针（目标/具象/冲突/边界/代价/观察/载体/复用/回述），
  用**回述卡**对齐，用 `surfaced` 证明这次谈出了原话之外的东西。
- **深度 / 广度 / 速度**：插件挂 goal 自动迭代，把该层推到"上限"；
  每层结束**必须**经用户确认才进入下一层。

goal 由**插件**创建/完成（`ctx.goals` 服务直连），模型不得调用
`create_goal` / `update_goal`；插件通过 tool guard 硬拦这两个工具。

## 1. 目录与落盘

根目录：`<session 当前工作目录>/wishes/`。当前工作目录按优先级取
`ctx.workingDirectory.get(session)` → `workingDirectory` 投影 → `session.header.cwd`
→ `process.cwd()`。

```
wishes/
└── <slug>/                     # slug = 3–5 词英文目录名，见 §8
    ├── meta.json               # 插件写：topic/slug/createdAt/stages
    ├── altitude/summary.md     # 插件写
    ├── depth/
    │   ├── summary.md          # 插件写（每次 record 覆盖为当前草稿）
    │   ├── notes.md            # 模型自由写
    │   └── ...                 # 模型自由写：证据表、实验脚本、结果
    ├── range/summary.md
    ├── speed/summary.md
    └── plan.md                 # 插件写（close 时）
```

规则：

- 插件只在 `wishes/` 下写文件，且写入失败**绝不**抛错（mode 必须继续可用），
  失败信息作为工具结果里的一行警告返回。
- 目录按需创建（`mkdir -p`），不在模式开启瞬间创建。
- 模型被允许在 `<root>/<slug>/<当前层>/` 下自由创建文件/做实验；
  工具守卫禁止其修改该目录之外的任何文件。

## 2. 投影状态（key = `wish`，STATE_VERSION = 7）

```js
freshState() = {
  active: false,
  topic: '',          // 用户原话
  slug: '',           // 目录名：3–5 词英文，或自动名 wish-xxxxxxxx
  stage: 'altitude',
  confirmed: { altitude:false, depth:false, range:false, speed:false },
  reviewed:  { altitude:false, depth:false, range:false, speed:false },
  skipped:   { altitude:false, depth:false, range:false, speed:false },
  revised:   { altitude:false, depth:false, range:false, speed:false },
  summaries: { altitude:'', depth:'', range:'', speed:'' },
  ceilings:  { altitude:'', depth:'', range:'', speed:'' },
  fields: {
    altitude: { fixed:[], open:[], declined:[], materials:[], surfaced:[], success:'', notDoing:'', rationale:'' },
    depth:    { findings:[], assumptions:[], methods:[], acceptance:'', falsifiers:[] },
    range:    { options:[], domains:[], novel:[], shortlist:[], exclusions:[] },
    speed:    { slice:'', tracks:[], dependencies:[], loop:'', scenarios:'', checkpoints:[] },
  },
  steps: 0,
  running: null,      // /wish 命令折叠用
  pending: {},        // tool call → op 折叠用
}
```

阶段派生（Host 侧，client 侧同规则）：

```
phase(stage) =
  confirmed[stage]                       -> 'confirmed'
  reviewed[stage]                        -> 'reviewing'
  !active && stage !== 'idle'            -> 'idle'
  active && stage === state.stage &&
    stage === 'altitude'                 -> 'talking'
  active && stage === state.stage        -> 'exploring'
  else                                   -> 'idle'
```

`exploring` 阶段再叠加**实时** goal 状态（只 Host 读得到）：
goal 属于本层且 `phase==='blocked'` → `'blocked'`；`'paused'` → `'paused'`。
`blocked` 的常见来源是 round-limit。

## 3. 工具 API：`wish_requirement`

action ∈ `start | status | record | conclude | confirm | revise | revisit | close`

### 3.1 权限

- `start` / `confirm` / 真正关闭的 `close`（带 `consistency=true`）
  **必须**处于直接人类回合：当前 open turn 内存在
  `user/message` 且 `source.kind === 'user'`（实现同 `@deepseek-ai/dsh-tool-goal`），
  **或**本回合内有一次成功的 `ask_user_question` 回答（用户确实作答，timed 模式的
  `pending` 超时不算）。后者让「conclude 后在同一轮用结构化确认卡 review 并 confirm」可行。
- 只返回核对清单的 `close`（不带 `consistency`）不算关闭，不校验来源。
- `record` / `conclude` / `revise` / `revisit` / `status` 不校验来源。
- 校验失败抛错，错误文案说明"需要用户直接确认/指令"。

### 3.2 参数

| 参数 | 用于 | 说明 |
| --- | --- | --- |
| `action` | 全部 | 必填 |
| `topic` | start | 用户原话，一句话 |
| `dimension` | record/conclude/confirm/revise/revisit | 省略时默认当前层；record 不能跨层 |
| `slug` | start | 3–5 个简短英文单词，小写、`-` 连接；缺省或不合法用自动名（§8） |
| `summary` | record/revise | 本层结论 1–3 句 |
| `ceiling` | conclude | 必填：为什么这已是本层上限、哪些做不到 |
| `userSaid` | confirm | 必填：引用用户确认的原话 |
| `skip_explore` | confirm | 显式跳过自动探索（用户明确要求时） |
| `fixed` `open` `declined` `materials` | altitude | 字符串数组 |
| `surfaced` | altitude | 字符串数组：用户原话里没有、这次谈出来的点（纠正、补充、隐含约束） |
| `success` `notDoing` `rationale` | altitude | 字符串 |
| `findings` `assumptions` `methods` `falsifiers` | depth | 字符串数组 |
| `acceptance` | depth | 字符串 |
| `options` `domains` `novel` `shortlist` `exclusions` | range | 字符串数组 |
| `slice` `loop` `scenarios` | speed | 字符串 |
| `tracks` `dependencies` `checkpoints` | speed | 字符串数组 |
| `consistency` | close | 首次 close 返回核对清单；带 true 才真正关闭 |

`record` 的语义：**只落盘，不推进**。标量字段覆盖，数组字段并集去重
（`unionLists`）。只能在当前层 record；其他层用 `revise`。

### 3.3 每层门禁

**conclude 门禁**（深度/广度/速度，全部满足才允许）：

- depth：`findings ≥ 4`、`assumptions ≥ 2`、`methods ≥ 3`、`acceptance` 非空、
  `falsifiers ≥ 1`、`ceiling` 非空。
- range：`options ≥ 8`、`domains ≥ 4`、`novel ≥ 2`、`shortlist ≥ 2`、
  `exclusions ≥ 2`、`ceiling` 非空。
- speed：`slice` 非空、`tracks ≥ 2`、`dependencies ≥ 1`、`loop` 非空、
  `scenarios` 非空、`checkpoints ≥ 2`、`ceiling` 非空。

拒绝时抛错并列出**缺少哪几项**（这是自动迭代的纠偏信号）。

**confirm 门禁**：

- altitude：`summaries.altitude` 非空，且 `surfaced` 至少 1 条，或显式写一条
  「原话已完整，无需补充」（证明这次确实挖过，而不是把原话改写一遍）。
- depth/range/speed：`reviewed[dimension] === true`，或 `skip_explore === true`
  （后者记入 `skipped[dimension]`）。`userSaid` 非空。
- 全部层都已 confirmed 时，`confirm` 不再是推进动作；提示改用 `close`。

**close 门禁**：四层 confirmed 且 `consistency === true`；否则首次返回核对清单。

### 3.4 动作语义

- `start topic? slug?`：进入 altitude。已 active 且 topic 相同 → no-op；
  若目录名还是自动名且给了合法 `slug`，只改名不重开（§8）。topic 不同 → 以新主题重开
  （完成旧 goal、清空进度）。topic 为空 = 保持原 topic。
- `status`：只读，返回当前值。
- `record`：见 §3.2。
- `conclude dimension?`：结束本层自动探索。完成本层 goal（若属于本层）→
  `reviewed[dimension]=true` → 返回 review 卡。altitude 不允许 conclude。
- `confirm dimension?`：用户确认。完成本层 goal → 写 summary.md →
  `confirmed=true`、`reviewed=true` → 推进 stage → 创建下一层 goal（离开 altitude 时创建
  depth；depth→range；range→speed；speed 是最后一层）。返回该层收尾卡。
- `revise dimension ...fields`：修订已确认/已 review 层。mode active 时：
  `confirmed=false`、`reviewed=true`（需要用户重新确认），并失效该层之后所有层的确认
  （`invalidateFrom`）；mode closed 时只改内容 + `revised=true`。
- `revisit dimension`：回到某层重做。`invalidateFrom(dimension)`，
  `reviewed[dimension]=false`、`confirmed[dimension]=false`，完成当前 goal 并为该层
  重新创建 goal（预算重置）。altitude 允许 revisit（回到对话）。
- `close`：完成所有剩余 goal → 写 plan.md → `active=false`。

### 3.5 输出 value

```js
{
  active, topic, slug, stage, stageLabel, phase, done,
  confirmed: {4}, reviewed: {4},
  steps, questions: string[],
  guidance: string,            // 工具结果正文（markdown）
  plan: string,                // close 后为完整方案文档，否则 ''
  exploreDir: string,          // 绝对路径（无 slug 时为空串）
  nextStep: string,
  goal: { phase, roundsStarted, maxGoalRounds, blockReason? } | null,  // 仅本层 goal
}
```

`questions` 派生：
- altitude/talking：固定的 4 个盘问问题。
- exploring：把**未满足的 conclude 门禁项**转成待办问题。
- reviewing：该层固定的 review 问题。
- confirmed：`[]`。

`presentationMeta`（折叠用）：`{ wish: { active, stage, steps, reviewed } }`。

## 4. goal 编排

### 4.1 创建时机（全部在插件内，`ctx.goals`）

| 事件 | 动作 |
| --- | --- |
| `confirm(altitude)` | 为 depth 创建 goal |
| `confirm(depth)` | 完成 depth goal（若仍在跑）→ 为 range 创建 goal |
| `confirm(range)` | 完成 range goal → 为 speed 创建 goal |
| `confirm(speed)` | 完成 speed goal |
| `conclude(dim)` | 完成 dim goal |
| `revisit(dim)` | 完成当前 goal → 为 dim 重建 goal（dim 为探索层时）|
| `close` / `/wish off` / 换主题 start | 完成属于本插件的 goal |

goal 归属判定：objective 以 `[wish-<stage>] ` 开头（连同空格）。

### 4.2 objective 模板

```
[wish-depth] 「<topic>」把「深度」推到上限。

问题陈述：<summaries.altitude>
成功判据：<fields.altitude.success>
明确不做：<fields.altitude.notDoing>
固定约束：<fields.altitude.fixed.join('；')>

本层产出（按此结构记录）：...
上限（完成判据）：...
工作区：<exploreDir>/depth/ —— 笔记、证据、实验都放这里，不要在之外改任何文件。
纪律：每轮结束前用 wish_requirement(action=record) 落盘进展；需要用户输入用
ask_user_question（阻塞等待），不要用散文提问结束回合；达到上限后调用
wish_requirement(action=conclude)。不要调用 create_goal / update_goal。
```

各层「本层产出 / 上限」文案见 `index.js` 中的 STAGE_SPEC，必须与 §3.3 门禁一致。

### 4.3 轮次

- `maxGoalRounds`：在 `STAGE_SPEC.<stage>.rounds` 里配置（depth 30 / range 24 / speed 16），
  就是各层 goal 创建时用的轮次上限。
- 轮次是安全帽不是目标：objective 与 policy 都要求"边际收益为零即 conclude"。
- round-limit 由 driver 自动 block；policy 提示模型：用户可 `revisit` 重新开预算。

### 4.4 冲突

创建前 `ctx.goals.get(agent)`：

- 返回 undefined → 直接创建。
- 属于本插件（objective 前缀匹配）且 phase === 'complete' → 创建（替换）。
- 其它任何情况（用户自己的 goal，或本插件 goal 仍 active）→ **不触碰**，
  降级为交互式探索：工具结果与 policy 说明"当前会话已有其他 goal，本层不自动迭代"。
- 所有 goal 操作 try/catch：goal 服务缺失或调用失败时，模式照常以降级方式工作，
  失败在工具结果里以一行警告呈现。

### 4.5 生命周期

- 会话 resume 后 goal 是 disarmed 的（运行时行为）。policy 要求模型在用户说
  "继续"时提示：重新进入探索需要调用 `revisit` 或 `start`；插件在 `revisit` 时
  重建 goal（新 goal 自动 armed）。

## 5. 直接人类回合校验（confirm/start/close 用）

```js
function hasDirectHumanInput(ctx, agent) {
  const agents = ctx.get('agents');
  if (agents && typeof agents.roots === 'function') {
    try { if (!agents.roots().includes(agent)) return false; } catch {}
  }
  const projections = ctx.get('sessionProjections');
  const boundary = projections?.stateOf(agent.session, 'turnBoundary');
  if (!boundary || boundary.openTurnStartSeq === null) return false;
  const events = agent.session.snapshotEvents();
  for (let seq = boundary.openTurnStartSeq + 1; seq < events.length; seq += 1) {
    const event = events[seq];
    if (event?.type === 'user/message' && event.data?.source?.kind === 'user') return true;
  }
  return false;
}
```

任何服务异常 → 抛"需要用户直接确认"（fail closed）。`ask_user_question` 的作答 attestation
在 §3.1 之外也用于同一判定（同一函数 `hasDirectHumanInput`）。

## 6. 工具守卫（`ctx.tools.guard`）

全局注册一个守卫；只对 `state.active` 的会话生效。

- `write` / `edit`：目标路径解析为绝对路径后必须位于
  `<wishesRoot>/<slug>/` 内，否则拒绝：
  `许愿模式进行中：只能在 <exploreDir> 下写文件；要修改项目请先 /wish off。`
- `create_goal` / `update_goal`：一律拒绝：
  `许愿模式的 goal 由插件管理；请用 wish_requirement(action=conclude/confirm/revisit)。`
- `bash` / `pwsh`：altitude 层拒绝（对话层不执行命令）；探索层允许，但命令文本命中
  危险模式（`rm -rf`、`git push|commit|reset|clean|checkout`、`Remove-Item.*-Recurse`）
  时拒绝。
- `subagent` / `subagent_fork` / `workflow` / `ralph` / `spawn_teammate`：拒绝
  （受限模式不派生会绕过文件边界的子 agent）。
- 其余工具放行。

## 7. Projection wire view（client 用）

```js
{
  active, topic, slug, stage, done, steps,
  confirmed: {4}, reviewed: {4},
  summaries: {4}, ceilings: {4},
}
```

wire view 必须只依赖 fold 后的状态（无 ctx、无 session cwd），因此**不含绝对路径**；
client 用 `wishes/<slug>/` 拼接展示，绝对路径只出现在工具结果的 `exploreDir` 字段。
client 用 `useProjection('wish')` + `useProjection('goal')`：
goal 投影为 `{ goal: { objective, phase, maxGoalRounds }, roundsStarted } | null`。

## 8. slug 规则

目录名是**主题的英文缩写**，不是用户原话：3–5 个简短英文单词，小写，用 `-` 连接，
例如 `reduce-onboarding-friction`。

`cleanSlug(raw)`：小写 → 非 `[a-z0-9]` 折叠为 `-` → 去首尾 `-` → 截断 48 字符 →
按 `-` 拆分后要求 **3–5 个单词**、每词 ≤16 字符；不满足返回 `''`。

`autoSlug(topic)`：`wish-` + FNV-1a 32 位散列的 8 位十六进制，同一主题稳定。
只含小写字母数字与 `-`，天然避开路径分隔符与 Windows 保留名。

规则：

- `start` 带合法 `slug` → 用它；不带或不合法 → 用 `autoSlug(topic)`，并在工具结果里
  提示「slug 需要 3–5 个简短英文单词」。
- 目录名还是自动名时，可以再调 `start`（不带 `topic`、带 `slug`）换成正式名；
  一旦是正式名，`start` 不再改名（避免换掉已经落盘的目录）。
- `/wish <原话>` 由命令入口开启，给不出 slug，先落自动名，由模型在高度层补正式名。

## 9. 提示词分区（Host systemPrompt section，name = `wish-mode:policy`，order 520）

mode 未开启时**不注入**（空字符串）。开启时注入：

1. 状态行：阶段、阶段 phase、进度、exploreDir、当前 goal 轮次。
2. 高度协议（stage === 'altitude'）：盘问规则（一次 1–3 问、复述、不替用户回答、
   固定约束只挑战一次、declined 不再追问、用户说"你判断"才判决、可用
   ask_user_question 也可以直接对话），外加：
   - **task → outcome**：`summary` 用结果句式（"让 X 从 A 变成 B"），不用任务句式；
   - **探针库**：九个探针（目标/具象/冲突/边界/代价/观察/载体/复用/回述），一轮只用一个；
     载体与复用只记判断，替代方案留给 range；
   - **回述卡**：`record` / `status` 在高度层返回「需求回述」，模型原样发给用户逐条纠正；
     用户只回"差不多"不算确认；
   - **创意型例外**：用户明确说这是一次性创意交付时，抬高只做一轮，写进 `surfaced`；
   - **不越界**：不追可量化阈值（depth 的 acceptance）、不展开替代方案（range）、不做排期（speed）。
3. 探索协议（depth/range/speed）：goal 由插件管理、每轮 record、ask_user_question
   阻塞提问、只在 exploreDir 写文件、不实现不改项目、边际收益为零即 conclude、
   conclude 后向用户汇报并给 2–3 个确认问题、confirm 只在用户明确同意后调用、
   round-limit/blocked 的处理。
4. 层规格：本层产出结构 + 上限判据 + review 问题。
5. 已有记录摘要（已 confirmed 层的 summary 各一行）避免重复劳动。
6. 已确认层的内容不得随意推翻；冲突先 revise。

## 10. Client UI

- `conversation.input.left` chip：未开启显示「许愿」；开启显示
  「许愿 · <层> <phase>」，phase 用 reviewed/confirmed + goal 投影推导。
- `conversation.composer.dock`：四层进度条；当前层显示探索轮次
  `第 {roundsStarted + 1}/{maxGoalRounds} 轮`（goal 属于当前层且 active 时）；
  reviewing 显示「待你确认」；完成后显示「四层已许愿」。
- 只读投影，不新增远程调用。保持 v1 的样式变量与 28px chip 尺寸。

## 11. 测试（`test/harness.mjs`，黑盒）

运行：在源码仓库的插件目录执行 `node test/harness.mjs`（退出码非 0 表示失败）。测试随源码仓库分发，不包含在 npm 包中。

Mock `ctx` 提供：`get(name)`（sessionProjections/agents/goals/workingDirectory）、
`inject(deps, fn)`、`effect(fn)`、`tools.register/guard`、`systemPrompt.section`、
`commands.register`、`sessionProjections.register`。用 `apply(ctx)` 装配后，
读取注册的 tool/section/command，直接调 `execute(args, exec)` 断言状态与输出。

覆盖：altitude 回述卡与 surfaced 门禁（含豁免句、任务句提示）→ start→altitude record→confirm（创建 depth goal）→ 门禁拒绝 → 补齐字段
conclude（goal complete）→ confirm（创建 range goal）→ 直接 confirm 被拒
（未 review）→ skip_explore → … → close 核对清单 → consistency 关闭；文件落盘
（tmpdir）；goal 冲突降级；守卫规则；直接人类回合校验（含 ask_user_question 作答
attestation / timed pending / 失败结果）；projection fold 重放（用 tool/call +
tool/result 事件序列重放得到同一状态）。当前 16 个用例。

## 12. 常量

```
STAGE_SPEC.depth.rounds   = 30
STAGE_SPEC.range.rounds   = 24
STAGE_SPEC.speed.rounds   = 16
GOAL_PREFIX = '[wish-'
```

## 13. 文件与责任

| 文件 | 内容 |
| --- | --- |
| `index.js` | Host：投影、提示段、命令、工具、goal 编排、守卫、落盘 |
| `client.js`、`locale/*.json` | Web UI：chip + 进度条 + 展示元数据 |
| `test/harness.mjs` | 黑盒回归测试（Node 内置模块，无依赖；随源码仓库，不随 npm 包发布） |
| `AGENTS.md` | agent 工作规范：本包不可协商的约束与验收口径（不随 npm 包发布） |
| `README.md`、`package.json` | 使用文档与 bundle 清单 |
| `docs/SPEC.md` | 本契约 |
