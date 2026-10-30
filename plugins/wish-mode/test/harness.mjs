#!/usr/bin/env node
/**
 * Black-box harness for the `wish-mode` Host plugin (v2).
 *
 * Contract: docs/SPEC.md in the plugin root (§1–§6, §11 are behavioural).
 * Runtime contract shapes (ctx services, tool/guard/projection registrations,
 * session events) mirror the real DSH packages so the harness exercises the
 * same code paths the Host does.
 *
 * Design rules:
 * - Node builtins only, ESM, no network, fresh tmpdir per scenario, deterministic.
 * - Build a mock cordis ctx, import the plugin, call apply(ctx), grab the
 *   registered tool / policy section / command / guard / projection.
 * - Drive `execute(args, { agent, signal })` and assert state + files.
 * - Every successful tool call is replayed through the registered projection
 *   as a `tool/call` + `tool/result` event pair, exactly like the Host log.
 *
 * Run: node test/harness.mjs   (from the plugin directory)
 * Output: PASS/FAIL per test, summary counts, exit code 1 on any failure.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, '..');
const PLUGIN_PATH = path.join(PLUGIN_DIR, 'index.js');

const STAGES = ['altitude', 'depth', 'range', 'speed'];
const STAGE_LABEL = { altitude: '高度', depth: '深度', range: '广度', speed: '速度' };
const STAGE_ROUNDS = { depth: 30, range: 24, speed: 16 };
const GOAL_PREFIX = '[wish-';
const PROJECTION_KEY = 'wish';
const STATE_VERSION = 8;
const ACTIONS = ['start', 'status', 'record', 'conclude', 'confirm', 'revise', 'revisit', 'close'];

const TOPIC = '把新用户首次成功时间降下来';
const ALTITUDE_SUMMARY = '把新用户首次成功时间从 10 分钟降到 3 分钟';
const ALTITUDE_SURFACED = '用户补充：首次成功只算「完成第一个真实任务」，不含浏览功能';
const DEPTH_SUMMARY = '用 3 份访谈和 2 个漏斗实验确定瓶颈';

/** Harness-level spec deviations that were consciously tolerated (reported). */
const specDeviations = [];
function noteDeviation(message) {
  if (!specDeviations.includes(message)) specDeviations.push(message);
}

// ---------------------------------------------------------------------------
// Small assertion / pure helpers
// ---------------------------------------------------------------------------

const textOf = (error) => (error !== null && typeof error === 'object' && error.message !== undefined
  ? String(error.message)
  : String(error));

function indentError(error) {
  return String((error !== null && typeof error === 'object' && error.stack) || error)
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n');
}

function freshFlags() {
  return { altitude: false, depth: false, range: false, speed: false };
}

function allConfirmed(confirmed) {
  return STAGES.every((stage) => confirmed[stage] === true);
}

