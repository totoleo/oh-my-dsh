# 许愿模式 · Wish Mode

[English](https://github.com/totoleo/oh-my-dsh/blob/master/plugins/wish-mode/README.en.md) | 中文

[![npm](https://img.shields.io/npm/v/@totoleo/dsh-wish-mode.svg)](https://www.npmjs.com/package/@totoleo/dsh-wish-mode)
[![CI](https://img.shields.io/github/actions/workflow/status/totoleo/oh-my-dsh/ci.yml?branch=master)](https://github.com/totoleo/oh-my-dsh/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/totoleo/oh-my-dsh/blob/master/plugins/wish-mode/LICENSE)

> 许愿免费，验愿才算数。

一个可长期安装在 DeepSeek Harness 上的插件：在动手之前，把需求从「高度 → 深度 → 广度 → 速度」四层问清楚。四层拆成**两种工作方式**——高度是对话，后三层是自动探索——探索过程和产物落盘到工作区的 `wishes/` 目录。

## 它解决什么问题

- **方向错**：一上来就写代码，做到一半才发现要解决的不是这个问题。
- **依据薄**：方案靠感觉，没有证据、没有验证、没有推翻条件。
- **选项少**：只想到一条路，没比较过其他领域怎么做。
- **执行散**：没有最小切片、没有并行安排、没有检查点。

许愿模式把这四件事拆成四层，每层都有明确的产出和确认门槛；**每一层都必须由用户确认**（`confirm` 会校验当前回合存在用户直接消息），插件不会替用户确认。

**适合**：需求模糊、方向未定、怕做错方向的探索型任务。
**不适合**：已经明确要改哪一行代码的纯执行任务。

## 快速开始

要求：DSH ≥ 0.2.1-rc.2（依赖 goal 服务、`ctx.tools.guard` 与 `ask_user_question` 作答 attestation）；2026-10 于 DSH Desktop 0.2.1-rc.3 验证。

1. 安装：

   ```text
   plugin_manager install_bundle
   target: "@totoleo/dsh-wish-mode"
   ```

   需要锁版本时写完整 spec，例如 `"@totoleo/dsh-wish-mode@2.1.0"`。

2. 用原话许愿：

   ```text
   /wish 我要躺着一年挣100万
   ```

3. 回答「高度」层的 1–3 个问题（模型每次只用一个探针）；插件会给出一张「需求回述」卡，逐条确认或纠正后再点头，深度探索会自动开始。

安装后输入框左侧出现「许愿」chip；新装或重装插件后如果 chip 没出现，**重启一次 DSH**（client 模块图按进程缓存）。

从源码安装（开发用）：`git clone https://github.com/totoleo/oh-my-dsh.git`，把 `plugin_manager install_bundle` 的 `target` 指向仓库里的 `plugins/wish-mode` 目录。

## 四层怎么走

| 层 | 工作方式 | 要回答的问题 | 本层产出 |
| --- | --- | --- | --- |
| **高度** | 对话 + 探针 + 回述卡 | 把「做法」抬成「结果」，挖出原话里没有的部分（目标/具象/冲突/边界/代价/观察/载体/复用/回述九个探针，按缺口选一个） | 结果陈述 + 怎么算成 + 边界 + 这次谈出来的（surfaced） |
| **深度** | goal 自动探索 | 依据哪些材料、采用什么方法、如何验证结果 | 发现与证据 + 关键假设及验证结果 + 方法比较 + 验收标准 + 推翻条件 |
| **广度** | goal 自动探索 | 扩大可参与的领域、工具和方法，创新是核心 | 跨领域候选 + 新思路 + 收敛候选 + 排除项 |
| **速度** | goal 自动探索 | 不牺牲质量的前提下把执行效率推到上限 | 最小可验证切片 + 并行安排 + 关键路径 + 可靠性情景 + 检查点 |

```text
高度（对话 1–3 问/轮）──用户确认──▶ 深度（goal 自动探索）──探索到上限 ▶ 待确认 ──用户确认──▶ 广度 ──▶ 速度 ──▶ close
```

- 顺序是硬约束：当前层未确认不能进入下一层；`速度` 永远排在最后。
- **高度**：模型一次问 1–3 个问题，可以给候选让你挑，但不替你选；你说「你来判断」时才给判断。这一层不做实验、不改项目。
- **深度/广度/速度**：进入该层时插件自动创建 goal，模型在自动轮次里推进本层产出；需要你输入时用阻塞式提问，不会自问自答。每层结束前模型先给出「上限判断」，然后停下等你确认。
- 如果探索提前达到上限，模型会**主动收尾**，不会为了烧轮次而工作；轮次上限只是安全帽。
- 对结果不满意：说「继续挖」，模型会 `revisit` 本层重新开一轮预算；说「这里不对」则会 `revise` 修订并需要你重新确认。

## 命令与入口

- `/wish <原话>`：以原话为主题开启；已开启且换了原话则重开新主题。
- `/wish on` / `/wish off`：显式开启 / 关闭（关闭时会结束插件创建的 goal）。
- `/wish`：切换模式（输入框 chip 用的就是这个无参形式）。
- 也可以直接对模型说「进入许愿模式」「先把需求理清楚」，模型会调用 `wish_requirement` 开启。
- 模式开启后，输入框下方出现 `高度 → 深度 → 广度 → 速度` 进度条：当前层显示「对话中 / 探索中 / 待你确认 / 已确认」，探索中还会显示 `第 n/m 轮` 和探索目录。

## 落盘：`wishes/<目录名>/<层>/`

目录名是主题的英文缩写：**3–5 个简短英文单词，小写，用 `-` 连接**（如 `reduce-onboarding-friction`），不是你的原话。用 `/wish <原话>` 开启时插件先落一个自动名 `wish-xxxxxxxx`，模型在高度层会把它换成正式名；也可以自己说「目录名叫 xxx」。

```text
wishes/
└── reduce-onboarding-friction/
    ├── meta.json           # 插件写：主题、阶段、更新时间
    ├── altitude/summary.md # 插件写：每层结论、上限判断、结构化字段
    ├── depth/
    │   ├── summary.md
    │   ├── notes.md        # 模型写：笔记、证据表
    │   └── ...             # 模型写：实验脚本与结果
    ├── range/summary.md
    ├── speed/summary.md
    └── plan.md             # 插件写：close 时的完整方案
```

- 模型可以在当前层的目录里自由创建文件、做实验；**文件工具的写入被限制在该目录内**，shell 只拦截常见的破坏性命令（`rm -rf`、`git` 写操作等），避免探索悄悄改到项目代码。
- 插件写文件失败只会在工具结果里出现一行警告，不会中断模式。

## 质量门禁

`conclude`（结束本层探索）必须满足本层结构，否则会被拒绝并列出缺项，用来推动自动轮次继续补：

| 层 | conclude 必须满足 |
| --- | --- |
| 深度 | `findings ≥ 4`、`assumptions ≥ 2`、`methods ≥ 3`、`acceptance`、`falsifiers ≥ 1`、`ceiling` |
| 广度 | `options ≥ 8`、`domains ≥ 4`、`novel ≥ 2`、`shortlist ≥ 2`、`exclusions ≥ 2`、`ceiling` |
| 速度 | `slice`、`tracks ≥ 2`、`dependencies ≥ 1`、`loop`、`scenarios`、`checkpoints ≥ 2`、`ceiling` |

高度层没有 `conclude`，它的门禁在 `confirm`：必须有一句**结果陈述**（不是做法），且 `surfaced` 至少一条——或显式写「原话已完整，无需补充」。这一条是用来证明这次真的挖过，而不是把原话改写一遍。

其它规则：

- **固定约束只挑战一次**：`fixed` 记录后不再反复要求放宽；用户拒答项记入 `declined`，不再追问。
- **跨层一致性**：后层结论与已确认层冲突时，先 `revise` 对应层并重新确认；`close` 首次返回核对清单，必须带 `consistency=true` 才真正关闭。
- **跳过探索**：用户明确要求跳过某层时，`confirm` 传 `skip_explore=true`，该层不自动迭代，但结论仍要确认。
- **goal 归插件所有**：模型不能调用 `create_goal` / `update_goal`（工具守卫会拒绝）；goal 只由插件在层切换时创建和完成。

## goal 行为

- 每层一个 goal，objective 由插件生成：高度结论 + 本层标尺 + 工作区路径 + 纪律。模型不能自己写 objective。
- 轮次安全帽：深度 30 / 广度 24 / 速度 16。到上限后运行时会把 goal 标记为 blocked，模型会先落盘进展并告诉你可以 `revisit` 追加预算或按当前结果确认。
- 会话恢复（resume/fork）后 goal 默认是 disarmed 的；你说「继续」时，模型会通过 `revisit` 重建该层 goal。
- 如果会话里已有**别人的** goal，插件不会动它：本层降级为交互式推进，工具结果里会说明原因；清理该 goal 后 `revisit` 可恢复自动探索。

## 常见问题

- **chip 没出现？** 新装或重装插件后 client 模块图会缓存旧状态，重启一次 DSH 即可。
- **探索停在 blocked？** 轮次到了安全帽；可以 `revisit` 追加预算，或按当前结果确认。
- **会话恢复后不自动探索？** resume/fork 后 goal 默认 disarmed；说「继续」会 `revisit` 重建该层 goal。
- **想跳过某一层？** 明确说「跳过」，`confirm` 会带 `skip_explore=true`，该层不自动迭代，但结论仍要确认。
- **会话里已有别人的 goal？** 插件不会动它：本层降级为交互式推进；清理该 goal 后 `revisit` 可恢复自动探索。
- **会不会改到我的代码？** 文件写入被限制在 `wishes/<slug>/`；高度层禁 shell，探索层拦截危险命令。

## 数据与隐私

- 插件只写工作区的 `wishes/` 目录，不发起网络请求。
- 探索结论、笔记、实验脚本都落在该目录，属于你的工作区，不会被上传。
- 这些文件也是自动轮次被压缩后最可靠的记忆，可随时复查。

## 实现要点

- **Host 半**（`index.js`）
  - `sessionProjections` 单元 `wish`（stateVersion 5）：折叠 `/wish` 命令与 `wish_requirement` 工具调用，模式状态随 resume/fork 恢复。
  - 动态系统提示段 `wish-mode:policy`（order 520）：仅 mode 开启时注入，按阶段注入对话协议 / 探索协议 / 本层标尺 / 已确认层摘要。
  - `wish_requirement` 工具：`start` / `status` / `record` / `conclude` / `confirm` / `revise` / `revisit` / `close`，带顺序门禁、质量门禁与直接人类回合校验。
  - goal 编排：`ctx.goals` 服务直连，层切换时 create/complete；冲突与失败一律降级为交互式，不抛错。
  - 工具守卫 `ctx.tools.guard`：写文件限制在 `wishes/<slug>/`；禁止 `create_goal`/`update_goal`、子 agent/workflow；高度层禁 shell；探索层拦截危险命令。
  - 落盘：`wishes/<slug>/meta.json`、各层 `summary.md`、`plan.md`（全部 best-effort）。
- **Client 半**（`client.js`，纯 JS，无需构建）
  - `conversation.input.left`：模式开关 chip，显示当前层与阶段。
  - `conversation.composer.dock`：四层进度条 + 探索轮次 + 探索目录；只读投影，不新增 RPC。
- **契约**：[`docs/SPEC.md`](https://github.com/totoleo/oh-my-dsh/blob/master/plugins/wish-mode/docs/SPEC.md) 是 Host / Client / 测试三方共用的实现契约。

## 测试

回归测试在源码仓库里运行，不随 npm 包发布（Node 内置模块，无依赖、无网络）：

```bash
npm test          # 15 个用例，退出码非 0 表示失败
```

它用 mock cordis ctx 装配 `apply(ctx)`，驱动 `wish_requirement` 走完整流程，断言状态、文件落盘、goal 编排、守卫与本回合人类确认校验，并用 `tool/call`+`tool/result` 重放校验投影折叠与执行一致。

## 文件

```text
wish-mode/
├── package.json        # 包清单 + dsh.bundle / dsh.client
├── cordis.patch.yml    # 插入插件行
├── index.js            # Host：投影、提示段、命令、工具、goal 编排、守卫、落盘
├── client.js           # Web UI：开关 chip + 四层进度条
├── locale/{zh,en}.json # 插件展示元数据
├── icon.svg            # 许愿骨 W 图标
├── docs/SPEC.md        # 实现契约
├── test/harness.mjs    # 黑盒回归测试
├── AGENTS.md           # agent 规范：改这个包前先读
├── README.md
├── README.en.md
├── CHANGELOG.md
└── LICENSE
```

npm 包只发布运行所需文件（`index.js`、`client.js`、`cordis.patch.yml`、`locale/*`、`icon.svg`、`docs/*`、README / README.en / LICENSE / CHANGELOG），**不含 `test/` 与 `AGENTS.md`**；它们随源码仓库走。

## 设计取舍

- **为什么 goal 由插件管**：模型的 `create_goal` 需要直接人类回合，在自动轮次里根本调不动；而且两套状态机会互相打架。插件持有 goal，模型只管内容与判断。
- **为什么每层都要确认**：自动探索会沿错误方向跑很远；一层一确认可以把偏差挡在下游之前。
- **为什么轮次不固定**：目标是「本层上限」而不是轮数；轮次只是防止无限循环的安全帽，边际收益为零就该收尾。
- **为什么探索要落盘**：自动轮次的上下文会被压缩，文件是比对话历史更可靠的记忆；同时产出的证据与实验本身可复查。

## 贡献

发布与协作流程、新增插件包的约定都在仓库根目录：[`PUBLISH.md`](https://github.com/totoleo/oh-my-dsh/blob/master/PUBLISH.md) 与 [`docs/ADDING_A_PLUGIN.md`](https://github.com/totoleo/oh-my-dsh/blob/master/docs/ADDING_A_PLUGIN.md)（中英双语）。

## 变更记录

见 [`CHANGELOG.md`](https://github.com/totoleo/oh-my-dsh/blob/master/plugins/wish-mode/CHANGELOG.md)。

## 许可证

[MIT](https://github.com/totoleo/oh-my-dsh/blob/master/plugins/wish-mode/LICENSE) © 2026 totolelo
