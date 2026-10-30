# 发布与协作

本仓库是 pnpm workspace：`plugins/` 下每个目录都是一个独立的 npm 包。本文面向所有协作者。主分支为 `master`，仓库：https://github.com/totoleo/oh-my-dsh。

> English: [PUBLISH.en.md](PUBLISH.en.md)

## 角色与权限

| 角色 | 能做什么 | 权限 |
| --- | --- | --- |
| 贡献者 | fork、分支、PR、issue、添加 changeset | 无 |
| 维护者 | review、合并、批准发版 | GitHub write |
| 发布者 | 合并 Version Packages PR | npm `@totoleo` 的发布权限 |

- **合并要求**：CI 通过 + 至少 1 名维护者 review；`master` 开启分支保护。
- **自动化发布**使用仓库 secret `NPM_TOKEN`（npm Automation token，scope 至少 `@totoleo`，read-write）。`GITHUB_TOKEN` 由 Actions 自动提供。

## 环境要求

| 工具 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | >= 20 | CI 与测试（本机开发用 26） |
| pnpm | 11.28.5（`packageManager` 字段） | workspace |
| npm | 11 | 发布 |
| DSH | 0.2.1-rc.3（2026-10 验证）；最低 0.2.1-rc.2 | 安装验证 |

插件依赖 DSH 的 goal 服务、`ctx.tools.guard` 与 `ask_user_question` 作答 attestation；低于 0.2.1-rc.2 不保证自动探索可用。版本要求目前写在文档里，没有加 `engines.dsh`（semver 的预发布范围容易误伤后续 rc）；如果需要机器校验再加。

## 版本与变更记录：changesets

- 每个影响发布包的 PR **必须包含一个 changeset**：

  ```bash
  pnpm changeset
  ```

  选择受影响的包和 bump 类型，写一句面向用户的摘要；生成的 `.changeset/*.md` 随 PR 一起提交。

- 版本号遵循 semver：

  | 变更 | bump |
  | --- | --- |
  | 修 bug、文案、图标 | patch |
  | 新增能力、向后兼容 | minor |
  | 工具 schema / 状态 / 命令不兼容 | major |

- `CHANGELOG.md` 由 `changeset version` 自动生成，不要手改。

## 贡献流程

1. fork 仓库，从 `master` 拉分支：`feat/<topic>` 或 `fix/<topic>`。
2. 改代码；行为变更必须同步更新 `plugins/<name>/test/` 下的测试。
3. 本地验证：

   ```bash
   pnpm install
   pnpm -r test
   ```

4. 添加 changeset：`pnpm changeset`。
5. 提 PR，写清动机、改动范围、测试方式；破坏性变更标注 **BREAKING**。
6. CI 全绿 + 维护者 review 后合并。

### 贡献者如何验证一个 PR

不需要发布权限，用 tarball 在本地 DSH 里试：

```bash
cd plugins/wish-mode
npm pack --pack-destination ../../dist
```

然后 `plugin_manager install_bundle` 指向生成的 `.tgz`（或直接指向包目录）。

## 自动发版流程

1. 带 changeset 的 PR 合并进 `master`。
2. `.github/workflows/release.yml` 运行 `changesets/action`：
   - 有未发布的 changeset → 自动打开 **Version Packages** PR（bump 版本 + 生成 CHANGELOG）。
   - Version Packages PR 合并后 → `changeset publish` 发布到 npm 并打 tag。
3. `.github/workflows/ci.yml` 在每次 PR / push 上跑 `pnpm install --frozen-lockfile --ignore-scripts` + `pnpm -r test`。

## 安全设置（GitHub 侧）

仓库建好后在 GitHub 设置里完成这几项；它们不在 workflow 文件里，但决定发布安全边界：

- **分支保护（`master`）**：要求 CI 通过 + 至少 1 个 review；禁止 force push 和直接 push。
- **Environment `npm-release`**：在 Environments 里加 required reviewers（发布需人工批准）；`NPM_TOKEN` 只在该环境可用。
- **`NPM_TOKEN`**：npm Automation token，scope 只勾 `@totoleo` 的 read-write；定期轮换；不要在任何 workflow 里打印它。
- **PR 安全**：CI 用 `pull_request` 触发（fork PR 只拿到只读 token、看不到 secrets）；不要改成 `pull_request_target`。
- **依赖更新**：`.github/dependabot.yml` 每周检查 npm 与 GitHub Actions。
- **发布溯源**：release workflow 设置 `npm_config_provenance=true`，npm 会生成 provenance（要求公共仓库与 `id-token: write`）。
- **Actions 版本**：当前用主版本 tag；安全要求更高时 pin 到 commit SHA。
- **注意**：changesets 生成的 Version Packages PR 由 `GITHUB_TOKEN` 创建，不会触发 CI；合并前人工确认（或改用 PAT，但要权衡权限范围）。

## 手动发布（首次发布 / 紧急兜底）

自动化链路建立之前，或 CI 故障时：

```bash
cd plugins/wish-mode
npm test
npm pack --dry-run

npm login --registry=https://registry.npmjs.org
npm publish --registry=https://registry.npmjs.org
```

scoped 包首次发布需要 public；`publishConfig.access` 已设为 `public`。

## 发布后验证

```bash
npm view @totoleo/dsh-wish-mode version --registry=https://registry.npmjs.org
```

在 DSH 里按版本安装：

```text
plugin_manager install_bundle
target: "@totoleo/dsh-wish-mode@<version>"
```

检查：输入框左侧出现「许愿」chip，工具列表出现 `wish_requirement`。
如果 chip 没出现，**重启一次 DSH**（client 模块图按进程缓存）。

## 回滚与故障处理

| 情况 | 处理 |
| --- | --- |
| 发错版本 | `npm deprecate @totoleo/dsh-wish-mode@<version> "reason"`；不要 unpublish |
| 需要撤回本地安装 | `plugin_manager remove_bundle` |
| `E403` / 权限错误 | 检查 npm 登录、scope 权限、2FA |
| 发布时没指向 npmjs | 命令显式加 `--registry=https://registry.npmjs.org` |
| 安装后 chip 消失 | 重启 DSH（client 模块图缓存），刷新页面不够 |
| pack 里混入临时文件 | 检查 `package.json` 的 `files` 字段 |

## 联系

- 维护者：@totoleo
- 仓库：https://github.com/totoleo/oh-my-dsh
- 权限申请 / 发布协助：开 issue，注明包名与用途