/** SPEC §8 auto slug — independent re-implementation of the documented rule. */
function autoSlug(topic) {
  let hash = 0x811c9dc5;
  const text = String(topic ?? '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `wish-${hash.toString(16).padStart(8, '0')}`;
}

/** 正式目录名：3–5 个英文单词。 */
const SLUG = 'reduce-onboarding-friction';

/** SPEC §2 phase derivation for the current layer (active states only). */
function expectedPhase(state) {
  if (state === undefined || state === null || state.active !== true) return 'idle';
  const stage = state.stage;
  if (state.confirmed[stage] === true) return 'confirmed';
  if (state.reviewed[stage] === true) return 'reviewing';
  if (stage === 'altitude') return 'talking';
  return 'exploring';
}

/** The durable part of the folded projection state — no transient pending/running. */
function foldView(state) {
  return {
    active: state.active,
    topic: state.topic,
    slug: state.slug,
    stage: state.stage,
    confirmed: state.confirmed,
    reviewed: state.reviewed,
    skipped: state.skipped,
    revised: state.revised,
    summaries: state.summaries,
    ceilings: state.ceilings,
    fields: state.fields,
    steps: state.steps,
  };
}

// ---------------------------------------------------------------------------
// Mock goal service (shape mirrors @deepseek-ai/dsh-goal GoalService)
// ---------------------------------------------------------------------------

function createGoalsService() {
  const calls = [];
  const flags = { failGet: false, failCreate: false, failComplete: false };
  let current;
  let counter = 0;

  function makeView(request) {
    counter += 1;
    return {
      id: `goal-${counter}`,
      revision: 1,
      objective: request.objective,
      phase: 'active',
      maxGoalRounds: request.maxGoalRounds ?? 30,
      roundsStarted: 0,
      createdAt: 1700000000000 + counter,
      updatedAt: 1700000000000 + counter,
      activation: 'armed',
    };
  }

  const service = {
    calls,
    flags,
    /** Test hook: pre-install a foreign / own goal as the current one. */
    setCurrent(view) {
      current = view;
    },
    get(agent) {
      calls.push({ op: 'get', agent });
      if (flags.failGet) throw new Error('mock goal service: get failed');
      return current;
    },
    create(agent, request) {
      calls.push({ op: 'create', agent, request: { ...request } });
      if (flags.failCreate) throw new Error('mock goal service: create failed');
      current = makeView(request);
      calls[calls.length - 1].view = current;
      return current;
    },
    complete(agent, ref) {
      calls.push({ op: 'complete', agent, ref });
      if (flags.failComplete) throw new Error('mock goal service: complete failed');
      if (current === undefined) throw new Error('mock goal service: no current goal');
      if (ref !== undefined && ref !== null && ref.id !== undefined && ref.id !== current.id) {
        throw new Error('mock goal service: stale goal ref');
      }
      if (current.phase !== 'complete') {
        current = { ...current, revision: current.revision + 1, phase: 'complete', updatedAt: current.updatedAt + 1 };
      }
      return current;
    },
    // The v2 contract only uses get/create/complete; other mutations are recorded no-ops.
    edit(agent, ref, request) {
      calls.push({ op: 'edit', agent, ref, request: { ...request } });
      if (current !== undefined) current = { ...current, ...request, revision: current.revision + 1 };
      return current;
    },
    pause(agent, ref) {
      calls.push({ op: 'pause', agent, ref });
      if (current !== undefined) current = { ...current, phase: 'paused', revision: current.revision + 1 };
      return current;
    },
    resume(agent, ref) {
      calls.push({ op: 'resume', agent, ref });
      if (current !== undefined) current = { ...current, phase: 'active', revision: current.revision + 1 };
      return current;
    },
    clear(agent, ref) {
      calls.push({ op: 'clear', agent, ref });
      current = undefined;
      return ref;
    },
    disarm(agent) {
      calls.push({ op: 'disarm', agent });
      return current;
    },
  };
  return service;
}

// ---------------------------------------------------------------------------
// Mock cordis context + session projection registry
// ---------------------------------------------------------------------------

function createMockContext({ workingDir, session, agent, goals }) {
  const registry = {
    tools: [],
    guards: [],
    sections: [],
    commands: [],
    projections: [],
    effects: [],
    injects: [],
  };

  const projections = {
    register(definition) {
      registry.projections.push(definition);
      return () => {
        const index = registry.projections.indexOf(definition);
        if (index >= 0) registry.projections.splice(index, 1);
      };
    },
    /** Host-style read: fold the registered unit over the session event log. */
    stateOf(targetSession, key) {
      if (key === 'turnBoundary') return targetSession.turnBoundary;
      const definition = registry.projections.find((entry) => entry.key === key);
      if (definition === undefined) return undefined;
      let state = typeof definition.init === 'function'
        ? definition.init(targetSession.header, 0)
        : undefined;
      for (const event of targetSession.events) state = definition.apply(state, event);
      return state;
    },
    snapshot(targetSession, keys) {
      const values = {};
      for (const definition of registry.projections) {
        if (keys !== undefined && !keys.includes(definition.key)) continue;
        if (typeof definition.wire?.view !== 'function') continue;
        values[definition.key] = definition.wire.view(projections.stateOf(targetSession, definition.key));
      }
      return { asOfSeq: targetSession.events.length - 1, values };
    },
  };

  const agents = {
    roots: () => [agent],
    currentInitiator: () => agent,
    get: (id) => (id === agent.id ? agent : undefined),
  };

  const workingDirectory = {
    get: () => workingDir,
  };

  const tools = {
    register(definition) {
      registry.tools.push(definition);
      return () => {};
    },
    guard(guard) {
      registry.guards.push(guard);
      return () => {};
    },
    get(name) {
      return registry.tools.find((definition) => definition.name === name);
    },
    schemas() {
      return registry.tools;
    },
  };

  const systemPrompt = {
    section(definition) {
      registry.sections.push(definition);
      return () => {};
    },
  };

  const commands = {
    register(definition) {
      registry.commands.push(definition);
      return () => {};
    },
  };

  const services = {
    tools,
    systemPrompt,
    commands,
    sessionProjections: projections,
    agents,
    workingDirectory,
  };
  if (goals !== undefined) services.goals = goals;

  const ctx = {
    ...services,
    get(name) {
      return services[name];
    },
    inject(_deps, callback) {
      registry.injects.push([..._deps]);
      return callback(ctx);
    },
    effect(callback) {
      registry.effects.push(callback);
      const disposer = callback(ctx);
      return typeof disposer === 'function' ? disposer : () => {};
    },
  };

  return { ctx, registry };
}

// ---------------------------------------------------------------------------
// Scenario: one fresh tmpdir + session + applied plugin instance
// ---------------------------------------------------------------------------

function createScenario(plugin, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wish-harness-'));
  const session = {
    id: `session-${Math.random().toString(16).slice(2)}`,
    header: { cwd: dir },
    events: [],
    turnBoundary: { openTurnStartSeq: null },
    snapshotEvents() {
      return session.events.slice();
    },
  };
  const agent = {
    id: `agent-${session.id}`,
    status: 'running',
    session,
    steer() {},
  };
  const goals = options.withGoals === false ? undefined : createGoalsService();
  const { ctx, registry } = createMockContext({ workingDir: dir, session, agent, goals });

  const apply = typeof plugin.apply === 'function' ? plugin.apply : plugin.default?.apply;
  if (typeof apply !== 'function') throw new Error('plugin does not export apply(ctx)');
  apply(ctx);

  const tool = registry.tools.find((definition) => definition.name === 'wish_requirement');
  const section = registry.sections.find((definition) => definition.name === 'wish-mode:policy');
  const command = registry.commands.find((definition) => definition.name === 'wish');
  const guard = registry.guards[0];
  const projection = registry.projections.find((definition) => definition.key === PROJECTION_KEY);

  const parity = { successes: [], failures: [] };
  let callCounter = 0;
  let guardCounter = 0;
  let commandCounter = 0;

  function appendEvent(event) {
    const committed = { ...event, seq: session.events.length };
    session.events.push(committed);
    return committed;
  }

  /** Open a model turn that contains no direct human message. */
  function modelTurn() {
    session.turnBoundary = { openTurnStartSeq: session.events.length - 1 };
  }

  /** Open a turn that starts with a direct human message (§5 authority source). */
  function openHumanTurn(text = '继续') {
    const seq = session.events.length;
    session.events.push({
      seq,
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
    });
    session.turnBoundary = { openTurnStartSeq: seq - 1 };
  }

  function stateOf() {
    if (projection === undefined) throw new Error('wish projection was not registered');
    const state = ctx.sessionProjections.stateOf(session, PROJECTION_KEY);
    if (state === undefined) throw new Error('wish projection returned undefined state');
    return state;
  }

  function assertValueShape(value, label) {
    assert.ok(value !== null && typeof value === 'object', `${label}: tool value must be an object`);
    const keys = [
      'active', 'topic', 'slug', 'stage', 'stageLabel', 'phase', 'done',
      'confirmed', 'reviewed', 'steps', 'questions', 'guidance', 'plan',
      'exploreDir', 'nextStep', 'goal',
    ];
    for (const key of keys) {
      assert.ok(Object.hasOwn(value, key), `${label}: missing output key "${key}" (§3.5)`);
    }
    assert.ok(STAGES.includes(value.stage), `${label}: stage must be one of ${STAGES.join('/')} (§3.5)`);
    assert.equal(value.stageLabel, STAGE_LABEL[value.stage], `${label}: stageLabel (§3.5)`);
    assert.ok(['idle', 'talking', 'exploring', 'reviewing', 'blocked', 'paused', 'confirmed'].includes(value.phase),
      `${label}: phase "${value.phase}" not in §2/§3.5 vocabulary`);
    assert.equal(typeof value.active, 'boolean', `${label}: active must be boolean`);
    assert.equal(typeof value.done, 'boolean', `${label}: done must be boolean`);
    assert.equal(value.done, allConfirmed(value.confirmed), `${label}: done must equal all-four-confirmed (§3.5)`);
    assert.deepEqual(Object.keys(value.confirmed).sort(), [...STAGES].sort(), `${label}: confirmed must cover 4 stages`);
    assert.deepEqual(Object.keys(value.reviewed).sort(), [...STAGES].sort(), `${label}: reviewed must cover 4 stages`);
    for (const stage of STAGES) {
      assert.equal(typeof value.confirmed[stage], 'boolean', `${label}: confirmed.${stage}`);
      assert.equal(typeof value.reviewed[stage], 'boolean', `${label}: reviewed.${stage}`);
    }
    assert.ok(Number.isInteger(value.steps) && value.steps >= 0, `${label}: steps must be a non-negative integer`);
    assert.ok(Array.isArray(value.questions), `${label}: questions must be an array`);
    for (const question of value.questions) assert.equal(typeof question, 'string', `${label}: questions[] entries`);
    assert.equal(typeof value.guidance, 'string', `${label}: guidance must be a string`);
    assert.ok(value.guidance.length > 0, `${label}: guidance must be non-empty (§3.5)`);
    assert.equal(typeof value.plan, 'string', `${label}: plan must be a string`);
    if (value.active) assert.equal(value.plan, '', `${label}: plan must be "" while active (§3.5)`);
    assert.equal(typeof value.exploreDir, 'string', `${label}: exploreDir must be a string`);
    if (value.slug === '') assert.equal(value.exploreDir, '', `${label}: exploreDir must be "" without a slug (§3.5)`);
    else assert.ok(path.isAbsolute(value.exploreDir), `${label}: exploreDir must be absolute (§3.5)`);
    assert.equal(typeof value.nextStep, 'string', `${label}: nextStep must be a string`);
    assert.ok(value.nextStep.length > 0, `${label}: nextStep must be non-empty`);
    assert.ok(value.goal === null || typeof value.goal === 'object', `${label}: goal must be null or object (§3.5)`);
  }

  async function execute(args, options2 = {}) {
    const expectError = options2.expectError === true;
    if (tool === undefined) throw new Error('wish_requirement tool was not registered');
    callCounter += 1;
    const callId = `call-${callCounter}`;
    const before = projection === undefined ? undefined : ctx.sessionProjections.stateOf(session, PROJECTION_KEY);
    let value;
    let error;
    try {
      value = await tool.execute(args, { agent, signal: new AbortController().signal, callId });
    } catch (caught) {
      error = caught;
    }
    appendEvent({
      type: 'tool/call',
      data: {
        name: tool.name,
        callId,
        arguments: JSON.stringify(args),
      },
    });
    if (error !== undefined) {
      appendEvent({
        type: 'tool/result',
        data: {
          message: {
            source: { callId },
            isError: true,
            content: [{ type: 'text', text: textOf(error) }],
          },
          error: { message: textOf(error) },
        },
      });
    } else {
      const meta = typeof tool.output?.presentationMeta === 'function'
        ? tool.output.presentationMeta(args, value)
        : undefined;
      appendEvent({
        type: 'tool/result',
        data: {
          message: {
            source: { callId },
            isError: false,
            content: [{ type: 'text', text: typeof value?.guidance === 'string' ? value.guidance : '' }],
          },
          meta,
        },
      });
    }
    const after = projection === undefined ? undefined : ctx.sessionProjections.stateOf(session, PROJECTION_KEY);
    if (error !== undefined) {
      if (!expectError) throw error;
      parity.failures.push({ args, before, after, error });
      return { error };
    }
    if (expectError) {
      throw new Error(`expected action=${String(args.action)} to be rejected, but it succeeded`);
    }
    assertValueShape(value, `action=${String(args.action)}`);
    parity.successes.push({ args, value, before, after });
    return value;
  }

  async function expectError(args) {
    const result = await execute(args, { expectError: true });
    return result.error;
  }

  function guardCall(name, args) {
    if (guard === undefined) throw new Error('tools.guard was not registered');
    guardCounter += 1;
    return guard({
      name,
      arguments: args,
      agent,
      callId: `guard-${guardCounter}`,
      signal: new AbortController().signal,
    });
  }

  async function runCommand(rawInput) {
    if (command === undefined) throw new Error('wish command was not registered');
    commandCounter += 1;
    const commandId = `command-${commandCounter}`;
    appendEvent({ type: 'command/run', data: { name: 'wish', args: rawInput, commandId } });
    const result = await command.handler({ agent, rawInput, input: rawInput, session });
    appendEvent({ type: 'command/done', data: { commandId, kind: 'success' } });
    return result;
  }

  /**
   * Append a synthetic `ask_user_question` tool/call + tool/result pair inside the
   * current open turn (no `user/message`). Mirrors how the Host logs a structured
   * question answer: §3.1/§5 count a successful answer as human attestation, but a
   * timed-mode `"pending":true` timeout or an errored call does not.
   */
  function appendAskUserQuestion({ callId, answer = '', pending = false, failed = false } = {}) {
    appendEvent({
      type: 'tool/call',
      data: { name: 'ask_user_question', callId, arguments: JSON.stringify({ question: '请确认本层结论' }) },
    });
    const text = pending
      ? `{"pending":true,"questionId":"${callId}","question":"请确认本层结论"}`
      : (answer || '用户已回答：对，确认');
    const data = {
      message: { source: { callId }, content: [{ type: 'text', text }] },
    };
    if (failed) data.error = { message: 'ask_user_question failed' };
    appendEvent({ type: 'tool/result', data });
  }

  function goalCalls(op) {
    if (goals === undefined) return [];
    return goals.calls.filter((call) => call.op === op);
  }

  function cleanup() {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* best effort */
    }
  }

  return {
    dir,
    session,
    agent,
    ctx,
    registry,
    goals,
    tool,
    section,
    command,
    guard,
    projection,
    parity,
    execute,
    expectError,
    guardCall,
    runCommand,
    appendAskUserQuestion,
    goalCalls,
    modelTurn,
    openHumanTurn,
    stateOf,
    cleanup,
  };
}

