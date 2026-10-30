# DSH Plugins

English | [中文](README.md)

[![CI](https://img.shields.io/github/actions/workflow/status/totoleo/oh-my-dsh/ci.yml?branch=master)](https://github.com/totoleo/oh-my-dsh/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Personal collection of [DeepSeek Harness](https://deepseek.com) plugins, managed as a pnpm workspace. Repository: [totoleo/oh-my-dsh](https://github.com/totoleo/oh-my-dsh).

## Quick start

```bash
git clone https://github.com/totoleo/oh-my-dsh.git
cd oh-my-dsh
pnpm install
pnpm -r test
```

Install the plugin into DSH:

```text
plugin_manager install_bundle
target: "@totoleo/dsh-wish-mode"
```

For local development, point `target` at the `plugins/wish-mode` directory instead.

Then type `/wish <your wish>` in the composer.

## Packages

| Package | Status | Description |
| --- | --- | --- |
| [`@totoleo/dsh-wish-mode`](plugins/wish-mode) | pending (2.1.0) | Wish mode: four levels turn a wish into a verified plan; the last three run as plugin-managed goal explorations |

## Layout

```text
oh-my-dsh/
├── AGENTS.md                 # rules for agents working in this repo
├── package.json              # workspace tooling (changesets)
├── pnpm-workspace.yaml
├── .changeset/               # versions and changelogs
├── .github/workflows/        # CI and automated releases
├── docs/                     # collaboration docs (EN / 中文)
├── plugins/
│   └── wish-mode/            # @totoleo/dsh-wish-mode
├── playground/               # experiments and test packages (gitignored)
├── dist/                     # npm pack output (gitignored)
└── wishes/                   # wish-mode runtime output (gitignored)
```

## Development

```bash
pnpm install
pnpm -r test                  # run every package's tests
pnpm pack:check               # show which files the npm package will ship
pnpm changeset                # add a changeset before opening a PR
```

## Docs

- [Agent working rules](AGENTS.md) (Chinese)
- [Altitude layer design](docs/ALTITUDE-DESIGN.md) (Chinese)
- [Publishing & Collaboration](PUBLISH.en.md) · [中文](PUBLISH.md)
- [Adding a plugin package](docs/ADDING_A_PLUGIN.en.md) · [中文](docs/ADDING_A_PLUGIN.md)
- Plugin README: [plugins/wish-mode/README.md](plugins/wish-mode/README.md)

## License

[MIT](LICENSE) © 2026 totolelo
