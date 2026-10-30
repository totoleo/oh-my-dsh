# AGENTS.md · wish-mode

实现契约在 [docs/SPEC.md](docs/SPEC.md)，中文、唯一权威：实现与它冲突时先改它。改完
`index.js` / `client.js` 之后，在 `test/harness.mjs` 补一条黑盒断言（mock `ctx`，驱动
工具或命令，不联网）。仓库级规范见根目录 [AGENTS.md](../../AGENTS.md)。

## 不能改掉的四条

- **四层都要人确认**：高度是纯对话（探针 + 回述卡，`confirm` 前必须有 `surfaced`），
  深度/广度/速度由插件托管 goal 自动探索到本层上限；没有用户 `confirm`，任何一层都不推进，
  也不允许自动跨层。
- **goal 归插件**：创建、续期、完成都走 `ctx.goals`，轮次上限在 `STAGE_SPEC`。模型只能
  用 `wish_requirement`；直接调 `create_goal` / `update_goal` 由守卫拦下。
- **探索落盘**：只写 `<cwd>/wishes/<slug>/<stage>/`，写失败降级成工具结果里的一行警告，
  模式必须继续可用。
- **守卫兜底**：写文件限制在探索目录，高度层禁命令，命令黑名单挡破坏性操作。放宽任何一条
  都要在 harness 里补"越界被拦"的断言。

## 状态

投影 key `wish`，`stateVersion` 与 SPEC 投影一节同步。状态由会话日志 fold 出来，是唯一
真相：新增的派生状态也要能从日志重放，不要在模块里加可变单例。