// ---------------------------------------------------------------------------
// Reusable flow fragments
// ---------------------------------------------------------------------------

/** start → record altitude → human confirm(altitude); returns the confirm value. */
async function startAndConfirmAltitude(s, topic = TOPIC) {
  s.openHumanTurn('先许愿这个需求');
  const started = await s.execute({ action: 'start', topic, slug: SLUG });
  await s.execute({
    action: 'record',
    summary: `高度结论：${topic}`,
    surfaced: [ALTITUDE_SURFACED],
    fixed: ['每周只能投入 2 人周'],
    open: ['落地页可以更换'],
    declined: ['不讨论品牌改名'],
    materials: ['3 份用户访谈'],
    success: '首次成功时间 < 3 分钟',
    notDoing: '不做新手引导视频',
    rationale: '用户原话',
  });
  s.openHumanTurn('对，就是这个目标');
  const confirmed = await s.execute({ action: 'confirm', userSaid: '对，就是这个目标' });
  return { started, confirmed };
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`FAIL  ${name}`);
    console.log(indentError(error));
  }
}

async function main() {
  if (!fs.existsSync(PLUGIN_PATH)) {
    console.error(`FATAL: plugin not found at ${PLUGIN_PATH}`);
    process.exit(2);
  }
  const plugin = await import(pathToFileURL(PLUGIN_PATH).href);

  // -------------------------------------------------------------------------
  // 1. Registrations (§11): tool / policy section / command / guard / projection
  // -------------------------------------------------------------------------
  await test('registrations: tool, policy section, command, guard, projection (§11)', async () => {
    const s = createScenario(plugin);
    try {
      assert.ok(s.tool !== undefined, 'wish_requirement tool must be registered');
      assert.equal(s.tool.name, 'wish_requirement');
      assert.equal(typeof s.tool.execute, 'function', 'tool.execute');
      assert.ok(s.tool.parameters !== null && typeof s.tool.parameters === 'object', 'tool.parameters');
      assert.ok(s.tool.parameters.properties?.action !== undefined, 'parameters.action');
      assert.deepEqual([...s.tool.parameters.properties.action.enum].sort(), [...ACTIONS].sort(),
        'action enum must expose the 8 v2 actions (§3)');
      assert.ok(Array.isArray(s.tool.parameters.required) && s.tool.parameters.required.includes('action'),
        'action must be required (§3.2)');
      assert.ok(s.tool.output?.schema !== undefined, 'tool.output.schema must be declared (§3.5)');
      assert.equal(typeof s.tool.output?.presentationMeta, 'function', 'presentationMeta must be declared (§3.5)');

      assert.ok(s.section !== undefined, 'policy section must be registered (§9)');
      assert.equal(s.section.name, 'wish-mode:policy', 'policy section name (§9)');
      assert.equal(s.section.order, 520, 'policy section order (§9)');
      assert.equal(typeof s.section.text, 'function', 'policy section text');

      assert.ok(s.command !== undefined, 'wish command must be registered');
      assert.equal(s.command.name, 'wish');
      assert.equal(typeof s.command.handler, 'function', 'command handler');
      assert.equal(s.registry.guards.length, 1, 'exactly one global tool guard must be registered (§6)');
      assert.equal(typeof s.registry.guards[0], 'function', 'tool guard must be a function');

      assert.ok(s.projection !== undefined, 'wish projection must be registered (§2)');
      assert.equal(s.projection.key, PROJECTION_KEY);
      assert.equal(s.projection.stateVersion, STATE_VERSION, 'STATE_VERSION must be 8 (§2)');
      assert.equal(typeof s.projection.init, 'function', 'projection.init');
      assert.equal(typeof s.projection.apply, 'function', 'projection.apply');
      assert.equal(typeof s.projection.wire?.view, 'function', 'projection.wire.view (§7)');
    } finally {
      s.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // 2. Inactive status + policy absence (§3.5, §9, §2)
  // -------------------------------------------------------------------------
  await test('inactive: status value shape, idle phase, empty policy (§2, §3.5, §9)', async () => {
    const s = createScenario(plugin);
    try {
      s.modelTurn();
      const status = await s.execute({ action: 'status' });
      assert.equal(status.active, false, 'status before start: inactive');
      assert.equal(status.phase, 'idle', 'inactive phase must be idle (§2)');
      assert.equal(status.exploreDir, '', 'no slug → empty exploreDir (§3.5)');
      assert.equal(status.plan, '');
      assert.equal(status.goal, null);
      assert.deepEqual(status.confirmed, freshFlags());
      assert.deepEqual(status.reviewed, freshFlags());
      assert.deepEqual(status.questions, []);
      assert.equal(s.section.text({ agent: s.agent }), '', 'policy must not inject text while inactive (§9)');
    } finally {
      s.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // 3. slug rules (§8)
  // -------------------------------------------------------------------------
  await test('slug rules: 3–5 英文单词、自动名兜底、可替换 (§8)', async () => {
    const s = createScenario(plugin);
    try {
      // 合法 slug：小写 + dash 连接，原样作为目录名。
      s.openHumanTurn();
      const named = await s.execute({ action: 'start', topic: TOPIC, slug: 'Reduce Onboarding Friction' });
      assert.equal(named.slug, SLUG, 'slug 归一化为 3–5 词小写 dash 连接 (§8)');
      assert.equal(path.basename(named.exploreDir), SLUG, 'exploreDir basename 就是 slug');
      assert.ok(path.isAbsolute(named.exploreDir), 'exploreDir must be absolute');
      assert.ok(
        named.exploreDir.startsWith(path.join(s.dir, 'wishes') + path.sep),
        `exploreDir must live under <cwd>/wishes (§1): ${named.exploreDir}`,
      );

      // 已经正式命名后，再给不同的 slug 不改名。
      s.openHumanTurn();
      const kept = await s.execute({ action: 'start', topic: TOPIC, slug: 'another-topic-name' });
      assert.equal(kept.slug, SLUG, '正式命名后不再改名 (§8)');

      // 非法 slug（中文 / 2 词 / 6 词）→ 自动名 + 警告。
      s.openHumanTurn();
      const auto = await s.execute({ action: 'start', topic: '换个主题试试', slug: '中文目录' });
      assert.match(auto.slug, /^wish-[0-9a-f]{8}$/, '非法 slug 退化为自动目录名 (§8)');
      assert.equal(auto.slug, autoSlug('换个主题试试'), '自动目录名对同一主题稳定 (§8)');
      assert.match(auto.guidance, /3–5 个简短英文单词/, '非法 slug 要给出修正提示 (§8)');

      // 自动名还来得及换成正式名。
      s.openHumanTurn();
      const renamed = await s.execute({ action: 'start', slug: 'switch-the-directory-name' });
      assert.equal(renamed.slug, 'switch-the-directory-name', '自动名可被 start 替换 (§8)');
      assert.equal(path.basename(renamed.exploreDir), 'switch-the-directory-name');
      assert.equal(renamed.topic, '换个主题试试', '替换目录名不改主题 (§8)');

      // 词数与超长限制。
      s.openHumanTurn();
      const tooMany = await s.execute({ action: 'start', topic: '主题三', slug: 'a-b-c-d-e-f' });
      assert.match(tooMany.slug, /^wish-[0-9a-f]{8}$/, '6 个词不是合法 slug (§8)');
    } finally {
      s.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // 3.5 altitude: recap card + surfaced gate (§3.3, §9)
  // -------------------------------------------------------------------------
  await test('altitude: 需求回述 + surfaced 门禁 (§3.3, §9)', async () => {
    const s = createScenario(plugin);
    try {
      s.openHumanTurn('先许愿这个需求');
      const started = await s.execute({ action: 'start', topic: TOPIC, slug: SLUG });

      // 回述卡：七节齐全。
      const recap = started.guidance;
      assert.match(recap, /需求回述/, 'altitude guidance must carry the recap card (§9)');
      for (const section of ['结果', '怎么算成', '不让步', '可以换', '明确不做', '这次谈出来的', '还没定']) {
        assert.ok(recap.includes(section), `recap must have 「${section}」 (§9)`);
      }

      // 任务句 summary → 回述卡给警示。
      const taskish = await s.execute({ action: 'record', summary: '做一个新手引导页' });
      assert.match(taskish.guidance, /⚠|像做法/, 'task-shaped summary must raise a hint (§9)');

      // 只有 summary、没有 surfaced → confirm 被拒。
      s.openHumanTurn('对，就是这个目标');
      const denied = await s.expectError({ action: 'confirm', userSaid: '对，就是这个目标' });
      assert.match(textOf(denied), /surfaced|这次谈出来的/, 'confirm must require surfaced (§3.3)');

      // 显式豁免可以过。
      s.openHumanTurn();
      await s.execute({
        action: 'record',
        summary: ALTITUDE_SUMMARY,
        surfaced: ['原话已完整，无需补充'],
      });
      s.openHumanTurn('对，就是这个目标');
      const confirmed = await s.execute({ action: 'confirm', userSaid: '对，就是这个目标' });
      assert.equal(confirmed.stage, 'depth', 'altitude confirm passes with the surfaced exemption (§3.3)');

      // surfaced 落盘。
      const file = path.join(started.exploreDir, 'altitude', 'summary.md');
      assert.ok(fs.existsSync(file), 'altitude summary written (§1)');
      assert.ok(fs.readFileSync(file, 'utf8').includes('这次谈出来的'), 'summary.md renders surfaced (§1)');

      // 不越界：surfaced 不进 depth 的 objective。
      const created = s.goalCalls('create').at(-1);
      assert.ok(created !== undefined, 'confirm(altitude) must create the depth goal (§4.1)');
      assert.ok(!created.request.objective.includes('原话已完整'), 'surfaced must not leak into the objective (§4.2)');
    } finally {
      s.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // 4. Policy section content (§9)
  // -------------------------------------------------------------------------
  await test('policy section: empty when inactive, altitude + exploring protocols when active (§9)', async () => {
    const s = createScenario(plugin);
    try {
      assert.equal(s.section.text({ agent: s.agent }), '', 'inactive policy must be empty');
      s.openHumanTurn();
      const started = await s.execute({ action: 'start', topic: TOPIC, slug: SLUG });
      const altitudePolicy = s.section.text({ agent: s.agent });
      assert.equal(typeof altitudePolicy, 'string');
      assert.ok(altitudePolicy.length > 0, 'active policy must be non-empty (§9)');
      assert.match(altitudePolicy, /高度/, 'policy must include the current stage (§9.1)');
      assert.match(altitudePolicy, /ask_user_question/, 'altitude protocol must allow ask_user_question (§9.2)');
      assert.ok(altitudePolicy.includes(started.exploreDir) || altitudePolicy.includes(`wishes/${started.slug}/`),
        'policy must expose the explore workspace (§9.1)');

      await s.execute({ action: 'record', summary: ALTITUDE_SUMMARY, surfaced: [ALTITUDE_SURFACED] });
      s.openHumanTurn();
      const confirmed = await s.execute({ action: 'confirm', userSaid: '对，就是这个目标' });
      assert.equal(confirmed.stage, 'depth');
      const depthPolicy = s.section.text({ agent: s.agent });
      assert.match(depthPolicy, /深度/, 'depth policy must name the current stage');
      assert.ok(depthPolicy.includes(confirmed.exploreDir), 'exploring policy must expose the absolute stage workspace (§9.1)');
      assert.match(depthPolicy, /轮|round/i, 'exploring policy must mention goal rounds (§9.1)');
      assert.match(depthPolicy, /goal/i, 'exploring policy must mention plugin-managed goals (§9.3)');
    } finally {
      s.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // 5. meta.json (§1)
  // -------------------------------------------------------------------------
  await test('meta.json: topic / slug / createdAt / stages (§1)', async () => {
    const s = createScenario(plugin);
    try {
      s.openHumanTurn();
      const started = await s.execute({ action: 'start', topic: TOPIC, slug: SLUG });
      const metaPath = path.join(started.exploreDir, 'meta.json');
      assert.ok(fs.existsSync(metaPath), `meta.json must be written under ${started.exploreDir} (§1)`);
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      assert.equal(meta.topic, TOPIC, 'meta.topic must be the user topic (§1)');
      assert.equal(meta.slug, started.slug, 'meta.slug (§1)');
      assert.ok(Array.isArray(meta.stages), 'meta.stages must be a list (§1)');
      assert.deepEqual([...meta.stages].sort(), [...STAGES].sort(), 'meta.stages must cover the four stages (§1)');
      assert.ok(Object.hasOwn(meta, 'createdAt'), 'meta.json must contain createdAt (§1)');
    } finally {
      s.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // 6. Tool guard (§6)
  // -------------------------------------------------------------------------
  await test('tool guard: file boundary, goal tools, spawn tools, shell rules (§6)', async () => {
    const inactive = createScenario(plugin);
    try {
      const outside = path.join(inactive.dir, 'outside.txt');
      assert.equal(inactive.guardCall('write', { file_path: outside, content: 'x' }), undefined,
        'guard must stay inert while the mode is inactive (§6)');
      assert.equal(inactive.guardCall('create_goal', { objective: 'x' }), undefined,
        'goal tools must be allowed while the mode is inactive (§6)');
    } finally {
      inactive.cleanup();
    }

    const s = createScenario(plugin);
    try {
      s.openHumanTurn();
      const started = await s.execute({ action: 'start', topic: '守卫测试' });
      const exploreDir = started.exploreDir;
      const outside = path.join(s.dir, 'outside.txt');
      const inside = path.join(exploreDir, 'altitude', 'notes.md');
      const insideOtherStage = path.join(exploreDir, 'depth', 'notes.md');

      const denyOutsideWrite = s.guardCall('write', { file_path: outside, content: 'x' });
      assert.equal(typeof denyOutsideWrite, 'string', 'write outside the explore root must be denied');
      assert.ok(denyOutsideWrite.includes(exploreDir), '§6 denial must name the explore directory');
      assert.equal(typeof s.guardCall('edit', { file_path: outside, old_string: 'a', new_string: 'b' }), 'string',
        'edit outside the explore root must be denied');
      assert.equal(s.guardCall('write', { file_path: inside, content: 'x' }), undefined,
        'write inside the explore root must be allowed');
      assert.equal(s.guardCall('write', { file_path: insideOtherStage, content: 'x' }), undefined,
        'write inside any stage dir of the slug must be allowed');
      // altitude is the conversation layer: no shell execution.
      assert.equal(typeof s.guardCall('bash', { command: 'ls' }), 'string', 'bash must be denied in altitude');
      assert.equal(typeof s.guardCall('pwsh', { command: 'Get-ChildItem' }), 'string', 'pwsh must be denied in altitude');
      // Plugin-owned goals.
      assert.equal(typeof s.guardCall('create_goal', { objective: 'x' }), 'string', 'create_goal must be denied');
      assert.equal(typeof s.guardCall('update_goal', { objective: 'x' }), 'string', 'update_goal must be denied');
      assert.match(s.guardCall('create_goal', { objective: 'x' }), /goal/i, 'goal denial must mention goal ownership (§6)');
      // No sub-agents that could bypass the file boundary.
      for (const name of ['subagent', 'subagent_fork', 'workflow', 'ralph', 'spawn_teammate']) {
        assert.equal(typeof s.guardCall(name, {}), 'string', `${name} must be denied while the mode is active (§6)`);
      }
      // Unrelated tools stay allowed.
      assert.equal(s.guardCall('read', { file_path: outside }), undefined, 'read must stay allowed');
      assert.equal(s.guardCall('grep', { pattern: 'x' }), undefined, 'grep must stay allowed');

      // Reach the depth layer (exploration allows shell, with dangerous-pattern denials).
      await s.execute({ action: 'record', summary: '守卫测试高度结论', surfaced: ['守卫测试谈出来的点'] });
      s.openHumanTurn();
      const depth = await s.execute({ action: 'confirm', userSaid: '确认' });
      assert.equal(depth.stage, 'depth');
      assert.equal(s.guardCall('bash', { command: 'node --version' }), undefined, 'safe bash must be allowed in exploration');
      assert.equal(s.guardCall('pwsh', { command: 'Get-ChildItem' }), undefined, 'safe pwsh must be allowed in exploration');
      for (const command of ['rm -rf build', 'git commit -m "x"', 'git push origin main', 'git reset --hard']) {
        assert.equal(typeof s.guardCall('bash', { command }), 'string', `dangerous bash must be denied: ${command} (§6)`);
      }
      assert.equal(typeof s.guardCall('pwsh', { command: 'Remove-Item -Recurse -Force .' }), 'string',
        'recursive deletion via pwsh must be denied (§6)');
      assert.equal(typeof s.guardCall('write', { file_path: outside, content: 'x' }), 'string',
        'file boundary must still hold in exploration layers');
    } finally {
      s.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // 7. Goal orchestration: ownership conflict / replace / missing service (§4.1, §4.4)
  // -------------------------------------------------------------------------
  await test('goal orchestration: foreign goal conflict, own completed replacement, missing service (§4)', async () => {
    // (a) A foreign active goal must NOT be touched: degrade with a warning, no create.
    const conflict = createScenario(plugin);
    try {
      conflict.goals.setCurrent({
        id: 'foreign-goal',
        revision: 3,
        objective: '用户自己创建的 goal',
        phase: 'active',
        maxGoalRounds: 10,
        roundsStarted: 1,
        createdAt: 1,
        updatedAt: 2,
        activation: 'armed',
      });
      const { confirmed } = await startAndConfirmAltitude(conflict, '冲突测试');
      assert.equal(confirmed.stage, 'depth', 'the mode must keep working while degraded (§4.4)');
      assert.equal(conflict.goalCalls('create').length, 0, 'must not create a goal while a foreign goal is current (§4.4)');
      assert.equal(confirmed.goal, null, 'no plugin goal is exposed while a foreign goal is current');
      assert.match(confirmed.guidance, /其他 goal/, 'tool result must explain the conflict (§4.4)');
      assert.match(confirmed.guidance, /不自动迭代/, 'tool result must explain the degraded interactive mode (§4.4)');
    } finally {
      conflict.cleanup();
    }

    // (b) A completed own goal may be replaced.
    const replace = createScenario(plugin);
    try {
      replace.goals.setCurrent({
        id: 'old-own-goal',
        revision: 9,
        objective: `${GOAL_PREFIX}altitude] 旧主题`,
        phase: 'complete',
        maxGoalRounds: 30,
        roundsStarted: 30,
        createdAt: 1,
        updatedAt: 2,
        activation: 'disarmed',
      });
      const { confirmed } = await startAndConfirmAltitude(replace, '替换测试');
      assert.equal(confirmed.stage, 'depth');
      const creates = replace.goalCalls('create');
      assert.equal(creates.length, 1, 'a completed own goal must be replaced by a fresh depth goal (§4.4)');
      assert.ok(creates[0].request.objective.startsWith(`${GOAL_PREFIX}depth] `));
    } finally {
      replace.cleanup();
    }

    // (c) Missing goal service: degrade with a warning instead of failing.
    const missing = createScenario(plugin, { withGoals: false });
    try {
      const { confirmed } = await startAndConfirmAltitude(missing, '无 goal 服务');
      assert.equal(confirmed.stage, 'depth', 'the mode must work without a goal service (§4.4)');
      assert.equal(confirmed.goal, null);
      assert.match(confirmed.guidance, /goal 服务/, 'missing goal service must surface as a warning line (§4.4)');
    } finally {
      missing.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // 8. Main behavioural flow (§11)
  // -------------------------------------------------------------------------
  await test('main flow: start → altitude → depth gate → conclude → confirm → skip_explore → speed → close (§11)', async () => {
    const s = createScenario(plugin);
    try {
      // --- start requires a direct human turn (§3.1, §5) -------------------
      s.modelTurn();
      const startNoHuman = await s.expectError({ action: 'start', topic: TOPIC });
      assert.match(textOf(startNoHuman), /直接/, 'start without a human turn must be rejected (§3.1)');
      assert.match(textOf(startNoHuman), /用户/, 'start rejection must mention the user (§3.1)');

      s.openHumanTurn();
      const started = await s.execute({ action: 'start', topic: TOPIC, slug: SLUG });
      const slug = SLUG;
      assert.equal(started.active, true);
      assert.equal(started.stage, 'altitude');
      assert.equal(started.phase, 'talking', 'altitude talking phase (§2)');
      assert.equal(started.topic, TOPIC);
      assert.equal(started.slug, slug);
      assert.equal(started.questions.length, 4, 'altitude/talking exposes the 4 fixed questions (§3.5)');
      assert.equal(started.goal, null, 'altitude has no goal (§3.5)');
      assert.equal(started.exploreDir, path.join(s.dir, 'wishes', slug));
      assert.ok(fs.existsSync(path.join(started.exploreDir, 'meta.json')), 'meta.json written on start (§1)');

      // --- record altitude (§3.2: record lands, does not advance) -----------
      const altitudeRecorded = await s.execute({
        action: 'record',
        summary: ALTITUDE_SUMMARY,
        surfaced: [ALTITUDE_SURFACED],
        fixed: ['预算不超过 2 人周'],
        open: ['落地页可以更换'],
        declined: ['不讨论品牌改名'],
        materials: ['3 份用户访谈'],
        success: '首次成功时间 < 3 分钟',
        notDoing: '不做新手引导视频',
        rationale: '用户原话',
      });
      assert.equal(altitudeRecorded.stage, 'altitude', 'record must not advance the stage (§3.2)');
      assert.equal(altitudeRecorded.active, true);
      const altitudeSummaryFile = path.join(started.exploreDir, 'altitude', 'summary.md');
      assert.ok(fs.existsSync(altitudeSummaryFile), 'record must write <stage>/summary.md (§1)');
      assert.ok(fs.readFileSync(altitudeSummaryFile, 'utf8').includes(ALTITUDE_SUMMARY), 'altitude summary content (§1)');

      // --- confirm(altitude) gates: userSaid + human turn (§3.3) ------------
      s.openHumanTurn();
      const confirmNoUserSaid = await s.expectError({ action: 'confirm' });
      assert.match(textOf(confirmNoUserSaid), /用户|原话|userSaid/i, 'confirm must require userSaid (§3.3)');

      s.modelTurn();
      const confirmNoHuman = await s.expectError({ action: 'confirm', userSaid: '确认' });
      assert.match(textOf(confirmNoHuman), /直接/, 'confirm must require a direct human turn (§3.1)');

      s.openHumanTurn();
      const altitudeConfirmed = await s.execute({ action: 'confirm', userSaid: '对，就是这个目标' });
      assert.equal(altitudeConfirmed.stage, 'depth', 'confirm(altitude) advances to depth (§3.4)');
      assert.equal(altitudeConfirmed.confirmed.altitude, true);
      assert.equal(altitudeConfirmed.reviewed.altitude, true);
      assert.equal(altitudeConfirmed.phase, 'exploring', 'depth exploration phase (§2)');
      assert.ok(altitudeConfirmed.questions.length > 0, 'exploring questions list unmet conclude gates (§3.5)');
      const depthCreates = s.goalCalls('create');
      assert.equal(depthCreates.length, 1, 'confirm(altitude) creates the depth goal (§4.1)');
      assert.ok(depthCreates[0].request.objective.startsWith(`${GOAL_PREFIX}depth] `),
        `depth objective prefix (§4.2): ${depthCreates[0].request.objective}`);
      assert.ok(depthCreates[0].request.objective.includes(TOPIC), 'depth objective quotes the topic (§4.2)');
      assert.equal(depthCreates[0].request.maxGoalRounds, STAGE_ROUNDS.depth, 'depth goal round budget (§4.3/§12)');
      assert.ok(altitudeConfirmed.goal !== null, 'depth goal must be exposed in the tool value (§3.5)');
      assert.equal(altitudeConfirmed.goal.phase, 'active');
      assert.equal(altitudeConfirmed.goal.maxGoalRounds, STAGE_ROUNDS.depth);

      // --- depth conclude gate rejection (§3.3) ---------------------------
      await s.execute({ action: 'record', summary: DEPTH_SUMMARY, materials: ['访谈原始记录'] });
      const gateError = await s.expectError({ action: 'conclude', ceiling: '深度层的上限判断' });
      const gateMessage = textOf(gateError);
      assert.match(gateMessage, /还缺/, 'conclude gate rejection must list what is missing (§3.3)');
      for (const field of ['findings', 'assumptions', 'methods', 'acceptance', 'falsifiers']) {
        assert.match(gateMessage, new RegExp(field), `gate rejection must list "${field}" (§3.3)`);
      }
      const afterGateFailure = s.stateOf();
      assert.equal(afterGateFailure.reviewed.depth, false, 'a rejected conclude must not mark reviewed (§3.3)');
      assert.equal(afterGateFailure.stage, 'depth');
      assert.equal(s.goalCalls('complete').length, 0, 'a rejected conclude must not complete the goal');

      // --- fill depth fields, conclude (§3.3, §4.1) -----------------------
      await s.execute({
        action: 'record',
        summary: DEPTH_SUMMARY,
        findings: ['f1 ← 访谈 A · 复访验证', 'f2 ← 漏斗数据 · 实验验证', 'f3 ← 客服记录 · 抽样', 'f4 ← 竞品拆解 · 复核'],
        assumptions: ['a1 → 用 3 次访谈验证 → 已验证', 'a2 → 用 2 周实验验证 → 待验证'],
        methods: ['m1 访谈 · 低成本 · 选', 'm2 问卷 · 中等 · 不选', 'm3 漏斗实验 · 中高 · 选'],
        acceptance: '首次成功时间 < 3 分钟且样本 ≥ 200',
        falsifiers: ['若 2 周内无显著差异则放弃改版'],
      });
      const depthSummaryFile = path.join(started.exploreDir, 'depth', 'summary.md');
      assert.ok(fs.existsSync(depthSummaryFile), 'depth/summary.md written (§1)');
      assert.ok(fs.readFileSync(depthSummaryFile, 'utf8').includes(DEPTH_SUMMARY));

      const depthConcluded = await s.execute({ action: 'conclude', ceiling: '已覆盖访谈与漏斗两条证据链；更深的归因需要线上实验，本层做不到' });
      assert.equal(depthConcluded.reviewed.depth, true, 'conclude marks the layer reviewed (§3.4)');
      assert.equal(depthConcluded.phase, 'reviewing', 'reviewing phase (§2)');
      assert.ok(depthConcluded.questions.length > 0, 'reviewing exposes the layer review questions (§3.5)');
      assert.ok(depthConcluded.goal !== null && depthConcluded.goal.phase === 'complete',
        'conclude completes the layer goal (§4.1)');
      const depthCompletes = s.goalCalls('complete');
      assert.equal(depthCompletes.length, 1, 'conclude must complete the depth goal (§4.1)');
      assert.equal(depthCompletes[0].ref?.id, depthCreates[0].view.id);

      // --- confirm(depth) → range goal (§4.1) ---------------------------
      s.openHumanTurn();
      const depthConfirmed = await s.execute({ action: 'confirm', userSaid: '深度结论可以' });
      assert.equal(depthConfirmed.stage, 'range');
      assert.equal(depthConfirmed.confirmed.depth, true);
      assert.equal(depthConfirmed.reviewed.depth, true);
      assert.equal(depthConfirmed.phase, 'exploring');
      const allCreatesAfterDepth = s.goalCalls('create');
      assert.equal(allCreatesAfterDepth.length, 2, 'confirm(depth) creates the range goal (§4.1)');
      const rangeCreate = allCreatesAfterDepth[1];
      assert.ok(rangeCreate.request.objective.startsWith(`${GOAL_PREFIX}range] `), 'range objective prefix (§4.2)');
      assert.equal(rangeCreate.request.maxGoalRounds, STAGE_ROUNDS.range, 'range goal round budget (§4.3/§12)');

      // --- confirm(range) without review is rejected (§3.3) -------------
      s.openHumanTurn();
      const rangeNoReview = await s.expectError({ action: 'confirm', userSaid: '广度结论我确认' });
      assert.match(textOf(rangeNoReview), /conclude|跳过|skip|收尾/i,
        'confirm without review must require conclude or skip_explore (§3.3)');
      assert.equal(s.stateOf().confirmed.range, false, 'rejected confirm must not confirm the layer');

      // --- skip_explore path (§3.3, §3.4) ---------------------------------
      const rangeSkipped = await s.execute({
        action: 'confirm',
        userSaid: '广度不用探索了，直接跳过',
        skip_explore: true,
      });
      assert.equal(rangeSkipped.stage, 'speed', 'skip_explore confirm advances to speed (§3.4)');
      assert.equal(rangeSkipped.confirmed.range, true);
      assert.equal(rangeSkipped.reviewed.range, true);
      assert.equal(rangeSkipped.phase, 'exploring');
      assert.equal(s.stateOf().skipped.range, true, 'skip_explore must be recorded in skipped (§2/§3.3)');
      const createsAfterRange = s.goalCalls('create');
      assert.equal(createsAfterRange.length, 3, 'confirm(range) creates the speed goal (§4.1)');
      assert.ok(createsAfterRange[2].request.objective.startsWith(`${GOAL_PREFIX}speed] `), 'speed objective prefix (§4.2)');
      assert.equal(createsAfterRange[2].request.maxGoalRounds, STAGE_ROUNDS.speed, 'speed goal round budget (§4.3/§12)');
      assert.ok(fs.existsSync(path.join(started.exploreDir, 'range', 'summary.md')),
        'skipping still writes range/summary.md (§1)');

      // --- speed: record, conclude, confirm -------------------------------
      const speedGate = await s.expectError({ action: 'conclude', ceiling: '速度层上限' });
      assert.match(textOf(speedGate), /SUMMARY|结论|summary|缺/i, 'speed conclude needs a recorded summary first');

      await s.execute({
        action: 'record',
        summary: '先做 2 天切片验证注册页改版',
        slice: '只改注册页首屏，2 天，验证首屏流失假设',
        tracks: ['前端改版', '埋点验证'],
        dependencies: ['埋点上线后才能读数据'],
        loop: '当前 2 周一次，缩短到每 2 天看一次漏斗',
        scenarios: 'base 60% / upside 80% / fallback 保持现状',
        checkpoints: ['第 2 天看埋点数据', '第 4 天决定是否全量'],
      });
      const speedConcluded = await s.execute({ action: 'conclude', ceiling: '切片已最小；更快会牺牲可验证性，做不到更快' });
      assert.equal(speedConcluded.reviewed.speed, true);
      assert.equal(speedConcluded.phase, 'reviewing');
      assert.ok(speedConcluded.goal !== null && speedConcluded.goal.phase === 'complete');

      s.openHumanTurn();
      const speedConfirmed = await s.execute({ action: 'confirm', userSaid: '速度方案确认' });
      assert.equal(speedConfirmed.confirmed.speed, true);
      assert.equal(speedConfirmed.done, true, 'all four layers confirmed (§3.3)');
      assert.equal(speedConfirmed.phase, 'confirmed', 'confirmed phase (§2)');
      assert.deepEqual(speedConfirmed.questions, [], 'confirmed layers expose no questions (§3.5)');
      assert.equal(s.goalCalls('create').length, 3, 'speed is the last layer: no further goal is created (§4.1)');

      // --- close: checklist first, then consistency=true (§3.3) -----------
      s.modelTurn();
      const closeNoHuman = await s.expectError({ action: 'close', consistency: true });
      assert.match(textOf(closeNoHuman), /直接/, 'real close requires a direct human turn (§3.1)');

      s.openHumanTurn();
      const checklist = await s.execute({ action: 'close' });
      assert.equal(checklist.active, true, 'first close only returns the checklist, not a close (§3.3)');
      assert.equal(checklist.plan, '');
      assert.match(checklist.guidance, /关闭前核对/, 'first close returns the consistency checklist (§3.3)');

      const closed = await s.execute({ action: 'close', consistency: true });
      assert.equal(closed.active, false, 'consistency=true closes the mode (§3.3)');
      assert.equal(closed.done, true);
      assert.equal(closed.phase, 'idle', 'closed mode phase is idle (§2)');
      assert.ok(closed.plan.length > 0, 'close produces the plan document (§3.4/§3.5)');
      assert.ok(closed.plan.includes(TOPIC), 'plan includes the topic');
      assert.ok(closed.plan.includes(ALTITUDE_SUMMARY), 'plan includes the altitude summary');
      assert.ok(closed.plan.includes(DEPTH_SUMMARY), 'plan includes the depth summary');

      // --- file layout under <cwd>/wishes/<slug>/ (§1) ------------------
      const exploreDir = started.exploreDir;
      for (const stage of STAGES) {
        assert.ok(fs.existsSync(path.join(exploreDir, stage, 'summary.md')),
          `${stage}/summary.md must exist at the end of the flow (§1)`);
      }
      const planPath = path.join(exploreDir, 'plan.md');
      assert.ok(fs.existsSync(planPath), 'close writes plan.md (§1)');
      const planFile = fs.readFileSync(planPath, 'utf8');
      assert.ok(planFile.includes(TOPIC), 'plan.md includes the topic');
      assert.ok(planFile.includes(ALTITUDE_SUMMARY), 'plan.md includes the altitude summary');
      assert.ok(planFile.includes(DEPTH_SUMMARY), 'plan.md includes the depth summary');

      // --- mode is fully closed: guard inert, policy gone (§6, §9) --------
      assert.equal(s.section.text({ agent: s.agent }), '', 'closed mode must not inject policy text (§9)');
      assert.equal(s.guardCall('write', { file_path: path.join(s.dir, 'outside.txt'), content: 'x' }), undefined,
        'guard must be inert after close (§6)');
    } finally {
      s.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // 9. Projection fold replay parity (§2, §11)
  // -------------------------------------------------------------------------
  await test('projection fold replay: events reproduce execute transitions (§2, §11)', async () => {
    const s = createScenario(plugin);
    try {
      // A failed call first: it must not move durable state.
      s.modelTurn();
      await s.expectError({ action: 'start', topic: 'parity' });

      s.openHumanTurn();
      await s.execute({ action: 'start', topic: 'parity topic' });
      await s.execute({ action: 'record', summary: 'parity altitude summary', fixed: ['p1'], surfaced: ['parity surfaced'] });
      s.openHumanTurn();
      await s.execute({ action: 'confirm', userSaid: 'ok' });
      await s.execute({ action: 'record', summary: 'parity depth summary' });
      await s.expectError({ action: 'conclude', ceiling: 'parity ceiling' }); // gate rejection
      await s.execute({
        action: 'record',
        findings: ['f1', 'f2', 'f3', 'f4'],
        assumptions: ['a1', 'a2'],
        methods: ['m1', 'm2', 'm3'],
        acceptance: 'acceptance',
        falsifiers: ['x1'],
      });
      await s.execute({ action: 'conclude', ceiling: 'parity ceiling' });
      await s.execute({ action: 'revise', dimension: 'altitude', summary: 'parity revised altitude' });
      await s.execute({ action: 'revisit', dimension: 'depth' });

      const def = s.projection;
      assert.ok(def !== undefined);

      // (a) Deterministic replay from init over the committed event log.
      let replayed = def.init(s.session.header, 0);
      for (const event of s.session.events) replayed = def.apply(replayed, event);
      assert.deepEqual(replayed, s.stateOf(), 'independent replay must equal the live folded state (§11)');
      let replayedAgain = def.init(s.session.header, 0);
      for (const event of s.session.events) replayedAgain = def.apply(replayedAgain, event);
      assert.deepEqual(replayedAgain, replayed, 'replay must be deterministic (§2)');

      // (b) Every successful execute value must equal the state after its events.
      assert.ok(s.parity.successes.length >= 8, 'expected a rich event sequence');
      for (const step of s.parity.successes) {
        const state = step.after;
        const label = `replay parity for action=${step.args.action}`;
        assert.equal(step.value.active, state.active, `${label}: active`);
        assert.equal(step.value.topic, state.topic, `${label}: topic`);
        assert.equal(step.value.slug, state.slug, `${label}: slug`);
        assert.equal(step.value.stage, state.stage, `${label}: stage`);
        assert.equal(step.value.steps, state.steps, `${label}: steps`);
        assert.deepEqual(step.value.confirmed, state.confirmed, `${label}: confirmed`);
        assert.deepEqual(step.value.reviewed, state.reviewed, `${label}: reviewed`);
        assert.equal(step.value.done, allConfirmed(state.confirmed), `${label}: done`);
        if (state.active) assert.equal(step.value.phase, expectedPhase(state), `${label}: phase (§2)`);
      }

      // (c) Rejected calls must leave durable state untouched.
      assert.ok(s.parity.failures.length >= 2, 'expected rejected calls in the sequence');
      for (const step of s.parity.failures) {
        assert.deepEqual(foldView(step.before), foldView(step.after),
          `rejected action=${step.args.action} must not change durable state (§11)`);
      }

      // (d) The fold must mark altitude/depth progress like execute did.
      const finalState = s.stateOf();
      assert.equal(finalState.active, true);
      assert.equal(finalState.confirmed.altitude, false, 'revise(altitude) un-confirms the layer (§3.4)');
      assert.equal(finalState.reviewed.altitude, true, 'revise(altitude) keeps it reviewed (§3.4)');
      assert.equal(finalState.summaries.altitude, 'parity revised altitude', 'revise updates the summary (§3.4)');
      assert.equal(finalState.stage, 'depth', 'revisit(depth) sets the stage (§3.4)');
      assert.equal(finalState.reviewed.depth, false, 'revisit(depth) clears reviewed (§3.4)');
    } finally {
      s.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // 10. Projection wire view (§7)
  // -------------------------------------------------------------------------
  await test('projection wire view shape (§7)', async () => {
    const s = createScenario(plugin);
    try {
      s.openHumanTurn();
      const started = await s.execute({ action: 'start', topic: TOPIC, slug: SLUG });
      await s.execute({ action: 'record', summary: ALTITUDE_SUMMARY, surfaced: [ALTITUDE_SURFACED] });
      s.openHumanTurn();
      await s.execute({ action: 'confirm', userSaid: '确认' });

      const def = s.projection;
      assert.ok(def.wire !== undefined, 'projection.wire is required for the Client (§7)');
      const state = s.stateOf();
      const wire = def.wire.view(state);
      assert.ok(wire !== null && typeof wire === 'object', 'wire view must be an object');
      // §7 (amended): the wire view is pure over folded state, so it has no absolute
      // path — the absolute workspace only travels in the tool result's `exploreDir`.
      const required = ['active', 'topic', 'slug', 'stage', 'done', 'steps', 'confirmed', 'reviewed', 'summaries', 'ceilings'];
      const missing = required.filter((key) => !Object.hasOwn(wire, key));
      assert.deepEqual(missing, [], `wire view is missing §7 keys: ${missing.join(', ')}`);
      assert.equal(wire.active, state.active);
      assert.equal(wire.topic, state.topic);
      assert.equal(wire.slug, started.slug);
      assert.equal(wire.stage, state.stage);
      assert.equal(wire.steps, state.steps);
      assert.equal(wire.done, allConfirmed(state.confirmed));
      assert.deepEqual(wire.confirmed, state.confirmed);
      assert.deepEqual(wire.reviewed, state.reviewed);
      assert.deepEqual(wire.summaries, state.summaries);
      assert.deepEqual(wire.ceilings, state.ceilings);
    } finally {
      s.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // 11. /wish off lifecycle (§4.1)
  // -------------------------------------------------------------------------
  await test('command /wish off completes the plugin goal and closes the mode (§4.1)', async () => {
    const s = createScenario(plugin);
    try {
      await startAndConfirmAltitude(s, '命令退出测试');
      assert.equal(s.goalCalls('create').length, 1, 'depth goal active before /wish off');
      assert.equal(s.stateOf().active, true);
      const completesBefore = s.goalCalls('complete').length;

      const result = await s.runCommand('off');
      assert.ok(result === undefined || typeof result === 'object', 'command handler returns a command result');
      assert.ok(s.goalCalls('complete').length > completesBefore, '/wish off completes the plugin goal (§4.1)');
      assert.equal(s.stateOf().active, false, '/wish off closes the mode (§4.1)');
      assert.equal(s.section.text({ agent: s.agent }), '', 'policy disappears after /wish off (§9)');
    } finally {
      s.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // 12. revise / revisit semantics (§3.4)
  // -------------------------------------------------------------------------
  await test('revise/revisit: active-mode re-confirmation and budget reset (§3.4)', async () => {
    const s = createScenario(plugin);
    try {
      await startAndConfirmAltitude(s, '修订测试');
      assert.equal(s.stateOf().stage, 'depth');
      assert.equal(s.goalCalls('create').length, 1);

      // revise a confirmed layer while active: confirmed=false, reviewed=true.
      const revised = await s.execute({ action: 'revise', dimension: 'altitude', summary: '修订后的问题陈述' });
      assert.equal(revised.confirmed.altitude, false, 'revise un-confirms the layer (§3.4)');
      assert.equal(revised.reviewed.altitude, true, 'revise keeps the layer reviewed (§3.4)');
      assert.equal(s.stateOf().summaries.altitude, '修订后的问题陈述');
      assert.equal(revised.stage, 'depth', 'revise does not change the current stage');

      // revisit a layer: reset flags, complete the current goal, allow a fresh budget.
      const revisited = await s.execute({ action: 'revisit', dimension: 'altitude' });
      assert.equal(revisited.stage, 'altitude', 'revisit(altitude) returns to the conversation layer (§3.4)');
      assert.equal(s.stateOf().confirmed.altitude, false);
      assert.equal(s.stateOf().reviewed.altitude, false, 'revisit clears reviewed (§3.4)');
      assert.equal(revisited.goal, null, 'altitude has no goal (§3.5)');
      assert.ok(s.goalCalls('complete').length >= 1, 'revisit completes the current goal (§4.1)');
      assert.equal(s.goalCalls('create').length, 1, 'altitude revisit does not create a goal (§4.1)');

      // Confirming altitude again creates a fresh depth goal (budget reset).
      s.openHumanTurn();
      const confirmedAgain = await s.execute({ action: 'confirm', userSaid: '重新确认高度' });
      assert.equal(confirmedAgain.stage, 'depth');
      const creates = s.goalCalls('create');
      assert.equal(creates.length, 2, 'confirm(altitude) after revisit creates a fresh depth goal (§3.4/§4.1)');
      assert.ok(creates[1].request.objective.startsWith(`${GOAL_PREFIX}depth] `));
    } finally {
      s.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // 13. Human authority via an answered ask_user_question (§3.1, §5)
  // -------------------------------------------------------------------------
  await test('human authority: answered ask_user_question authorizes confirm (§3.1, §5)', async () => {
    const s = createScenario(plugin);
    try {
      s.openHumanTurn();
      await s.execute({ action: 'start', topic: TOPIC, slug: SLUG });
      await s.execute({ action: 'record', summary: ALTITUDE_SUMMARY, surfaced: [ALTITUDE_SURFACED] });

      // A model turn with NO user/message: only a successful structured answer.
      s.modelTurn();
      const boundary = s.session.turnBoundary.openTurnStartSeq;
      s.appendAskUserQuestion({ callId: 'ask-answered', answer: '用户作答：对，就是这个目标' });

      const confirmed = await s.execute({ action: 'confirm', userSaid: '对，就是这个目标' });
      assert.equal(confirmed.stage, 'depth', 'an answered ask_user_question must authorize confirm (§3.1)');
      assert.equal(confirmed.confirmed.altitude, true, 'confirm must be applied');
      const creates = s.goalCalls('create');
      assert.equal(creates.length, 1, 'confirm must create the next-stage goal (§4.1)');
      assert.ok(creates[0].request.objective.startsWith(`${GOAL_PREFIX}depth] `),
        'the created goal must be the depth goal (§4.2)');
      assert.equal(creates[0].request.maxGoalRounds, STAGE_ROUNDS.depth);

      const userMessagesInTurn = s.session.events.filter((event) => event.seq > boundary
        && event.type === 'user/message' && event.data?.source?.kind === 'user');
      assert.equal(userMessagesInTurn.length, 0, 'the authorizing turn must contain no user/message');
    } finally {
      s.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // 14. A timed-mode "pending":true answer is NOT human authority (§3.1)
  // -------------------------------------------------------------------------
  await test('human authority: timed-out ("pending":true) ask_user_question does NOT authorize confirm (§3.1)', async () => {
    const s = createScenario(plugin);
    try {
      s.openHumanTurn();
      await s.execute({ action: 'start', topic: TOPIC, slug: SLUG });
      await s.execute({ action: 'record', summary: ALTITUDE_SUMMARY, surfaced: [ALTITUDE_SURFACED] });

      s.modelTurn();
      s.appendAskUserQuestion({ callId: 'ask-timed-out', pending: true });

      const error = await s.expectError({ action: 'confirm', userSaid: '确认' });
      assert.match(textOf(error), /直接|用户/, 'a pending timeout must not authorize confirm (§3.1)');
      assert.equal(s.stateOf().stage, 'altitude', 'rejected confirm must not advance the stage');
      assert.equal(s.stateOf().confirmed.altitude, false, 'rejected confirm must not confirm the layer');
      assert.equal(s.goalCalls('create').length, 0, 'rejected confirm must not create a goal');
    } finally {
      s.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // 15. A failed ask_user_question is NOT human authority (§3.1)
  // -------------------------------------------------------------------------
  await test('human authority: failed ask_user_question does NOT authorize confirm (§3.1)', async () => {
    const s = createScenario(plugin);
    try {
      s.openHumanTurn();
      await s.execute({ action: 'start', topic: TOPIC, slug: SLUG });
      await s.execute({ action: 'record', summary: ALTITUDE_SUMMARY, surfaced: [ALTITUDE_SURFACED] });

      s.modelTurn();
      s.appendAskUserQuestion({ callId: 'ask-failed', failed: true });

      const error = await s.expectError({ action: 'confirm', userSaid: '确认' });
      assert.match(textOf(error), /直接|用户/, 'a failed ask must not authorize confirm (§3.1)');
      assert.equal(s.stateOf().stage, 'altitude', 'rejected confirm must not advance the stage');
      assert.equal(s.stateOf().confirmed.altitude, false, 'rejected confirm must not confirm the layer');
      assert.equal(s.goalCalls('create').length, 0, 'rejected confirm must not create a goal');
    } finally {
      s.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  const passed = results.filter((result) => result.ok).length;
  const failed = results.length - passed;
  console.log('');
  if (specDeviations.length > 0) {
    console.log('Accepted spec deviations in this harness:');
    for (const deviation of specDeviations) console.log(`  - ${deviation}`);
    console.log('');
  }
  console.log(`${passed} passed, ${failed} failed, ${results.length} total`);
  if (failed > 0) {
    console.log('Failed tests:');
    for (const result of results) if (!result.ok) console.log(`  - ${result.name}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('FATAL: harness crashed');
  console.error(indentError(error));
  process.exit(2);
});
