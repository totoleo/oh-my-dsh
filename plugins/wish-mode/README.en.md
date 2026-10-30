# Wish Mode

[中文](https://github.com/totoleo/oh-my-dsh/blob/master/plugins/wish-mode/README.md) | English

[![npm](https://img.shields.io/npm/v/@totoleo/dsh-wish-mode.svg)](https://www.npmjs.com/package/@totoleo/dsh-wish-mode)
[![CI](https://img.shields.io/github/actions/workflow/status/totoleo/oh-my-dsh/ci.yml?branch=master)](https://github.com/totoleo/oh-my-dsh/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/totoleo/oh-my-dsh/blob/master/plugins/wish-mode/LICENSE)

> Wishes are free; proving them is what counts.

Wish Mode is a [DeepSeek Harness](https://deepseek.com) plugin: before you build, it turns a wish into a verified plan across four levels — **altitude** (pure dialogue), **depth** (evidence), **range** (options) and **speed** (execution). The last three run as plugin-managed goal explorations and write their findings to `wishes/`; every level needs your explicit confirmation.

## What problem it solves

- **Wrong direction**: you start coding, then discover halfway that you are solving the wrong problem.
- **Thin evidence**: the plan rests on intuition — no evidence, no validation, no falsifiers.
- **Too few options**: you only see one path and never compare how other fields do it.
- **Scattered execution**: no smallest slice, no parallel tracks, no checkpoints.

Wish Mode splits these into four levels, each with a concrete output and a confirmation gate. **Every level must be confirmed by the user** (`confirm` checks that the current turn contains a direct human message); the plugin never confirms on your behalf.

**Good fit**: exploratory work where the requirement is fuzzy, the direction is unsettled, or you fear building the wrong thing.
**Poor fit**: pure execution tasks where it is already clear which line to change.

## Quick start

Requires DSH ≥ 0.2.1-rc.2 (the plugin depends on the goal service, `ctx.tools.guard`, and the `ask_user_question` answer attestation); verified on DSH Desktop 0.2.1-rc.3 in 2026-10.

1. Install:

   ```text
   plugin_manager install_bundle
   target: "@totoleo/dsh-wish-mode"
   ```

   Pin a version with a full spec, e.g. `"@totoleo/dsh-wish-mode@2.1.0"`.

2. Wish in your own words:

   ```text
   /wish I want to make 100k a year without leaving my bed
   ```

3. Answer the 1–3 questions in the **altitude** level (the model uses one probe at a time). The plugin hands back a **requirement recap** card: correct it line by line, then confirm — depth exploration starts automatically.

After installation a wish-mode chip appears at the left of the composer. If the chip does not show up after a fresh install or reinstall, **restart DSH once** (the client module graph is cached per process).

Source install (for development): `git clone https://github.com/totoleo/oh-my-dsh.git` and point `plugin_manager install_bundle` at `plugins/wish-mode`.

## How the four levels work

| Level | Mode | Questions it answers | Output |
| --- | --- | --- | --- |
| **Altitude** | dialogue + probes + recap card | Lift the *task* into an *outcome* and surface what was never said (nine probes — goal, concrete case, conflict, boundary, cost, observation, carrier, reuse, playback — one at a time) | Outcome statement + how you will know + boundaries + what surfaced (surfaced) |
| **Depth** | goal exploration | Which material, which methods, how to verify | Findings and evidence + key assumptions and their verification + method comparison + acceptance criteria + falsifiers |
| **Range** | goal exploration | Widen the fields, tools and methods that can contribute; innovation is the point | Cross-field candidates + novel ideas + shortlist + exclusions |
| **Speed** | goal exploration | Push execution efficiency to the ceiling without sacrificing quality | Smallest verifiable slice + parallel tracks + critical path + reliability scenarios + checkpoints |

```text
Altitude (dialogue, 1–3 questions/round) ──user confirm──▶ Depth (goal exploration) ──reach ceiling ▶ waiting for confirmation ──user confirm──▶ Range ──▶ Speed ──▶ close
```

- Order is a hard constraint: you cannot enter the next level until the current one is confirmed; **speed** is always last.
- **Altitude**: the model asks 1–3 questions at a time, may offer candidates, but never chooses for you; it gives a judgement only when you say "you decide". No experiments and no project changes in this level.
- **Depth/Range/Speed**: the plugin creates a goal when you enter the level, and the model advances the level's output in automatic rounds; when it needs your input it asks a blocking question instead of answering itself. Before ending each level the model states its ceiling judgement and stops for your confirmation.
- If the exploration reaches the ceiling early, the model **wraps up proactively** instead of burning rounds; the round cap is only a safety belt.
- Not satisfied? Say "keep digging" and the model will `revisit` the level with a fresh budget; say "this is wrong" and it will `revise` and ask you to confirm again.

## Commands and entry points

- `/wish <your words>`: start with those words as the topic; if a mode is already open with a different topic, restart with the new one.
- `/wish on` / `/wish off`: explicitly enable / disable (disabling completes the goal created by the plugin).
- `/wish`: toggle the mode (this no-argument form is what the composer chip uses).
- You can also tell the model "enter wish mode" or "clarify the requirement first"; it will call `wish_requirement` to start.
- Once the mode is on, an `Altitude → Depth → Range → Speed` progress strip appears below the composer: the current level shows "dialogue / exploring / waiting for your confirmation / confirmed", and while exploring it also shows `round n/m` and the exploration directory.

## Output: `wishes/<directory>/<level>/`

The directory name is an English condensation of the topic — **3–5 short lowercase words joined by `-`** (e.g. `reduce-onboarding-friction`), not your raw input. When you start with `/wish <topic>`, the plugin first uses an automatic name `wish-xxxxxxxx` and the model replaces it with a real one at the altitude level; you can also just say "call the directory xxx".

```text
wishes/
└── reduce-onboarding-friction/
    ├── meta.json           # plugin: topic, stage, updated-at
    ├── altitude/summary.md # plugin: per-level conclusion, ceiling judgement, structured fields
    ├── depth/
    │   ├── summary.md
    │   ├── notes.md        # model: notes, evidence tables
    │   └── ...             # model: experiment scripts and results
    ├── range/summary.md
    ├── speed/summary.md
    └── plan.md             # plugin: the full plan written on close
```

- The model may freely create files and run experiments inside the current level's directory; **file-tool writes are restricted to that directory**, and shell commands are checked for common destructive operations (`rm -rf`, `git` writes, etc.), so exploration does not silently touch project code.
- If a plugin write fails, the tool result shows a one-line warning and the mode continues.

## Quality gates

`conclude` (ending a level's exploration) must satisfy the level's structure, otherwise it is rejected and the missing items are listed so the automatic rounds keep filling them in:

| Level | `conclude` must satisfy |
| --- | --- |
| Depth | `findings ≥ 4`, `assumptions ≥ 2`, `methods ≥ 3`, `acceptance`, `falsifiers ≥ 1`, `ceiling` |
| Range | `options ≥ 8`, `domains ≥ 4`, `novel ≥ 2`, `shortlist ≥ 2`, `exclusions ≥ 2`, `ceiling` |
| Speed | `slice`, `tracks ≥ 2`, `dependencies ≥ 1`, `loop`, `scenarios`, `checkpoints ≥ 2`, `ceiling` |

Altitude has no `conclude`; its gate sits on `confirm`: an **outcome** statement (not a task) plus at least one `surfaced` item — or an explicit "the original request was already complete". It is there to prove the layer actually dug, instead of paraphrasing the user's words back.

Other rules:

- **Fixed constraints are challenged once**: after `fixed` is recorded the plugin stops asking to relax them; declined questions are recorded in `declined` and not asked again.
- **Cross-level consistency**: if a later level conflicts with a confirmed level, `revise` that level first and confirm again; the first `close` returns a checklist and only closes when called with `consistency=true`.
- **Skipping exploration**: when the user explicitly asks to skip a level, `confirm` with `skip_explore=true`; the level does not auto-iterate, but its conclusion still needs confirmation.
- **Goals are owned by the plugin**: the model cannot call `create_goal` / `update_goal` (the tool guard rejects them); goals are created and completed only by the plugin at level transitions.

## Goal behavior

- One goal per level; the objective is generated by the plugin from the altitude conclusion + the level's yardstick + the workspace path + the discipline. The model cannot write the objective.
- Round caps: depth 30 / range 24 / speed 16. At the cap the runtime marks the goal blocked; the model persists progress first and tells you that you can `revisit` for more budget or confirm the current result.
- After a session resume/fork the goal is disarmed by default; when you say "continue", the model rebuilds the level goal through `revisit`.
- If the session already has **someone else's** goal, the plugin leaves it alone: the level degrades to interactive mode and the tool result explains why; after that goal is cleared, `revisit` restores automatic exploration.

## FAQ

- **Chip missing?** After a fresh install or reinstall the client module graph caches the old state; restart DSH once.
- **Exploration stuck in blocked?** The round cap was reached; `revisit` for more budget or confirm the current result.
- **No automatic exploration after resume?** Goals are disarmed after resume/fork; say "continue" and the model will `revisit` to rebuild the level goal.
- **Skip a level?** Say "skip"; `confirm` will pass `skip_explore=true`; the level does not auto-iterate, but its conclusion still needs confirmation.
- **Someone else's goal in the session?** The plugin leaves it alone and the level degrades to interactive mode; clear that goal and `revisit` to restore automatic exploration.
- **Will it touch my code?** File writes are restricted to `wishes/<slug>/`; altitude disables shell, and exploration blocks dangerous commands.

## Data and privacy

- The plugin writes only to the workspace's `wishes/` directory and makes no network requests.
- Conclusions, notes and experiment scripts live there; they belong to your workspace and are never uploaded.
- Those files are also the most reliable memory after automatic rounds are compacted, and can be reviewed at any time.

## Implementation

- **Host half** (`index.js`)
  - `sessionProjections` unit `wish` (stateVersion 5): folds `/wish` commands and `wish_requirement` tool calls; the mode state survives resume/fork.
  - Dynamic system-prompt section `wish-mode:policy` (order 520): injected only while the mode is on, with the dialogue protocol / exploration protocol / level yardstick / confirmed-level summaries per stage.
  - `wish_requirement` tool: `start` / `status` / `record` / `conclude` / `confirm` / `revise` / `revisit` / `close`, with order gates, quality gates and a direct-human-turn check.
  - Goal orchestration: talks to `ctx.goals` directly, creates/completes on level transitions; conflicts and failures degrade to interactive mode instead of throwing.
  - Tool guard `ctx.tools.guard`: file writes restricted to `wishes/<slug>/`; blocks `create_goal`/`update_goal`, sub-agents/workflows; altitude disables shell; exploration blocks dangerous commands.
  - Persistence: `wishes/<slug>/meta.json`, per-level `summary.md`, `plan.md` (all best-effort).
- **Client half** (`client.js`, plain JS, no build step)
  - `conversation.input.left`: the mode toggle chip, showing the current level and phase.
  - `conversation.composer.dock`: four-level progress + exploration rounds + exploration directory; read-only projection, no new RPCs.
- **Contract**: [`docs/SPEC.md`](https://github.com/totoleo/oh-my-dsh/blob/master/plugins/wish-mode/docs/SPEC.md) is the implementation contract shared by Host / Client / tests.

## Tests

The regression tests live in the source repository and are not published to npm (Node built-ins only, no dependencies, no network):

```bash
npm test          # 15 cases; non-zero exit means failure
```

They assemble `apply(ctx)` with a mock cordis ctx, drive `wish_requirement` through the full flow, assert state, persistence, goal orchestration, guards and the direct-human-turn check, and replay `tool/call` + `tool/result` to verify that projection folding matches execution.

## Files

```text
wish-mode/
├── package.json        # manifest + dsh.bundle / dsh.client
├── cordis.patch.yml    # inserts the plugin row
├── index.js            # Host: projection, prompt section, command, tool, goal orchestration, guard, persistence
├── client.js           # Web UI: toggle chip + four-level progress
├── locale/{zh,en}.json # display metadata
├── icon.svg            # wishbone W icon
├── docs/SPEC.md        # implementation contract
├── test/harness.mjs    # black-box regression tests
├── AGENTS.md           # rules for agents: read before changing this package
├── README.md
├── README.en.md
├── CHANGELOG.md
└── LICENSE
```

The npm package ships only runtime files (`index.js`, `client.js`, `cordis.patch.yml`, `locale/*`, `icon.svg`, `docs/*`, README / README.en / LICENSE / CHANGELOG); **`test/` and `AGENTS.md` are excluded** and ship with the source repository.

## Design decisions

- **Why the plugin owns the goal**: the model's `create_goal` requires a direct human turn and cannot be called from automatic rounds; also, two state machines would fight. The plugin holds the goal; the model only produces content and judgement.
- **Why every level needs confirmation**: automatic exploration can run far in the wrong direction; one confirmation per level catches the drift before it compounds.
- **Why rounds are not fixed**: the target is the level's ceiling, not a round count; rounds are only a safety belt against infinite loops, and the model should stop when marginal value hits zero.
- **Why exploration is persisted**: automatic rounds get compacted; files are more reliable memory than the transcript, and the evidence and experiments remain reviewable.

## Contributing

Publishing, collaboration and the conventions for adding a plugin package live at the repository root: [`PUBLISH.md`](https://github.com/totoleo/oh-my-dsh/blob/master/PUBLISH.md) and [`docs/ADDING_A_PLUGIN.md`](https://github.com/totoleo/oh-my-dsh/blob/master/docs/ADDING_A_PLUGIN.md) (English and Chinese).

## Changelog

See [`CHANGELOG.md`](https://github.com/totoleo/oh-my-dsh/blob/master/plugins/wish-mode/CHANGELOG.md).

## License

[MIT](https://github.com/totoleo/oh-my-dsh/blob/master/plugins/wish-mode/LICENSE) © 2026 totolelo
