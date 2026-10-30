# 新增插件包

本仓库用 pnpm workspace 管理，`plugins/*` 下的每个目录都会自动成为 workspace 包。新增一个插件不需要改仓库配置，按下面的约定建目录即可。

> English: [ADDING_A_PLUGIN.en.md](ADDING_A_PLUGIN.en.md)

## 1. 目录

```text
plugins/<name>/
├── package.json
├── cordis.patch.yml
├── index.js          # Host 半
├── client.js         # Web Client 半（可以没有）
├── icon.svg          # 64×64
├── locale/{zh,en}.json
├── test/harness.mjs
├── AGENTS.md
├── README.md
├── CHANGELOG.md
└── LICENSE
```

`AGENTS.md` 写本包给 agent 看的约束与验收口径，只留在仓库里，不进 npm 包。

## 2. package.json

```json
{
  "name": "@totoleo/dsh-<name>",
  "version": "0.1.0",
  "description": "One sentence about what it adds.",
  "type": "module",
  "license": "MIT",
  "author": "totoleo",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": [
    "index.js",
    "client.js",
    "cordis.patch.yml",
    "locale/*.json",
    "icon.svg",
    "README.md",
    "CHANGELOG.md",
    "LICENSE"
  ],
  "scripts": {
    "test": "node test/harness.mjs"
  },
  "publishConfig": {
    "access": "public"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
    }
  }
}
```

- `dsh.bundle.patch`：bundle 的插入补丁。
- `dsh.client`：声明 Web Client 半；`inject` 是它依赖的 UI 包。
- `publishConfig.access: "public"`：scoped 包发布必需。
- 没有构建步骤：Host/Client 都是直接可加载的 ESM/浏览器 JS。

## 3. cordis.patch.yml

```yaml
- insert:
    - id: <name>
      name: '@totoleo/dsh-<name>'
```

`id` 是插件行标识（同一 profile 内唯一），`name` 必须与 `package.json` 的 `name` 完全一致。

## 4. Host 半：index.js

```js
export const inject = ['tools'];
export function apply(ctx) {
  ctx.tools.register({
    name: 'my_tool',
    description: '...',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute(args, exec) { return { ok: true }; },
  });
}
```

依赖通过 `inject` 声明；只使用公开的 `ctx` 服务（`tools`、`systemPrompt`、`sessionProjections`、`goals` 等）。

## 5. Client 半：client.js

```js
window.__ModuleLoader__.load({
  id: '@totoleo/dsh-<name>',          // 必须等于 package.json 的 name
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    function Panel({ useProjection }) {
      const state = useProjection('my-projection');
      return h('div', null, state ? 'ready' : 'idle');
    }

    function apply(ctx) {
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register({ name: 'conversation.composer.dock', id: '<name>-dock' }, Panel));
    }

    return { inject: ['slots'], apply };
  },
});
```

- 模块 `id` 必须等于包名；否则 `client-modules` 会拒绝注册。
- 只读投影、不新增 RPC；用 `currentColor` 画图标，保证亮暗主题都成立。

## 6. locale 与图标

`locale/zh.json` / `locale/en.json`：

```json
{ "meta": { "title": "插件名", "description": "一句话说明" } }
```

`icon.svg`：64×64，带圆角底色，几何图形在 14px 下仍可辨认。

## 7. 测试

放一个黑盒 harness 在 `test/harness.mjs`：mock `ctx`，调用 `apply(ctx)`，驱动工具/命令并断言状态；用 Node 内置模块，不依赖网络。可以参考 [`../plugins/wish-mode/test/harness.mjs`](../plugins/wish-mode/test/harness.mjs)。

## 8. 本地安装验证

```text
plugin_manager install_bundle
target: "<repo>/plugins/<name>"
```

检查插件行加载、工具/命令可用、chip/面板出现。若 client 半没出现，重启 DSH（client 模块图按进程缓存）。

## 9. 提交

```bash
pnpm install          # workspace 自动纳入 plugins/*
pnpm -r test
pnpm changeset        # 选择新包，首次可用 minor
```

然后提 PR。发布走 [发布与协作](../PUBLISH.md) 里的自动化流程。

## 约定清单

- [ ] 包名 `@totoleo/dsh-<name>`，目录名 `<name>`
- [ ] `dsh.bundle.patch` 与 `dsh.client` 都指向存在的文件
- [ ] client 模块 `id` = 包名
- [ ] `files` 只包含运行所需文件
- [ ] 有测试、README、CHANGELOG、LICENSE
- [ ] 有 `AGENTS.md`，写清本包不可协商的约束（参考 [`plugins/wish-mode/AGENTS.md`](../plugins/wish-mode/AGENTS.md)）
- [ ] 有 changeset
