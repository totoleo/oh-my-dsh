# AGENTS.md

本仓库的 agent 工作规范。面向人的协作流程在 [PUBLISH.md](PUBLISH.md)，新增插件在
[ADDING_A_PLUGIN.md](docs/ADDING_A_PLUGIN.md)，单个插件的实现契约在各自 `docs/SPEC.md`。
这里只写代码层面不可协商的约束，以及"算做完"的判据。本文件只维护中文版。

## 仓库

pnpm workspace，`plugins/*` 下每个目录是一个发布到 npm 的包（`@totoleo/dsh-<name>`）。
根包、`playground/`、`dist/`、`wishes/` 都不发布。

## 不可协商

- **零依赖、零构建**：源码直接可加载——Host 是 Node ESM，Client 是浏览器脚本。用 Node
  与浏览器原生能力实现；`dependencies` 保持为空，测试只用 `node:` 内置模块。
- **只用公开接口**：通过 `ctx` 服务（`tools`、`systemPrompt`、`sessionProjections`、
  `goals`、`workingDirectory`、`commands`、`slots`）交互，不 import `@deepseek-ai/*`。
  最低支持 DSH `0.2.1-rc.2`，当前在 `0.2.1-rc.3` 上验证。
- **三处同名**：`package.json` 的 `name`、`cordis.patch.yml` 的 `name`、client 里
  `__ModuleLoader__.load({ id })` 必须一致；改包名时三处一起改。
- **状态是投影**：状态由会话日志 fold 出来。改变 fold 语义或字段形状时提升 `index.js` 的
  `stateVersion`，并同步 `docs/SPEC.md` 的投影一节。
- **守卫是安全边界**：`ctx.tools.guard` 限制可写范围、危险命令与 goal 所有权。每一条限制
  都要有测试证明越界会被拦；放宽任何一条都算改行为。
- **先改契约**：插件的 `docs/SPEC.md` 是唯一实现契约，实现与它冲突时先改它。
- **双语镜像**：`README.md` / `README.en.md`、`docs/ADDING_A_PLUGIN.md` / `.en.md`、
  `PUBLISH.md` / `.en.md` 成对存在；改一边就改另一边，段落结构对齐。
- **`files` 是白名单**：只列运行时需要的文件；测试与 `AGENTS.md` 留在仓库里。

## 一次改动的闭环

1. 读对应契约（`docs/SPEC.md` 或 `docs/ADDING_A_PLUGIN.md`）。
2. 行为有变，先改契约。
3. 改实现，守住上面的约束。
4. 在黑盒 harness 里补断言：一个可观察行为一条，mock `ctx`、驱动工具/命令，不联网。
5. 同步文档（双语）。
6. `pnpm changeset`：patch 修 bug，minor 加行为或参数，major 破坏契约（工具参数、
   落盘结构、投影字段、包名）。
7. 跑验收。

## 算做完

- [ ] `pnpm -r test` 全绿
- [ ] `pnpm pack:check` 的文件清单符合预期（每个包只含运行时文件）
- [ ] 中文与英文文档段落一致
- [ ] 有 `.changeset/*.md`，bump 类型与改动匹配
- [ ] 动了 Host 或 Client：装进 DSH 实机确认过（client 模块图按进程缓存，改动后重启 DSH）

## 本地产物

`wishes/`、`playground/`、`dist/` 是本地运行产物，已在 `.gitignore` 里。提交前保持它们
不进版本库，也不要为了让工作区看起来干净而删掉别人的探索结果。
