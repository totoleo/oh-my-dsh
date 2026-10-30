# DSH Plugins

[English](README.en.md) | 中文

[![CI](https://img.shields.io/github/actions/workflow/status/totoleo/oh-my-dsh/ci.yml?branch=master)](https://github.com/totoleo/oh-my-dsh/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

个人 DeepSeek Harness 插件集合，pnpm workspace 管理。仓库：[totoleo/oh-my-dsh](https://github.com/totoleo/oh-my-dsh)。

## 快速开始

```bash
git clone https://github.com/totoleo/oh-my-dsh.git
cd oh-my-dsh
pnpm install
pnpm -r test
```

装进 DSH 试用：

```text
plugin_manager install_bundle
target: "@totoleo/dsh-wish-mode"
```

本地源码调试时，把 `target` 换成仓库里的 `plugins/wish-mode` 路径。

然后在输入框输入 `/wish <你的原话>`。

## 包

| 包 | 状态 | 说明 |
| --- | --- | --- |
| [`@totoleo/dsh-wish-mode`](plugins/wish-mode) | 待发布（2.1.0） | 许愿模式：四层把愿望变成可验证的方案，后三层由插件托管 goal 自动探索 |

## 结构

```text
oh-my-dsh/
├── AGENTS.md                 # agent 工作规范
├── package.json              # workspace 工具链（changesets）
├── pnpm-workspace.yaml
├── .changeset/               # 版本与 CHANGELOG 由 changeset 管理
├── .github/workflows/        # CI 与自动发布
├── docs/                     # 协作文档（中英）
├── plugins/
│   └── wish-mode/            # @totoleo/dsh-wish-mode
├── playground/               # 实验与测试包（gitignored）
├── dist/                     # 打包产物（gitignored）
└── wishes/                   # wish-mode 运行产物（gitignored）
```

## 开发

```bash
pnpm install
pnpm -r test                  # 跑所有包的测试
pnpm pack:check               # 看 npm 包会装进哪些文件
pnpm changeset                # 提交 PR 前生成变更说明
```

## 文档

- [agent 工作规范](AGENTS.md)
- [高度层设计](docs/ALTITUDE-DESIGN.md)
- [发布与协作](PUBLISH.md) · [English](PUBLISH.en.md)
- [新增插件包](docs/ADDING_A_PLUGIN.md) · [English](docs/ADDING_A_PLUGIN.en.md)
- 插件说明：[plugins/wish-mode/README.md](plugins/wish-mode/README.md)

## License

[MIT](LICENSE) © 2026 totolelo
