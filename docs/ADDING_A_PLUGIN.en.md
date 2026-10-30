# Adding a plugin package

This repo uses a pnpm workspace: every directory under `plugins/*` automatically becomes a workspace package. Adding a plugin needs no root configuration — just follow the conventions below.

> 中文: [ADDING_A_PLUGIN.md](ADDING_A_PLUGIN.md)

## 1. Directory

```text
plugins/<name>/
├── package.json
├── cordis.patch.yml
├── index.js          # Host half
├── client.js         # Web Client half (optional)
├── icon.svg          # 64×64
├── locale/{zh,en}.json
├── test/harness.mjs
├── AGENTS.md
├── README.md
├── CHANGELOG.md
└── LICENSE
```

`AGENTS.md` holds the package's rules for agents — constraints and the definition of done. It stays in the repo and never ships in the npm package.

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

- `dsh.bundle.patch`: the bundle insert patch.
- `dsh.client`: declares the Web Client half and the UI packages it depends on.
- `publishConfig.access: "public"`: required for scoped packages.
- No build step: Host and Client are loadable ESM/browser JS as-is.

## 3. cordis.patch.yml

```yaml
- insert:
    - id: <name>
      name: '@totoleo/dsh-<name>'
```

`id` is the plugin row id (unique within a profile); `name` must match `package.json` exactly.

## 4. Host half: index.js

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

Declare dependencies in `inject`; use only public `ctx` services (`tools`, `systemPrompt`, `sessionProjections`, `goals`, …).

## 5. Client half: client.js

```js
window.__ModuleLoader__.load({
  id: '@totoleo/dsh-<name>',          // must equal package.json name
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

- The module `id` must equal the package name, or `client-modules` rejects the registration.
- Read projections only, add no RPCs; draw with `currentColor` so both themes work.

## 6. Locale and icon

`locale/zh.json` / `locale/en.json`:

```json
{ "meta": { "title": "Plugin name", "description": "One sentence." } }
```

`icon.svg`: 64×64, rounded tile, geometric mark still legible at 14px.

## 7. Tests

Ship a black-box harness at `test/harness.mjs`: mock `ctx`, call `apply(ctx)`, drive the tool/command and assert state. Use Node built-ins only, no network. See [`../plugins/wish-mode/test/harness.mjs`](../plugins/wish-mode/test/harness.mjs).

## 8. Local install check

```text
plugin_manager install_bundle
target: "<repo>/plugins/<name>"
```

Verify the plugin row loads, the tool/command works, and the chip/panel appears. If the client half is missing, restart DSH (the client module graph is cached per process).

## 9. Submit

```bash
pnpm install          # workspace picks up plugins/* automatically
pnpm -r test
pnpm changeset        # select the new package; minor for the first release
```

Then open a PR. Publishing follows the automated flow in [Publishing & Collaboration](../PUBLISH.en.md).

## Checklist

- [ ] Package name `@totoleo/dsh-<name>`, directory `<name>`
- [ ] `dsh.bundle.patch` and `dsh.client` point at real files
- [ ] Client module `id` equals the package name
- [ ] `files` contains only what the runtime needs
- [ ] Tests, README, CHANGELOG, LICENSE present
- [ ] `AGENTS.md` present, stating the package's non-negotiable constraints (see [`plugins/wish-mode/AGENTS.md`](../plugins/wish-mode/AGENTS.md))
- [ ] Changeset added
