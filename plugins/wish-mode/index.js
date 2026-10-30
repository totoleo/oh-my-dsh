/**
 * 许愿模式（Wish Mode）—— Host half. v2.
 *
 * 四层阶梯，两种工作方式：
 *
 *   altitude 高度 — 纯对话：重新判断真正要解决什么问题（不挂 goal）
 *   depth    深度 — 自动探索：依据、方法、验证推到上限
 *   range    广度 — 自动探索：跨领域发散、创新，再收敛
 *   speed    速度 — 自动探索：不牺牲质量的前提下把执行效率推到上限
 *
 * v2 的骨架：
 * - 高度是对话层，模型自己决定是否用 ask_user_question；不自动迭代。
 * - 深度/广度/速度由**插件**创建并完成 goal（ctx.goals 服务直连），模型只通过
 *   wish_requirement 推进内容。goal 的 objective 由插件从高度结论 + 本层标尺生成。
 * - 每层结束必须经用户确认（confirm 校验当前回合存在直接人类消息）。
 * - 探索过程落盘到 <cwd>/wishes/<slug>/<stage>/：插件写 summary/meta/plan，
 *   模型写笔记、证据和实验产物。工具守卫把写入限制在该目录内。
 * - 状态折叠进 sessionProjections 单元 wish，resume/fork 可恢复。
 * - goal 状态不落投影：始终从 ctx.goals.get(agent) 实时读取（可另存为 goal 投影）。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Hard service dependencies. */
export const inject = ['tools', 'systemPrompt'];

const TOOL_NAME = 'wish_requirement';
const COMMAND_NAME = 'wish';
const PROJECTION_KEY = 'wish';
/** Bump when the folded state shape or fold semantics change. */
const STATE_VERSION = 8;

const STAGES = ['altitude', 'depth', 'range', 'speed'];
const EXPLORE_STAGES = ['depth', 'range', 'speed'];
const GOAL_PREFIX = '[wish-';
const WISHES_DIR = 'wishes';

const STAGE_LABEL = {
  altitude: '高度',
  depth: '深度',
  range: '广度',
  speed: '速度',
};

const STAGE_CORE = {
  altitude: '重新判断真正要解决什么问题',
  depth: '明确依据哪些材料、采用什么方法、如何验证结果',
  range: '扩大可以参与解决问题的领域、工具和方法',
  speed: '在前三者确定之后，再提高执行效率',
};

/** 高度层：盘问问题（v1 保留）。 */
const ALTITUDE_QUESTIONS = [
  '这件事要改变什么现状？为谁改变？',
  '你现在最确定的是什么？最犹豫、最没想清楚的是哪部分？',
  '到时候你怎么知道它成了？（用你自己的话描述就行）',
  '哪些是你不肯让步的，哪些可以换？这次明确不做什么？',
];

/**
 * 探索层的完整规格。这里是「最高成就」的唯一定义处：output 决定 record 的结构，
 * ceiling 决定 conclude 的验收线，intake 是第一轮取材问题，review 是 review 卡问题。
 * STAGE_GATE 的阈值必须与 output 中的数字一致。
 */
const STAGE_SPEC = {
  depth: {
    rounds: 30,
    intake: [
      '你手上有哪些一手材料、数据、文档或当事人原话？分别在哪里？',
      '这件事过去试过什么？结果如何、为什么没成？',
      '有没有必须遵守的硬约束、验收标准或可参照的对象？',
    ],
    output:
      'findings（≥4，每条「结论 ← 来源/证据 · 如何验证」）；assumptions（≥2，每条「假设 → 验证方式 → 已执行的结果」）；methods（≥3，每条「研究/验证方法 → 适用性与代价 → 为什么选或不选」；写怎么查、用什么数据、做什么实验，不写解决方案）；acceptance（可量化的验收标准）；falsifiers（≥1，「什么证据会推翻本层结论」）。',
    ceiling:
      '每条关键结论可追溯到来源；关键假设的廉价验证已执行并留下结果；≥3 个研究/验证方法被认真比较；验收标准可量化；明确写出推翻条件。以「该领域专家也挑不出明显漏洞」为验收线。',
    review: [
      '这几条关键假设你是否认可？有没有你确定但没告诉我的？',
      '验收标准的阈值对不对？高了还是低了？',
      '还有哪类材料/数据你手上有，但我没拿到？',
    ],
  },
  range: {
    rounds: 24,
    intake: [
      '你和身边人已经试过哪些做法？结果如何？',
      '有没有行业外让你觉得「也许可以」的类比？',
      '预算、风险偏好、可接受的试错成本大概是什么量级？',
    ],
    output:
      'options（≥8，每条「名称 · 领域/载体 · 机制 · 现实先例 · 预期提升 · 成本/风险」）；domains（≥4 个不同领域/载体）；novel（≥2 条反直觉或跨领域的新思路）；shortlist（2–3 个候选 + 推荐 + 什么情况下改推荐）；exclusions（≥2 条明确排除 + 理由）。',
    ceiling:
      '选项覆盖 ≥4 个领域且不是同一做法的变体；每条都有真实先例而不是想象；至少 2 条是用户自己想不到的新思路；收敛出 2–3 个可执行候选，并说明推荐与改推荐条件。',
    review: [
      '哪几个新思路值得继续深挖？',
      '排除项里有没有你其实想保留的？',
      '推荐的候选和你的直觉冲突吗？',
    ],
  },
  speed: {
    rounds: 16,
    intake: [
      '你能投入多少时间、人力和预算？',
      '最早什么时候能看到第一刀的结果？',
      '过程中哪些外部依赖可能会卡住你？',
    ],
    output:
      'slice（最小可验证切片 + 预计时间 + 它证明什么）；tracks（≥2 条可并行/可委派的工作）；dependencies（关键路径与依赖顺序）；loop（当前反馈回路多长 + 怎么缩短）；scenarios（base/upside/fallback + 概率 + 触发条件）；checkpoints（≥2 个 go/no-go 检查点）。',
    ceiling:
      '第一刀尽量小、尽量早地验证方向；关键路径明确、可并行项已拆出；失败有 fallback 与触发条件；深度/广度已固化的质量要求没有被牺牲。效率提升必须来自路径与并行，不是砍质量。',
    review: [
      '这个切片够不够小？能不能再砍一半？',
      '概率和触发条件你认可吗？',
      '哪个检查点一旦不过，你会直接停？',
    ],
  },
};

/** conclude 门禁：与 STAGE_SPEC.output 里的数字保持一致。 */
const STAGE_GATE = {
  depth: [
    { field: 'findings', min: 4, label: 'findings（结论 ← 来源/证据）' },
    { field: 'assumptions', min: 2, label: 'assumptions（假设 → 验证方式 → 结果）' },
    { field: 'methods', min: 3, label: 'methods（研究/验证方法 → 取舍 → 为什么选/不选）' },
    { field: 'acceptance', text: true, label: 'acceptance（可量化验收标准）' },
    { field: 'falsifiers', min: 1, label: 'falsifiers（什么证据会推翻本层）' },
  ],
  range: [
    { field: 'options', min: 8, label: 'options（载体/领域 · 机制 · 先例 · 提升 · 成本）' },
    { field: 'domains', min: 4, label: 'domains（不同领域/载体）' },
    { field: 'novel', min: 2, label: 'novel（反直觉/跨领域新思路）' },
    { field: 'shortlist', min: 2, label: 'shortlist（收敛候选 + 改推荐条件）' },
    { field: 'exclusions', min: 2, label: 'exclusions（明确排除 + 理由）' },
  ],
  speed: [
    { field: 'slice', text: true, label: 'slice（最小可验证切片）' },
    { field: 'tracks', min: 2, label: 'tracks（并行/委派工作）' },
    { field: 'dependencies', min: 1, label: 'dependencies（关键路径）' },
    { field: 'loop', text: true, label: 'loop（反馈回路与缩短手段）' },
    { field: 'scenarios', text: true, label: 'scenarios（base/upside/fallback）' },
    { field: 'checkpoints', min: 2, label: 'checkpoints（go/no-go 检查点）' },
  ],
};

/** 每层可记录的字段分类。数组字段并集去重，标量字段覆盖。 */
const FIELD_SPEC = {
  altitude: {
    lists: ['fixed', 'open', 'declined', 'materials', 'surfaced'],
    texts: ['success', 'notDoing', 'rationale'],
  },
  depth: {
    lists: ['findings', 'assumptions', 'methods', 'falsifiers'],
    texts: ['acceptance'],
  },
  range: {
    lists: ['options', 'domains', 'novel', 'shortlist', 'exclusions'],
    texts: [],
  },
  speed: {
    lists: ['tracks', 'dependencies', 'checkpoints'],
    texts: ['slice', 'loop', 'scenarios'],
  },
};

/** 落盘时每层字段的标题。 */
const FIELD_RENDER = {
  altitude: [
    { key: 'success', title: '成功判据' },
    { key: 'notDoing', title: '明确不做' },
    { key: 'fixed', title: '固定约束' },
    { key: 'open', title: '可调整项' },
    { key: 'materials', title: '已有材料线索' },
    { key: 'surfaced', title: '这次谈出来的' },
    { key: 'declined', title: '用户拒绝回答' },
    { key: 'rationale', title: '判断依据与改判条件' },
  ],
  depth: [
    { key: 'findings', title: '发现与证据' },
    { key: 'assumptions', title: '关键假设' },
    { key: 'methods', title: '方法比较' },
    { key: 'acceptance', title: '验收标准' },
    { key: 'falsifiers', title: '推翻条件' },
  ],
  range: [
    { key: 'options', title: '候选选项' },
    { key: 'domains', title: '覆盖领域' },
    { key: 'novel', title: '新思路' },
    { key: 'shortlist', title: '收敛候选' },
    { key: 'exclusions', title: '明确排除' },
  ],
  speed: [
    { key: 'slice', title: '最小可验证切片' },
    { key: 'tracks', title: '并行与委派' },
    { key: 'dependencies', title: '依赖与关键路径' },
    { key: 'loop', title: '反馈回路' },
    { key: 'scenarios', title: '可靠性情景' },
    { key: 'checkpoints', title: '检查点' },
  ],
};

const ACTIONS = ['start', 'status', 'record', 'conclude', 'confirm', 'revise', 'revisit', 'close'];

const PHASES = ['idle', 'talking', 'exploring', 'reviewing', 'blocked', 'paused', 'confirmed'];

/** Tools that may mutate user files; only allowed under the explore directory. */
const FILE_WRITE_TOOLS = new Set(['write', 'edit']);
/** Tools that would escape the file boundary; refused while the mode is active. */
const SPAWN_TOOLS = new Set(['subagent', 'subagent_fork', 'workflow', 'ralph', 'spawn_teammate']);
/** Tools whose goal ownership belongs to this plugin. */
const GOAL_TOOLS = new Set(['create_goal', 'update_goal']);
/** Shell commands that can destroy state outside the explore directory. */
const DANGEROUS_COMMAND = /\brm\s+-[a-z]*[rf]|\bgit\s+(push|commit|reset|clean|checkout|revert)\b|Remove-Item\s+[^|]*-Recurse|\b(del|rd)\s+\/[sq]/i;

/** Identity schema: the fold is the validator, and state is plain JSON. */
const PASSTHROUGH = Object.freeze({ parse: (value) => value });

/** Cache `wire.view` results per immutable state object so unrelated events stay silent. */
const viewCache = new WeakMap();

/** A fresh, fully inactive state. */
function freshState() {
  return {
    active: false,
    topic: '',
    slug: '',
    stage: 'altitude',
    confirmed: { altitude: false, depth: false, range: false, speed: false },
    reviewed: { altitude: false, depth: false, range: false, speed: false },
    skipped: { altitude: false, depth: false, range: false, speed: false },
    revised: { altitude: false, depth: false, range: false, speed: false },
    summaries: { altitude: '', depth: '', range: '', speed: '' },
    ceilings: { altitude: '', depth: '', range: '', speed: '' },
    fields: {
      altitude: { fixed: [], open: [], declined: [], materials: [], surfaced: [], success: '', notDoing: '', rationale: '' },
      depth: { findings: [], assumptions: [], methods: [], acceptance: '', falsifiers: [] },
      range: { options: [], domains: [], novel: [], shortlist: [], exclusions: [] },
      speed: { slice: '', tracks: [], dependencies: [], loop: '', scenarios: '', checkpoints: [] },
    },
    steps: 0,
    running: null,
    pending: {},
  };
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function isStage(value) {
  return typeof value === 'string' && STAGES.includes(value);
}

function isExploreStage(value) {
  return typeof value === 'string' && EXPLORE_STAGES.includes(value);
}

function nextStage(stage) {
  const index = STAGES.indexOf(stage);
  return index >= 0 && index < STAGES.length - 1 ? STAGES[index + 1] : stage;
}

function allConfirmed(state) {
  return STAGES.every((stage) => state.confirmed[stage] === true);
}

function cleanText(value, max = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Sanitize a string list from model input or a logged argument. */
function cleanList(value, maxItems = 40, maxLength = 500) {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim().slice(0, maxLength);
    if (text === '' || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** Merge without duplicates, preserving existing order then new items. */
function unionLists(current, incoming) {
  if (!Array.isArray(incoming)) return current;
  const out = Array.isArray(current) ? [...current] : [];
  for (const item of incoming) if (!out.includes(item)) out.push(item);
  return out;
}

/** 自动目录名：wish-<8 位十六进制>。主题不变则稳定，可被模型给的 slug 替换。 */
function autoSlug(topic) {
  let hash = 0x811c9dc5;
  const text = String(topic ?? '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `wish-${hash.toString(16).padStart(8, '0')}`;
}

/** 目录名还没被正式命名时的形态。 */
const AUTO_SLUG = /^wish-[0-9a-f]{8}$/;

/** 目录名：3–5 个简短英文单词，小写，用 `-` 连接。不合法返回 ''。 */
function cleanSlug(raw) {
  if (typeof raw !== 'string') return '';
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  if (slug === '') return '';
  const words = slug.split('-').filter((word) => word !== '');
  if (words.length < 3 || words.length > 5) return '';
  if (words.some((word) => word.length > 16)) return '';
  return words.join('-');
}

/** 失效某一层之后的全部确认（用于 revisit / revise）。 */
function invalidateAfter(state, dimension) {
  const index = STAGES.indexOf(dimension);
  if (index < 0 || index === STAGES.length - 1) return state;
  const confirmed = { ...state.confirmed };
  const reviewed = { ...state.reviewed };
  const skipped = { ...state.skipped };
  for (const stage of STAGES.slice(index + 1)) {
    confirmed[stage] = false;
    reviewed[stage] = false;
    skipped[stage] = false;
  }
  return { ...state, confirmed, reviewed, skipped };
}

/** 把一格 record/conclude/revise 的字段并进状态。纯函数，无变化时返回原引用。 */
function mergeFields(state, dimension, op) {
  const spec = FIELD_SPEC[dimension];
  if (spec === undefined) return state;
  const current = state.fields[dimension];
  const fields = { ...current };
  let changed = false;
  for (const key of spec.lists) {
    const list = cleanList(op[key]);
    if (list === undefined) continue;
    fields[key] = unionLists(current[key], list);
    changed = true;
  }
  for (const key of spec.texts) {
    const text = cleanText(op[key], 6000);
    if (text === '') continue;
    fields[key] = text;
    changed = true;
  }
  const summary = cleanText(op.summary);
  const ceiling = cleanText(op.ceiling, 3000);
  if (!changed && summary === '' && ceiling === '') return state;
  return {
    ...state,
    fields: { ...state.fields, [dimension]: fields },
    summaries: summary === '' ? state.summaries : { ...state.summaries, [dimension]: summary },
    ceilings: ceiling === '' ? state.ceilings : { ...state.ceilings, [dimension]: ceiling },
  };
}

/** Whether the op carries any stage-specific field. */
function hasAnyField(dimension, op) {
  const spec = FIELD_SPEC[dimension];
  if (spec === undefined) return false;
  return (
    spec.lists.some((key) => Array.isArray(op[key]) && op[key].length > 0)
    || spec.texts.some((key) => typeof op[key] === 'string' && op[key].trim() !== '')
  );
}

/** Gate 缺项（含 ceiling）。按顺序列出可执行的补齐提示。 */
function missingItems(state, stage) {
  const gates = STAGE_GATE[stage] ?? [];
  const fields = state.fields[stage] ?? {};
  const out = [];
  for (const gate of gates) {
    const value = fields[gate.field];
    if (gate.text === true) {
      if (typeof value !== 'string' || value.trim() === '') out.push(`还缺 ${gate.label}`);
      continue;
    }
    const count = Array.isArray(value) ? value.length : 0;
    if (count < gate.min) out.push(`还缺 ${gate.min - count} 条 ${gate.label}`);
  }
  if (cleanText(state.ceilings[stage]) === '') out.push('还缺 ceiling（为什么这已是本层上限、哪些做不到）');
  return out;
}

/** Fold one committed operation into the state. Pure; same reference when nothing changes. */
function reduce(state, op) {
  switch (op.action) {
    case 'start': {
      const topic = cleanText(op.topic, 200);
      const given = cleanSlug(op.slug);
      // /wish <原话> 是一轮新许愿的入口：换主题即重开，同主题则保留进度。
      if (state.active && (topic === '' || topic === state.topic)) {
        // 目录名还是自动名时，允许模型补一个正式名；已经正式命名就不再改。
        if (given !== '' && AUTO_SLUG.test(state.slug)) {
          return { ...state, slug: given, steps: state.steps + 1 };
        }
        return state;
      }
      return {
        ...freshState(),
        active: true,
        topic,
        slug: given !== '' ? given : autoSlug(topic),
        steps: 1,
      };
    }
    case 'record': {
      if (!state.active) return state;
      const dimension = isStage(op.dimension) ? op.dimension : state.stage;
      if (dimension !== state.stage) return state;
      const merged = mergeFields(state, dimension, op);
      if (merged === state) return state;
      return { ...merged, steps: merged.steps + 1 };
    }
    case 'conclude': {
      if (!state.active) return state;
      const dimension = isStage(op.dimension) ? op.dimension : state.stage;
      if (dimension !== state.stage || dimension === 'altitude') return state;
      const merged = mergeFields(state, dimension, op);
      return {
        ...merged,
        reviewed: { ...merged.reviewed, [dimension]: true },
        steps: merged.steps + 1,
      };
    }
    case 'confirm': {
      if (!state.active) return state;
      const dimension = isStage(op.dimension) ? op.dimension : state.stage;
      if (dimension !== state.stage) return state;
      const merged = mergeFields(state, dimension, op);
      const base = {
        ...merged,
        skipped: op.skip_explore === true ? { ...merged.skipped, [dimension]: true } : merged.skipped,
        confirmed: { ...merged.confirmed, [dimension]: true },
        reviewed: { ...merged.reviewed, [dimension]: true },
        steps: merged.steps + 1,
      };
      return dimension === 'speed' ? base : { ...base, stage: nextStage(dimension) };
    }
    case 'revise': {
      const dimension = op.dimension;
      if (!isStage(dimension)) return state;
      const merged = mergeFields(state, dimension, op);
      const next = {
        ...merged,
        revised: { ...merged.revised, [dimension]: true },
        steps: merged.steps + 1,
      };
      // close 之后的修订只改内容，不动关闭状态。
      if (!state.active) return next;
      return invalidateAfter(
        { ...next, confirmed: { ...next.confirmed, [dimension]: false }, reviewed: { ...next.reviewed, [dimension]: true } },
        dimension,
      );
    }
    case 'revisit': {
      if (!state.active || !isStage(op.dimension)) return state;
      const dimension = op.dimension;
      return invalidateAfter(
        {
          ...state,
          stage: dimension,
          confirmed: { ...state.confirmed, [dimension]: false },
          reviewed: { ...state.reviewed, [dimension]: false },
          skipped: { ...state.skipped, [dimension]: false },
          steps: state.steps + 1,
        },
        dimension,
      );
    }
    case 'close': {
      // 命令驱动的 close 带 force；模型 close 必须显式声明四层一致。
      if (!state.active) return state;
      if (op.force !== true && op.consistency !== true) return state;
      return { ...state, active: false, steps: state.steps + 1 };
    }
    default:
      return state;
  }
}

const LIST_FIELDS = [
  'fixed', 'open', 'declined', 'materials', 'surfaced',
  'findings', 'assumptions', 'methods', 'falsifiers',
  'options', 'domains', 'novel', 'shortlist', 'exclusions',
  'tracks', 'dependencies', 'checkpoints',
];

const TEXT_FIELDS = ['success', 'notDoing', 'rationale', 'acceptance', 'slice', 'loop', 'scenarios'];

/** Parse one logged tool-call argument string into an operation, or undefined. */
function parseOperation(raw) {
  if (typeof raw !== 'string') return undefined;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  if (!ACTIONS.includes(parsed.action)) return undefined;
  const op = { action: parsed.action };
  if (typeof parsed.topic === 'string') op.topic = parsed.topic;
  if (typeof parsed.slug === 'string') op.slug = parsed.slug;
  if (typeof parsed.dimension === 'string' && STAGES.includes(parsed.dimension)) op.dimension = parsed.dimension;
  if (typeof parsed.summary === 'string') op.summary = parsed.summary;
  if (typeof parsed.ceiling === 'string') op.ceiling = parsed.ceiling;
  if (parsed.skip_explore === true) op.skip_explore = true;
  if (parsed.consistency === true) op.consistency = true;
  for (const key of LIST_FIELDS) {
    const list = cleanList(parsed[key]);
    if (list !== undefined) op[key] = list;
  }
  for (const key of TEXT_FIELDS) {
    if (typeof parsed[key] === 'string') op[key] = parsed[key];
  }
  return op;
}

/** Pure replay of the session log. */
function fold(state, event) {
  if (state === undefined || state === null) return freshState();
  if (event.type === 'command/run' && event.data && event.data.name === COMMAND_NAME) {
    const text = typeof event.data.args === 'string' ? event.data.args.trim() : '';
    const raw = text.toLowerCase();
    // `/wish <原话>`：非 on/off 的文本都当作这一轮要许愿的原话（主题）。
    const topic = text !== '' && raw !== 'on' && raw !== 'off' ? text : undefined;
    const want = raw === 'off' ? false : raw === 'on' ? true : topic !== undefined ? true : !state.active;
    return { ...state, running: { id: event.data.commandId, want, topic } };
  }
  if (event.type === 'command/done' && state.running !== null && event.data && event.data.commandId === state.running.id) {
    const { want, topic } = state.running;
    const settled = { ...state, running: null };
    if (event.data.kind !== 'success') return settled;
    if (topic !== undefined) {
      // 同一主题已在许愿中：保留进度，只清掉 running。
      if (state.active && state.topic === topic) return settled;
      return reduce(settled, { action: 'start', topic });
    }
    if (want === state.active) return settled;
    return reduce(settled, want ? { action: 'start' } : { action: 'close', force: true });
  }
  if (event.type === 'tool/call' && event.data && event.data.name === TOOL_NAME) {
    const op = parseOperation(event.data.arguments);
    if (op === undefined) return state;
    return { ...state, pending: { ...state.pending, [event.data.callId]: op } };
  }
  if (event.type === 'tool/result' && event.data && event.data.message && event.data.message.source) {
    const callId = event.data.message.source.callId;
    if (typeof callId !== 'string' || state.pending[callId] === undefined) return state;
    const op = state.pending[callId];
    const pending = { ...state.pending };
    delete pending[callId];
    const failed = event.data.error !== undefined
      || (event.data.message !== undefined && event.data.message !== null && event.data.message.isError === true);
    if (failed) return { ...state, pending };
    const meta = event.data.meta && typeof event.data.meta === 'object' ? event.data.meta.wish : undefined;
    if (op.action === 'close') {
      const closed = meta !== undefined
        ? meta.closed === true
        : resultTextOf(event.data.message).includes('许愿模式已关闭');
      return reduce({ ...state, pending }, { action: 'close', force: closed });
    }
    const next = reduce({ ...state, pending }, op);
    if (meta === undefined || meta === null || typeof meta !== 'object') return next;
    return {
      ...next,
      active: meta.active === true,
      stage: isStage(meta.stage) ? meta.stage : next.stage,
      steps: Number.isInteger(meta.steps) ? meta.steps : next.steps,
      reviewed: meta.reviewed && typeof meta.reviewed === 'object'
        ? {
            altitude: meta.reviewed.altitude === true,
            depth: meta.reviewed.depth === true,
            range: meta.reviewed.range === true,
            speed: meta.reviewed.speed === true,
          }
        : next.reviewed,
    };
  }
  return state;
}

/** Concatenate the text blocks of a rendered tool result (migration fallback). */
function resultTextOf(message) {
  if (!message || !Array.isArray(message.content)) return '';
  let out = '';
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += block.text + '\n';
  }
  return out;
}

/** The stable Client view: only what the composer controls render. */
function viewOf(state) {
  let view = viewCache.get(state);
  if (view === undefined) {
    view = {
      active: state.active === true,
      stage: isStage(state.stage) ? state.stage : 'altitude',
      topic: typeof state.topic === 'string' ? state.topic : '',
      slug: typeof state.slug === 'string' ? state.slug : '',
      confirmed: {
        altitude: state.confirmed.altitude === true,
        depth: state.confirmed.depth === true,
        range: state.confirmed.range === true,
        speed: state.confirmed.speed === true,
      },
      reviewed: {
        altitude: state.reviewed.altitude === true,
        depth: state.reviewed.depth === true,
        range: state.reviewed.range === true,
        speed: state.reviewed.speed === true,
      },
      summaries: {
        altitude: state.summaries.altitude,
        depth: state.summaries.depth,
        range: state.summaries.range,
        speed: state.summaries.speed,
      },
      ceilings: {
        altitude: state.ceilings.altitude,
        depth: state.ceilings.depth,
        range: state.ceilings.range,
        speed: state.ceilings.speed,
      },
      done: allConfirmed(state),
      steps: state.steps,
    };
    viewCache.set(state, view);
  }
  return view;
}

// ---------------------------------------------------------------------------
// Goal orchestration
// ---------------------------------------------------------------------------

function goalsOf(ctx) {
  try {
    return ctx.get('goals');
  } catch {
    return undefined;
  }
}

function liveGoalOf(ctx, agent) {
  const goals = goalsOf(ctx);
  if (goals === undefined || agent === undefined || agent === null) return undefined;
  try {
    return goals.get(agent);
  } catch {
    return undefined;
  }
}

function isOurGoal(goal) {
  return goal !== undefined && goal !== null
    && typeof goal.objective === 'string'
    && goal.objective.startsWith(GOAL_PREFIX);
}

function goalStageOf(goal) {
  if (!isOurGoal(goal)) return undefined;
  const match = /^\[wish-(altitude|depth|range|speed)\]/.exec(goal.objective);
  return match === null ? undefined : match[1];
}

/** 本插件当前 goal 的视图（只返回属于当前层的）。 */
function goalInfoOf(ctx, agent, stage) {
  const goal = liveGoalOf(ctx, agent);
  if (!isOurGoal(goal) || goalStageOf(goal) !== stage) return null;
  return {
    phase: goal.phase,
    roundsStarted: goal.roundsStarted,
    maxGoalRounds: goal.maxGoalRounds,
    ...(goal.blockedReason === undefined ? {} : { blockReason: goal.blockedReason.message }),
  };
}

/** 结束属于本插件的 goal；返回一条可展示的警告（没有则空串）。 */
function settleOwnGoal(ctx, agent) {
  const goals = goalsOf(ctx);
  const goal = liveGoalOf(ctx, agent);
  if (goals === undefined || !isOurGoal(goal) || goal.phase === 'complete') return '';
  try {
    goals.complete(agent, { id: goal.id, revision: goal.revision });
    return '';
  } catch (error) {
    return `结束本插件的 goal 失败：${messageOf(error)}`;
  }
}

/** 为某一层创建 goal；失败或冲突时返回降级警告，模式照常交互式工作。 */
function createStageGoal(ctx, agent, state, stage) {
  if (!isExploreStage(stage)) return { warn: '' };
  const goals = goalsOf(ctx);
  if (goals === undefined) return { warn: '当前环境没有 goal 服务：本层以交互方式推进。' };
  const current = liveGoalOf(ctx, agent);
  if (current !== undefined && current.phase !== 'complete') {
    if (!isOurGoal(current)) {
      return {
        warn: '当前会话已有其他 goal：本层以交互方式推进，不自动迭代（先完成或清理那个 goal，再 revisit 本层可恢复自动探索）。',
      };
    }
    try {
      goals.complete(agent, { id: current.id, revision: current.revision });
    } catch (error) {
      return { warn: `无法结束上一层的 goal（${messageOf(error)}）：本层以交互方式推进。` };
    }
  }
  try {
    const objective = buildStageObjective(ctx, agent, state, stage);
    goals.create(agent, { objective, maxGoalRounds: STAGE_SPEC[stage].rounds });
    return { warn: '' };
  } catch (error) {
    return { warn: `无法创建本层 goal（${messageOf(error)}）：本层以交互方式推进。` };
  }
}

/** goal objective：高度结论 + 本层标尺 + 工作区与纪律。模型不能自己写。 */
function buildStageObjective(ctx, agent, state, stage) {
  const spec = STAGE_SPEC[stage];
  const altitude = state.fields.altitude;
  const exploreDir = exploreDirOf(state, ctx, agent);
  const stageDir = exploreDir === '' ? '' : path.join(exploreDir, stage);
  const topic = state.topic !== '' ? state.topic : state.summaries.altitude !== '' ? state.summaries.altitude : '未命名需求';
  const topicLine = topic.replace(/\n/g, ' ').slice(0, 120);
  return [
    `${GOAL_PREFIX}${stage}] 「${topicLine}」把「${STAGE_LABEL[stage]}」推到上限。`,
    '',
    `问题陈述：${state.summaries.altitude || '（高度层未记录）'}`,
    `成功判据：${altitude.success || '（未记录）'}`,
    `明确不做：${altitude.notDoing || '（未记录）'}`,
    `固定约束：${altitude.fixed.length > 0 ? altitude.fixed.join('；') : '（未记录）'}`,
    '',
    `本层产出（record 时按此结构）：${spec.output}`,
    `上限（conclude 判据）：${spec.ceiling}`,
    `工作区：${stageDir === '' ? '（尚未创建）' : stageDir} —— 笔记、证据、实验都放这里，不要修改该目录之外的任何文件。`,
    '',
    '纪律：每轮结束前用 wish_requirement(action=record) 落盘进展；需要用户输入时用 ask_user_question（阻塞等待），不要用散文提问结束回合；边际收益为零就调用 wish_requirement(action=conclude) 并给出 ceiling。不要调用 create_goal / update_goal；不要开始实现。',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Filesystem workspace
// ---------------------------------------------------------------------------

function cwdOf(ctx, session) {
  try {
    const workingDirectory = ctx.get('workingDirectory');
    if (workingDirectory !== undefined && workingDirectory !== null && typeof workingDirectory.get === 'function') {
      const dir = workingDirectory.get(session);
      if (typeof dir === 'string' && dir !== '') return dir;
    }
  } catch {
    /* fall through */
  }
  try {
    const projections = ctx.get('sessionProjections');
    if (projections !== undefined && projections !== null && typeof projections.stateOf === 'function') {
      const dir = projections.stateOf(session, 'workingDirectory');
      if (typeof dir === 'string' && dir !== '') return dir;
    }
  } catch {
    /* fall through */
  }
  const headerCwd = session !== undefined && session !== null && session.header !== undefined
    ? session.header.cwd
    : undefined;
  if (typeof headerCwd === 'string' && headerCwd !== '') return headerCwd;
  return process.cwd();
}

function exploreRootOf(ctx, session) {
  return path.join(cwdOf(ctx, session), WISHES_DIR);
}

function exploreDirOf(state, ctx, agent) {
  if (state.slug === '') return '';
  return path.join(exploreRootOf(ctx, agent.session), state.slug);
}

function stageDirOf(state, ctx, agent) {
  const dir = exploreDirOf(state, ctx, agent);
  return dir === '' ? '' : path.join(dir, state.stage);
}

function isInside(root, target) {
  const normalize = process.platform === 'win32' ? (value) => value.toLowerCase() : (value) => value;
  const base = normalize(path.resolve(root)).replace(/[\\/]+$/, '');
  const resolved = normalize(path.resolve(target));
  return resolved === base || resolved.startsWith(base + path.sep.toLowerCase());
}

async function writeTextFile(dir, name, content) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), content, 'utf8');
}

/** 写入失败绝不抛错：返回一行警告，模式继续。 */
async function guardedWrite(dir, name, content) {
  if (dir === '') return '探索目录尚未创建（主题为空）：本次未写文件。';
  try {
    await writeTextFile(dir, name, content);
    return '';
  } catch (error) {
    return `写文件失败（${path.join(dir, name)}）：${messageOf(error)}`;
  }
}

function renderStageMarkdown(state, stage) {
  const lines = [`# ${STAGE_LABEL[stage]}`, ''];
  if (state.topic !== '') lines.push(`> 主题：${state.topic}`, '');
  lines.push(state.summaries[stage] || '（未记录）');
  if (state.ceilings[stage] !== '') lines.push('', '## 上限判断', '', state.ceilings[stage]);
  const fields = state.fields[stage] ?? {};
  for (const { key, title } of FIELD_RENDER[stage] ?? []) {
    const value = fields[key];
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push('', `## ${title}`, ...value.map((item) => `- ${item}`));
      continue;
    }
    if (typeof value === 'string' && value !== '') lines.push('', `## ${title}`, value);
  }
  if (state.skipped[stage]) lines.push('', '> 本层自动探索被用户跳过。');
  if (state.revised[stage]) lines.push('', '> 本层结论经过修订。');
  const status = state.confirmed[stage] ? '已确认' : state.reviewed[stage] ? '待确认' : '未确认';
  lines.push('', `> 状态：${status}`, '');
  return lines.join('\n');
}

function buildPlan(state) {
  const lines = [`# 许愿方案${state.topic === '' ? '' : `：${state.topic}`}`, ''];
  lines.push(stateLine(state, null), '');
  lines.push(`进度：${progressLine(state)}`, '');
  for (const stage of STAGES) {
    lines.push(...renderStageMarkdown(state, stage).split('\n'), '');
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

function checklistText(state) {
  const lines = ['### 关闭前核对（尚未关闭）', ''];
  lines.push(stateLine(state, null), '');
  lines.push(`**进度**：${progressLine(state)}`, '');
  lines.push('**四层摘要**：');
  for (const stage of STAGES) {
    const status = state.confirmed[stage] ? '✓' : state.reviewed[stage] ? '待确认' : '未完成';
    lines.push(`- **${STAGE_LABEL[stage]}**（${status}）：${state.summaries[stage] || '未记录'}`);
  }
  const pending = STAGES.filter((stage) => state.confirmed[stage] !== true);
  if (pending.length > 0) {
    lines.push('', `**尚未确认**：${pending.map((stage) => STAGE_LABEL[stage]).join('、')}。先逐层 confirm，再关闭。`);
  }
  const skipped = STAGES.filter((stage) => state.skipped[stage]);
  if (skipped.length > 0) lines.push('', `**跳过自动探索**：${skipped.map((stage) => STAGE_LABEL[stage]).join('、')}`);
  lines.push(
    '',
    '核对规则：后层结论削弱了已确认层（例如固定约束被放宽）时，先 `revise` 对应层并重新确认；没有冲突就直接带 `consistency=true` 再调用一次 `close`。',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function phaseOf(state) {
  if (state.active !== true) return 'idle';
  const stage = state.stage;
  if (state.confirmed[stage] === true) return 'confirmed';
  if (state.reviewed[stage] === true) return 'reviewing';
  if (stage === 'altitude') return 'talking';
  return 'exploring';
}

function effectivePhase(state, goalInfo) {
  const base = phaseOf(state);
  if (base === 'exploring' && goalInfo !== null && goalInfo !== undefined) {
    if (goalInfo.phase === 'blocked') return 'blocked';
    if (goalInfo.phase === 'paused') return 'paused';
  }
  return base;
}

function progressLine(state) {
  return STAGES.map((stage) => {
    if (state.confirmed[stage]) return `${STAGE_LABEL[stage]} ✓`;
    if (state.reviewed[stage]) return `${STAGE_LABEL[stage]} …`;
    if (state.active && state.stage === stage) return `${STAGE_LABEL[stage]} ●`;
    return `${STAGE_LABEL[stage]} ○`;
  }).join(' ｜ ');
}

function stateLine(state, goalInfo) {
  const confirmed = STAGES.filter((stage) => state.confirmed[stage]).map((stage) => STAGE_LABEL[stage]);
  const goalPart = goalInfo === null || goalInfo === undefined
    ? ''
    : ` · goal=${goalInfo.phase} 第 ${goalInfo.roundsStarted}/${goalInfo.maxGoalRounds} 轮`;
  return `状态：${state.active ? 'active' : 'closed'} · stage=${state.stage} · phase=${effectivePhase(state, goalInfo)}${goalPart} · done=${allConfirmed(state)} · 已确认=${confirmed.join(',') || '无'} · 步数=${state.steps}`;
}

function summariesBlock(state) {
  return STAGES.map((stage) => {
    const revised = state.revised[stage] ? '（已修订）' : '';
    const status = state.confirmed[stage] ? '✓' : state.reviewed[stage] ? '待确认' : '未完成';
    return `- **${STAGE_LABEL[stage]}**（${status}）${revised}：${state.summaries[stage] || '未记录'}`;
  });
}

function listBlock(title, items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  return ['', `**${title}**：`, ...items.map((item) => `- ${item}`)];
}

function questionsFor(state, goalInfo) {
  if (state.active !== true || state.confirmed[state.stage] === true) return [];
  if (state.stage === 'altitude') return [...ALTITUDE_QUESTIONS];
  if (state.reviewed[state.stage] === true) return [...(STAGE_SPEC[state.stage]?.review ?? [])];
  if (effectivePhase(state, goalInfo) === 'blocked' || effectivePhase(state, goalInfo) === 'paused') {
    return ['先把当前进展 record 落盘', '告诉用户可以用 revisit 追加预算，或直接确认当前结果'];
  }
  return missingItems(state, state.stage);
}

/** 启发式：以动作动词开头、且没有结果标记的 summary，大概率是任务句。 */
function looksLikeTask(summary) {
  const text = String(summary ?? '').trim();
  if (text === '') return false;
  if (!/^(做|写|开发|实现|搭建|设计|加|上线|重构|优化|改)/.test(text)) return false;
  return !/(让|使|变成|降到|升到|达到|减少|提高|缩短|提升)/.test(text);
}

/** 高度层的回述卡：由字段拼出来，模型原样发给用户，请他逐条确认或纠正。 */
function recapText(state) {
  const fields = state.fields.altitude;
  const list = (items) => (items.length > 0 ? items.join('；') : '（未定）');
  const text = (value) => (value !== '' ? value : '（未定）');
  const missing = [];
  if (state.summaries.altitude === '') missing.push('结果');
  if (fields.success === '') missing.push('怎么算成');
  if (fields.fixed.length === 0) missing.push('不让步');
  if (fields.notDoing === '') missing.push('明确不做');
  if (fields.declined.length > 0) missing.push(`用户拒答：${fields.declined.join('；')}`);
  const lines = [
    '**需求回述**（原样发给用户，请他逐条确认或纠正）',
    `- 结果：${text(state.summaries.altitude)}（要发生什么，不是要做什么）`,
    `- 怎么算成：${text(fields.success)}（用户语言，不追阈值）`,
    `- 不让步：${list(fields.fixed)}`,
    `- 可以换：${list(fields.open)}`,
    `- 明确不做：${text(fields.notDoing)}`,
    `- 这次谈出来的：${list(fields.surfaced)}`,
    `- 还没定：${missing.length > 0 ? missing.join('、') : '无'}`,
  ];
  if (looksLikeTask(state.summaries.altitude)) {
    lines.push('', '⚠ 上面「结果」读起来像做法，不像要发生的结果：先问出「做成之后你想看到什么」，再改写这一行。');
  }
  return lines;
}

function guidanceText(state, note, goalInfo, warnings) {
  const lines = [];
  const warnLines = (Array.isArray(warnings) ? warnings : []).filter((item) => item !== '');
  if (state.active !== true) {
    if (state.steps === 0 && state.summaries.altitude === '') {
      return [
        '### 许愿模式未开启',
        '',
        '输入 `/wish`，或调用 `wish_requirement`（`action=start`）开启。',
        '',
        '模式按 **高度 → 深度 → 广度 → 速度** 推进：高度是对话，后三层自动探索并落盘到探索目录，每层都要你确认。',
      ].join('\n');
    }
    return buildPlan(state);
  }

  const stage = state.stage;
  const phase = effectivePhase(state, goalInfo);
  lines.push(`### 许愿 · ${STAGE_LABEL[stage]}（${STAGE_CORE[stage]}）`, '');
  lines.push(stateLine(state, goalInfo), '');
  lines.push(`**进度**：${progressLine(state)}`, '');
  if (typeof note === 'string' && note !== '') lines.push(`> ${note}`, '');

  if (phase === 'talking') {
    lines.push('**这一层要问清楚**（每轮挑 1–3 个，等用户回答）：');
    ALTITUDE_QUESTIONS.forEach((question, index) => lines.push(`${index + 1}. ${question}`));
    lines.push('', `**本层产出**：一句话结果（要发生什么，不是要做什么）+ 怎么算成 + 边界 + 这次谈出来的。`);
    lines.push('**记录要求**：summary 用结果句式（"让 X 从 A 变成 B"），不用任务句式（"做 X"）；可带 fixed / open / declined / materials / surfaced / success / notDoing。');
    lines.push('', ...recapText(state));
    lines.push(
      '',
      '**下一步**：用户确认后用 `record` 落盘本层结论（必须含 `surfaced`），再 `confirm`（`userSaid` 引用用户原话）进入深度层；进入后深度探索会自动开始。',
    );
  } else if (phase === 'exploring') {
    const spec = STAGE_SPEC[stage];
    const dir = state.slug === '' ? '' : `${WISHES_DIR}/${state.slug}/${stage}/`;
    lines.push('**自动探索中**（goal 由插件管理）：');
    lines.push('- 这是自动推进轮次：不要用散文提问结束回合，需要用户输入请用 `ask_user_question`。');
    lines.push('- 每轮结束前用 `wish_requirement(action=record)` 落盘进展。');
    if (goalInfo !== null && goalInfo !== undefined) {
      lines.push(`- 当前轮次：第 ${goalInfo.roundsStarted}/${goalInfo.maxGoalRounds} 轮。边际收益为零就收尾，不要为烧轮次而工作。`);
    }
    lines.push('', '**本层还缺**：');
    const missing = missingItems(state, stage);
    lines.push(...(missing.length === 0 ? ['- 门禁已满足，可以 `conclude`'] : missing.map((item) => `- ${item}`)));
    lines.push('', `**本层产出**：${spec.output}`);
    lines.push(`**上限判据**：${spec.ceiling}`);
    lines.push('', '达到上限后调用 `wish_requirement(action=conclude, ceiling=...)` 收尾。');
    if (dir !== '') lines.push('', `**工作目录**：${dir}`);
  } else if (phase === 'reviewing') {
    lines.push('**本层探索已停，等待用户确认**：向用户汇报结论、证据强度、上限判断与残余风险，并给出确认问题。');
    lines.push('', `**结论**：${state.summaries[stage] || '未记录'}`);
    if (state.ceilings[stage] !== '') lines.push('', `**上限判断**：${state.ceilings[stage]}`);
    lines.push('', '**请用户确认**：');
    (STAGE_SPEC[stage]?.review ?? []).forEach((question, index) => lines.push(`${index + 1}. ${question}`));
    lines.push('', '用户明确同意后调用 `confirm`（`userSaid` 引用原话）；用户要求补做就用 `revisit` 追加探索。');
  } else if (phase === 'blocked' || phase === 'paused') {
    lines.push(`**自动探索已停**（${goalInfo !== null && goalInfo !== undefined && goalInfo.blockReason !== undefined ? goalInfo.blockReason : 'goal 被暂停或达到轮次上限'}）。`);
    lines.push('', '先把当前进展 `record` 落盘；然后告诉用户：可以 `revisit` 本层追加预算继续探索，或直接 `conclude` 收尾并按当前结果确认。');
  } else if (phase === 'confirmed') {
    lines.push('**本层已确认。**');
    if (allConfirmed(state)) {
      lines.push('', '四层均已确认：调用 `close` 生成方案（首次返回核对清单，确认无冲突后带 `consistency=true` 再关闭）。');
    } else {
      lines.push('', `下一层「${STAGE_LABEL[nextStage(stage)]}」的探索会自动开始；本回合只写一句交接，不要重复本层工作。`);
    }
  }

  if (warnLines.length > 0) {
    lines.push('', '**警告**：', ...warnLines.map((item) => `- ${item}`));
  }
  return lines.join('\n');
}

function nextStepText(state, goalInfo) {
  if (state.active !== true) return '输入 /wish 或调用 action=start 开启许愿模式。';
  if (allConfirmed(state)) return '调用 action=close 完成核对，并以 consistency=true 关闭。';
  const phase = effectivePhase(state, goalInfo ?? null);
  const stage = STAGE_LABEL[state.stage];
  if (phase === 'talking') return `向用户提出 1–3 个「${stage}」问题；确认后 record 落盘，再 confirm。`;
  if (phase === 'exploring') return `补齐「${stage}」缺失的产出，用 ask_user_question 获取用户输入；达到上限后 conclude。`;
  if (phase === 'reviewing') return `向用户汇报「${stage}」结论并请其确认；用户同意后 confirm。`;
  if (phase === 'blocked' || phase === 'paused') return 'record 当前进展；让用户选择 revisit 追加探索或结论当前结果。';
  return '写一句交接；若四层都已确认则 close。';
}

/** 当前层的完整探索规格，注入到系统提示，保证每一轮都有同一个标尺。 */
function stageSpecText(state) {
  const stage = state.stage;
  const spec = STAGE_SPEC[stage];
  if (spec === undefined) return [];
  const lines = [`**本层产出**：${spec.output}`, `**上限判据**：${spec.ceiling}`];
  if (state.reviewed[stage] === true) {
    lines.push('**请用户确认**：');
    spec.review.forEach((question, index) => lines.push(`${index + 1}. ${question}`));
  } else if (missingItems(state, stage).length > 0) {
    lines.push('**本层还缺**：');
    missingItems(state, stage).forEach((item) => lines.push(`- ${item}`));
  }
  return lines;
}

/** The active-mode policy section. Only contributes tokens while the mode is active. */
function policyText(state, goalInfo, stageDir) {
  const stage = state.stage;
  const phase = effectivePhase(state, goalInfo);
  const lines = [];
  lines.push('## 许愿模式（进行中）', '');
  lines.push(stateLine(state, goalInfo), '');
  lines.push(state.topic !== '' ? `主题（用户原话）：${state.topic}` : '主题：尚未给出原话——先请用户用一句话说出要许愿的事。');
  if (state.slug !== '') lines.push(`探索目录：${WISHES_DIR}/${state.slug}/（当前层：${stageDir}）`);
  lines.push(`当前层：${STAGE_LABEL[stage]}（${STAGE_CORE[stage]}）· 阶段：${phase}`);
  lines.push(`进度：${progressLine(state)}`, '');

  if (stage === 'altitude') {
    lines.push(
      '**高度层：对话，不自动迭代。**',
      '- 一次只问 1–3 个具体问题，等用户回答；可以给 2–3 个候选让用户挑，但不要替用户选。',
      '- 先复述用户刚说的一句，再问下一个问题；用户说「不是这个意思」时承认并换个问法。',
      '- 禁止抬杠式反问（「为什么是 X」「去掉 Y 还剩什么」）；提问往想法上挖，不要拆措辞。',
      '- 只有用户明确说「你来判断」时才给判决；给完回到盘问确认。',
      '- 需要结构化选择或明确表态时可以用 ask_user_question；普通对话直接问即可。',
      '- 固定约束只挑战一次，记录进 fixed 后不再反复要求放宽；用户拒答的记入 declined 不再追问。',
      '- 这一层不写代码、不改项目、不做实验；查资料用 read / grep / glob / web_search。',
      '- 这一层交付的是「用户能点头的需求」，不是更抽象的说法：把「做法」抬成「结果」（"让 X 从 A 变成 B"，不是"做 X"）。',
      '- 探针一次只用一个，按缺口选：目标（做成之后想看到什么/再之后）、具象（举个最近的具体例子）、冲突（只能保一个保哪个）、边界（不让步/可以换/不做什么）、代价（愿意付出什么）、观察（你怎么知道成了）、载体（这个形式够不够直接，替代方案留给广度层）、复用（要反复发生吗，怎么不依赖你）。',
      '- 每次 record / status 都会带回「需求回述」：原样发给用户，请他逐条确认或纠正；用户只回「差不多」就继续问，不算确认。',
      '- `surfaced` 记这次谈出来的、原话里没有的点（纠正、补充、隐含约束、临时反悔）；原话确实已完整时写一条「原话已完整，无需补充」。',
      '- 用户明确说这是一次性创意交付、没有更上层目标时，抬高只做一轮，把这句话写进 surfaced。',
      '- 不越界：不追可量化阈值（那是深度层的 acceptance），不展开替代方案（那是广度层），不做排期（那是速度层）。',
      '- 用户明确确认后用 `record` 落盘，再 `confirm`（userSaid 引用用户原话）进入深度层；进入后深度探索会自动开始。',
      ...(AUTO_SLUG.test(state.slug)
        ? ['- 目录名还是自动名：先用 `start`（不带 topic、带 `slug`）换成 3–5 个英文单词（小写、`-` 连接），再 record。']
        : []),
    );
  } else if (phase === 'exploring') {
    lines.push(
      '**本层自动探索（goal 由插件管理）**',
      '- 这是自动推进轮次：不要用散文向用户提问然后结束回合——goal 会自动开下一轮，用户没有机会回答。需要用户输入时调用 `ask_user_question`（阻塞等待）。',
      `- 每轮结束前用 \`wish_requirement(action=record, dimension=${stage})\` 把新结论落盘；下一轮据此继续，不要重复劳动。`,
      `- 所有笔记、证据表、实验脚本与结果放在 \`${stageDir === '' ? '探索目录' : stageDir}/\`；实验是允许且往往是必要的。不要修改该目录之外的任何文件，不要开始实现，不要改项目代码。`,
      '- 不要调用 `create_goal` / `update_goal`；goal 由插件创建和完成。',
      '- 边际收益为零就收尾：先 record，再 `wish_requirement(action=conclude, dimension=' + stage + ', ceiling=「为什么这是本层上限、哪些做不到」)`。',
      '- 首轮可先用 `ask_user_question` 收集本层独有输入（1–3 个）：',
      ...STAGE_SPEC[stage].intake.map((question) => `  - ${question}`),
      '- 若 goal 被 round-limit / paused 打断：先把进展 record，再告诉用户可用 `revisit` 追加预算或直接确认当前结果。',
      '',
      ...stageSpecText(state),
    );
  } else if (phase === 'reviewing') {
    lines.push(
      '**本层待用户确认（探索已停）**',
      '- 向用户汇报：结论、证据强度（哪些验证过、哪些还是假设）、上限判断、残余风险，以及下一层会怎么用。',
      '- 给出 2–3 个确认问题；可以用 `ask_user_question`，也可以直接问。',
      '- 用户明确同意后调用 `confirm`（userSaid 引用用户原话）；用户要求补做就 `revisit` 本层。',
      '- 不要替用户确认；也不要因为「看起来够了」自己确认。',
      '',
      ...stageSpecText(state),
    );
  } else if (phase === 'blocked' || phase === 'paused') {
    lines.push(
      '**自动探索已停**',
      '- 先把当前进展 `record` 落盘；然后告诉用户：可以 `revisit` 本层追加预算继续探索，或直接 `conclude` 收尾并按当前结果确认。',
    );
  } else if (phase === 'confirmed') {
    lines.push(
      '**本层已确认**',
      `- 写一句交接即可，不要重复本层工作；下一层${allConfirmed(state) ? '已全部确认，调用 close 生成方案' : '的探索会自动开始'}。`,
    );
  }

  const doneStages = STAGES.filter((item) => state.confirmed[item] && item !== stage);
  if (doneStages.length > 0) {
    lines.push('', '**已确认层**（作为本层前提，不要推翻；有冲突先 revise）：');
    for (const item of doneStages) lines.push(`- ${STAGE_LABEL[item]}：${state.summaries[item] || '未记录'}`);
  }

  lines.push(
    '',
    '**约束（始终有效）**',
    '- 只做愿望澄清与探索，不实现、不改项目文件；实验产物只能写在探索目录内。',
    '- `confirm` / `start` / 真正关闭 `close` 必须在用户直接回复的回合里调用；用户只是回答子问题或选了某个候选，都不算确认。',
    '- 用户确认原话记入 userSaid；不要编造用户没说过的话。',
    '- 跨层冲突先用 `revise` 修订并重新确认，不要带着矛盾进入下一层。',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Human-turn authority
// ---------------------------------------------------------------------------

/**
 * Whether the current root turn contains host-attested direct human input.
 * Mirrors the goal-tool authority check: a goal round's followup is not human.
 */
function hasDirectHumanInput(ctx, agent) {
  const agents = (() => {
    try {
      return ctx.get('agents');
    } catch {
      return undefined;
    }
  })();
  if (agents !== undefined && agents !== null && typeof agents.roots === 'function') {
    let roots;
    try {
      roots = agents.roots();
    } catch {
      return false;
    }
    if (!Array.isArray(roots) || !roots.includes(agent)) return false;
  }
  let boundary;
  try {
    const projections = ctx.get('sessionProjections');
    if (projections === undefined || projections === null) return false;
    boundary = projections.stateOf(agent.session, 'turnBoundary');
  } catch {
    return false;
  }
  if (boundary === undefined || boundary === null || boundary.openTurnStartSeq === null) return false;
  let events;
  try {
    events = agent.session.snapshotEvents();
  } catch {
    return false;
  }
  // 一次扫描：用户直接消息，或本回合内一次已作答的 ask_user_question。
  // 后者是人工作答的 attestation（结构化确认卡），让「conclude 后当场 review 并确认」可行。
  const questionCalls = new Set();
  for (let seq = boundary.openTurnStartSeq + 1; seq < events.length; seq += 1) {
    const event = events[seq];
    if (event === undefined) continue;
    if (event.type === 'user/message' && event.data !== undefined
      && event.data.source !== undefined && event.data.source.kind === 'user') {
      return true;
    }
    if (event.type === 'tool/call' && event.data !== undefined && event.data.name === 'ask_user_question'
      && typeof event.data.callId === 'string') {
      questionCalls.add(event.data.callId);
      continue;
    }
    if (event.type === 'tool/result' && event.data !== undefined && event.data.message !== undefined
      && event.data.message !== null && event.data.message.source !== undefined) {
      const callId = event.data.message.source.callId;
      if (typeof callId !== 'string' || !questionCalls.has(callId)) continue;
      const failed = event.data.error !== undefined || event.data.message.isError === true;
      if (failed) continue;
      // timed 模式的超时结果不是回答，不能当作人工确认。
      if (resultTextOf(event.data.message).includes('"pending":true')) continue;
      return true;
    }
  }
  return false;
}

function requireHuman(ctx, agent) {
  if (hasDirectHumanInput(ctx, agent)) return;
  throw new Error(
    '这个操作需要用户当前回合的直接指示：请先把结论复述给用户，等用户明确回复（对 / 可以 / 就这样）后再调用；'
    + '如果刚用 ask_user_question 拿到了用户答复，本回合可以直接调用；否则先结束回合。',
  );
}

// ---------------------------------------------------------------------------
// Tool / command metadata
// ---------------------------------------------------------------------------

const TOOL_DESCRIPTION = [
  '许愿模式的状态机：高度（重新判断真正要解决什么问题）→ 深度（依据/方法/验证）→ 广度（可参与的领域/工具/方法）→ 速度（执行效率与可靠性）。',
  '',
  '高度是对话层，不自动迭代；后三层由插件挂 goal 自动探索到该层上限，每层结束必须经用户确认。探索过程与产物落到 wishes/<主题>/<层>/。',
  '',
  '用法：',
  '- action=start 开启（topic 为用户原话；slug 为 3–5 个英文单词，小写、用 - 连接，如 reduce-onboarding-friction；不给则用自动目录名）；status 查看；',
  '- record 记录/更新本层内容（只落盘，不推进；数组字段并集，标量覆盖）；',
  '- conclude 结束本层自动探索（必须带 ceiling；门禁不足会被拒绝并列出缺项）；',
  '- confirm 用户确认并进入下一层（必须带 userSaid 引用用户原话；用户明确要求跳过自动探索时带 skip_explore=true）；',
  '- revise 修订已收尾/已确认层（会使其后各层失效，需要重新确认）；',
  '- revisit 回到某层重做（探索层会重新开一轮 goal 预算）；',
  '- close 结束（首次返回核对清单，确认无冲突后带 consistency=true）。',
  '',
  '高度层：用探针挖需求（一次一个探针、1–3 问），把「做法」抬成「结果」；每次 record / status 会把「需求回述」还给模型，原样发给用户纠正；确认前必须 record 出 surfaced（这次谈出来的、原话里没有的点）。',
  '探索层：这是一个自动轮次，需要用户输入时必须用 ask_user_question（散文提问会立即被下一轮覆盖）；每轮 record 落盘；达到上限后 conclude。',
].join('\n');

const ACTION_TITLE = {
  start: '开启许愿',
  status: '查看许愿进度',
  record: '记录许愿结论',
  conclude: '结束本层探索',
  confirm: '确认本层结论',
  revise: '修订已确认结论',
  revisit: '回到某一层',
  close: '结束许愿',
};

const PRESENT_KIND = {
  start: 'other',
  status: 'read',
  record: 'other',
  conclude: 'other',
  confirm: 'other',
  revise: 'other',
  revisit: 'other',
  close: 'other',
};

function newMessageId() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `wish-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function filePathOf(args) {
  if (args === null || typeof args !== 'object') return '';
  if (typeof args.file_path === 'string') return args.file_path;
  if (typeof args.path === 'string') return args.path;
  return '';
}

function commandOf(args) {
  if (args === null || typeof args !== 'object') return '';
  return typeof args.command === 'string' ? args.command : '';
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/**
 * Host plugin entry.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function apply(ctx) {
  /** Per-session fallback when the session-projection registry is not composed. */
  const memory = new Map();

  const projectionsOf = () => {
    try {
      return ctx.get('sessionProjections');
    } catch {
      return undefined;
    }
  };

  function readState(session) {
    const projections = projectionsOf();
    if (projections !== undefined) {
      try {
        const state = projections.stateOf(session, PROJECTION_KEY);
        if (state !== undefined) return state;
      } catch {
        /* fall through to the in-memory mirror */
      }
    }
    return memory.get(session.id) ?? freshState();
  }

  function writeState(session, state) {
    if (projectionsOf() === undefined) memory.set(session.id, state);
  }

  // Durable state: fold command runs and tool calls from the session log.
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register({
      key: PROJECTION_KEY,
      stateVersion: STATE_VERSION,
      stateSchema: PASSTHROUGH,
      init: () => freshState(),
      apply: (state, event) => {
        try {
          return fold(state, event);
        } catch {
          return state;
        }
      },
      wire: {
        viewSchema: PASSTHROUGH,
        view: (state) => viewOf(state),
      },
    });
  });

  // Active-mode guidance. Inactive mode contributes no text.
  ctx.systemPrompt.section({
    name: 'wish-mode:policy',
    order: 520,
    text: (context) => {
      try {
        const agent = context === null || context === undefined ? undefined : context.agent;
        if (agent === undefined || agent === null || agent.session === undefined) return '';
        const state = readState(agent.session);
        if (state.active !== true) return '';
        const goalInfo = goalInfoOf(ctx, agent, state.stage);
        const stageDir = stageDirOf(state, ctx, agent);
        return policyText(state, goalInfo, stageDir);
      } catch {
        return '';
      }
    },
  });

  // File boundary + goal ownership. The mode is interactive; goals are plugin-owned.
  ctx.effect(() => ctx.tools.guard((execution) => {
    try {
      const agent = execution.agent;
      if (agent === undefined || agent === null || agent.session === undefined) return undefined;
      const state = readState(agent.session);
      if (state.active !== true) return undefined;
      const name = execution.name;
      if (GOAL_TOOLS.has(name)) {
        return '许愿模式的 goal 由插件管理：请用 wish_requirement 的 conclude / confirm / revisit，不要直接操作 goal。';
      }
      if (SPAWN_TOOLS.has(name)) {
        return '许愿模式中不派生子 agent / workflow / ralph：子会话会绕过文件边界。';
      }
      if (FILE_WRITE_TOOLS.has(name)) {
        if (state.topic === '') return '许愿模式还没有主题：先请用户用一句话说出要许愿的事，再写文件。';
        const root = exploreDirOf(state, ctx, agent);
        if (root === '') return '许愿模式还没有主题目录：先 /wish <原话> 确定主题，再写文件。';
        const target = filePathOf(execution.arguments);
        if (target === '') return '许愿模式中写文件需要 file_path。';
        const absolute = path.resolve(cwdOf(ctx, agent.session), target);
        if (!isInside(root, absolute)) {
          return `许愿模式进行中：只能在 ${root} 下写文件；要修改项目请先 /wish off。`;
        }
        return undefined;
      }
      if (name === 'bash' || name === 'pwsh') {
        if (state.stage === 'altitude') return '高度层是对话层，不执行命令；查资料请用 read / grep / glob / web_search。';
        if (DANGEROUS_COMMAND.test(commandOf(execution.arguments))) {
          return '许愿模式中禁止可能破坏项目状态的命令（rm -rf、git 写操作等）。实验产物请只写到探索目录。';
        }
        return undefined;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }), 'wish-mode: tool guard');

  // Human entry point: /wish <原话>（以原话为主题开启）, /wish on, /wish off.
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: COMMAND_NAME,
      description: '进入或退出许愿模式（高度对话 → 深度/广度/速度自动探索，每层需确认）',
      input: { hint: '<你的原话>' },
      handler: ({ agent, rawInput }) => {
        const text = typeof rawInput === 'string' ? rawInput.trim() : '';
        const raw = text.toLowerCase();
        const state = readState(agent.session);
        const startTopic = text !== '' && raw !== 'on' && raw !== 'off' ? text : '';
        const active = raw === 'off' ? false : raw === 'on' || startTopic !== '' ? true : !state.active;

        const restarting = startTopic !== '' && (!state.active || state.topic !== startTopic);
        if (!restarting && active === state.active) {
          if (startTopic !== '' && state.active && state.topic === startTopic) {
            return {
              kind: 'success',
              text: `许愿模式已在运行，当前在「${STAGE_LABEL[state.stage]}」层。`,
            };
          }
          return {
            kind: 'success',
            text: active
              ? `许愿模式已开启，当前在「${STAGE_LABEL[state.stage]}」。`
              : '许愿模式未开启。',
          };
        }

        const warning = settleOwnGoal(ctx, agent);
        writeState(agent.session, reduce(
          state,
          active ? { action: 'start', topic: startTopic } : { action: 'close', force: true },
        ));

        if (active && startTopic !== '') {
          // 只把用户原话送进会话；模式、层级、提问方式由系统提示段承载，不进转录。
          try {
            agent.steer({
              id: newMessageId(),
              role: 'user',
              content: [{ type: 'text', text: startTopic }],
              source: { kind: 'user' },
            });
          } catch {
            /* activation still succeeded; the user can type the first message */
          }
        }

        if (!active) {
          return { kind: 'success', text: warning === '' ? '已退出许愿模式。' : `已退出许愿模式。（${warning}）` };
        }
        if (startTopic !== '') {
          return {
            kind: 'success',
            text: `许愿主题已记录：${startTopic}。目录名待定，模型会补一个 3–5 词的英文名（暂用 ${autoSlug(startTopic)}）。`,
          };
        }
        return {
          kind: 'success',
          text: warning === ''
            ? '已开启许愿。把你要许愿的事用原话发给我就行。'
            : `已开启许愿。把你要许愿的事用原话发给我就行。（${warning}）`,
        };
      },
    });
  });

  // Model entry point and state machine.
  ctx.tools.register({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'start 开启；status 查看；record 记录本层内容；conclude 结束本层自动探索（需 ceiling）；confirm 用户确认并进入下一层（需 userSaid）；revise 修订已收尾层；revisit 回到某层重做；close 结束。',
        },
        topic: {
          type: 'string',
          description: '要许愿的主题，用户原话一句话。仅 action=start 使用。',
        },
        slug: {
          type: 'string',
          description: '仅 action=start：3–5 个简短英文单词，小写、用 - 连接，概括主题（如 reduce-onboarding-friction）。不给则用自动目录名 wish-xxxxxxxx。',
        },
        dimension: {
          type: 'string',
          enum: STAGES,
          description: 'record/conclude/confirm 省略时默认当前层（不能跨层）；revise / revisit 必填。',
        },
        summary: {
          type: 'string',
          description: '本层结论，1–3 句话。',
        },
        ceiling: {
          type: 'string',
          description: 'conclude 必填：为什么这已是本层能达到的上限、哪些做不到。',
        },
        userSaid: {
          type: 'string',
          description: 'confirm 必填：引用用户确认时的原话。',
        },
        skip_explore: {
          type: 'boolean',
          description: 'confirm 选填：用户明确要求跳过本层自动探索时传 true。',
        },
        fixed: {
          type: 'array',
          items: { type: 'string' },
          description: '仅 altitude（高度）：用户明确不愿调整的固定约束。记录后不得反复挑战。',
        },
        open: {
          type: 'array',
          items: { type: 'string' },
          description: '仅 altitude（高度）：仍可调整、可交换的约束。',
        },
        declined: {
          type: 'array',
          items: { type: 'string' },
          description: '用户拒绝回答或要求不再追问的项。记录后不再问。',
        },
        materials: {
          type: 'array',
          items: { type: 'string' },
          description: '仅 altitude（高度）：已有材料/数据/文档线索，只记线索，不追问怎么用。',
        },
        surfaced: {
          type: 'array',
          items: { type: 'string' },
          description: '仅 altitude（高度）：用户原话里没有、这次谈出来的点（纠正、补充、隐含约束、临时反悔）。原话已完整时写一条「原话已完整，无需补充」。',
        },
        success: {
          type: 'string',
          description: '仅 altitude（高度）：用户嘴里「成了的样子」（定性即可，阈值留给深度层）。',
        },
        notDoing: {
          type: 'string',
          description: '仅 altitude（高度）：这次明确不做的事。',
        },
        rationale: {
          type: 'string',
          description: '仅 altitude（高度）：模型给过判断时记录依据与改判条件。',
        },
        findings: {
          type: 'array',
          items: { type: 'string' },
          description: '仅 depth：每条「结论 ← 来源/证据 · 如何验证」。',
        },
        assumptions: {
          type: 'array',
          items: { type: 'string' },
          description: '仅 depth：每条「假设 → 验证方式 → 已执行的结果」。',
        },
        methods: {
          type: 'array',
          items: { type: 'string' },
          description: '仅 depth：每条「研究/验证方法 → 适用性与代价 → 为什么选或不选」；写怎么查、用什么数据、做什么实验，不写解决方案。',
        },
        acceptance: {
          type: 'string',
          description: '仅 depth：可量化的验收标准。',
        },
        falsifiers: {
          type: 'array',
          items: { type: 'string' },
          description: '仅 depth：什么证据会推翻本层结论。',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: '仅 range：每条「名称 · 领域/载体 · 机制 · 现实先例 · 预期提升 · 成本/风险」。',
        },
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: '仅 range：覆盖的不同领域/载体。',
        },
        novel: {
          type: 'array',
          items: { type: 'string' },
          description: '仅 range：反直觉或跨领域的新思路。',
        },
        shortlist: {
          type: 'array',
          items: { type: 'string' },
          description: '仅 range：2–3 个收敛候选 + 推荐 + 什么情况下改推荐。',
        },
        exclusions: {
          type: 'array',
          items: { type: 'string' },
          description: '仅 range：明确排除的选项 + 理由。',
        },
        slice: {
          type: 'string',
          description: '仅 speed：最小可验证切片 + 预计时间 + 它证明什么。',
        },
        tracks: {
          type: 'array',
          items: { type: 'string' },
          description: '仅 speed：可并行/可委派的工作。',
        },
        dependencies: {
          type: 'array',
          items: { type: 'string' },
          description: '仅 speed：关键路径与依赖顺序。',
        },
        loop: {
          type: 'string',
          description: '仅 speed：当前反馈回路多长、怎么缩短。',
        },
        scenarios: {
          type: 'string',
          description: '仅 speed：base / upside / fallback + 概率 + 触发条件。',
        },
        checkpoints: {
          type: 'array',
          items: { type: 'string' },
          description: '仅 speed：go/no-go 检查点。',
        },
        consistency: {
          type: 'boolean',
          description: '仅 close：确认四层结论与固定约束无冲突后传 true。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [
          'active', 'topic', 'slug', 'stage', 'stageLabel', 'phase', 'done',
          'confirmed', 'reviewed', 'steps', 'questions', 'guidance', 'plan',
          'exploreDir', 'nextStep', 'goal',
        ],
        properties: {
          active: { type: 'boolean' },
          topic: { type: 'string' },
          slug: { type: 'string' },
          stage: { type: 'string', enum: STAGES },
          stageLabel: { type: 'string' },
          phase: { type: 'string', enum: PHASES },
          done: { type: 'boolean' },
          steps: { type: 'integer' },
          confirmed: {
            type: 'object',
            additionalProperties: false,
            required: ['altitude', 'depth', 'range', 'speed'],
            properties: {
              altitude: { type: 'boolean' },
              depth: { type: 'boolean' },
              range: { type: 'boolean' },
              speed: { type: 'boolean' },
            },
          },
          reviewed: {
            type: 'object',
            additionalProperties: false,
            required: ['altitude', 'depth', 'range', 'speed'],
            properties: {
              altitude: { type: 'boolean' },
              depth: { type: 'boolean' },
              range: { type: 'boolean' },
              speed: { type: 'boolean' },
            },
          },
          questions: { type: 'array', items: { type: 'string' } },
          guidance: { type: 'string' },
          plan: { type: 'string' },
          exploreDir: { type: 'string' },
          nextStep: { type: 'string' },
          goal: {
            oneOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                required: ['phase', 'roundsStarted', 'maxGoalRounds'],
                properties: {
                  phase: { type: 'string', enum: ['active', 'paused', 'blocked', 'complete'] },
                  roundsStarted: { type: 'integer' },
                  maxGoalRounds: { type: 'integer' },
                  blockReason: { type: 'string' },
                },
              },
            ],
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.guidance }],
      presentationMeta: (_args, value) => ({
        wish: {
          active: value.active === true,
          stage: value.stage,
          steps: value.steps,
          reviewed: value.reviewed,
          closed: value.active === false && value.steps > 0,
        },
      }),
    },
    async execute(args, exec) {
      const agent = exec.agent;
      if (agent === undefined || agent === null) {
        throw new Error('wish_requirement 需要在一个会话中调用。');
      }
      const state = readState(agent.session);
      const action = args.action;
      const warnings = [];

      if (action === 'status') {
        return buildValue(ctx, agent, state, '', warnings);
      }

      if (action === 'start') {
        requireHuman(ctx, agent);
        const topic = cleanText(args.topic, 200);
        const given = cleanSlug(args.slug);
        const asked = typeof args.slug === 'string' && args.slug.trim() !== '';
        if (asked && given === '') {
          warnings.push('slug 需要 3–5 个简短英文单词（小写、用 - 连接），例如 reduce-onboarding-friction。这次用自动目录名。');
        }
        if (state.active && (topic === '' || topic === state.topic)) {
          if (given !== '' && AUTO_SLUG.test(state.slug)) {
            const renamed = reduce(state, { action: 'start', slug: given });
            writeState(agent.session, renamed);
            warnings.push(await writeMetaFile(ctx, renamed, agent));
            return buildValue(ctx, agent, renamed, `目录名已设为 \`${given}\`。`, warnings);
          }
          return buildValue(ctx, agent, state, `许愿模式已在「${STAGE_LABEL[state.stage]}」层。`, warnings);
        }
        if (state.active) {
          const warning = settleOwnGoal(ctx, agent);
          if (warning !== '') warnings.push(warning);
        }
        const next = reduce(state, { action: 'start', topic, slug: args.slug });
        writeState(agent.session, next);
        warnings.push(await writeMetaFile(ctx, next, agent));
        return buildValue(ctx, agent, next, '', warnings);
      }

      if (action === 'close') {
        if (state.active !== true) {
          return buildValue(ctx, agent, state, '许愿模式本来就没有开启。', warnings);
        }
        if (args.consistency !== true) {
          return buildValue(ctx, agent, state, '', warnings, { checklist: true });
        }
        requireHuman(ctx, agent);
        if (!allConfirmed(state)) {
          const pending = STAGES.filter((stage) => state.confirmed[stage] !== true).map((stage) => STAGE_LABEL[stage]);
          throw new Error(`还有层没有确认：${pending.join('、')}。先逐层 confirm，再 close。`);
        }
        const warning = settleOwnGoal(ctx, agent);
        if (warning !== '') warnings.push(warning);
        const next = reduce(state, { action: 'close', consistency: true });
        writeState(agent.session, next);
        warnings.push(await writePlanFile(ctx, next, agent));
        return buildValue(ctx, agent, next, '', warnings);
      }

      if (action === 'revise') {
        const dimension = args.dimension;
        if (!isStage(dimension)) {
          throw new Error('action=revise 需要 dimension（altitude/depth/range/speed）。');
        }
        if (state.active && dimension === state.stage && state.reviewed[dimension] !== true) {
          throw new Error(`「${STAGE_LABEL[dimension]}」还在探索：用 action=record 更新；revise 用于已收尾/已确认层。`);
        }
        if (cleanText(args.summary) === '' && !hasAnyField(dimension, args)) {
          throw new Error('action=revise 至少需要 summary 或本层的一个字段。');
        }
        const next = reduce(state, opFromArgs('revise', dimension, args));
        writeState(agent.session, next);
        warnings.push(await writeStageFile(ctx, next, agent, dimension));
        if (state.active !== true) warnings.push(await writePlanFile(ctx, next, agent));
        return buildValue(
          ctx,
          agent,
          next,
          `已修订「${STAGE_LABEL[dimension]}」层${state.active ? '，需要用户重新确认' : ''}。`,
          warnings,
        );
      }

      if (state.active !== true) {
        throw new Error('许愿模式尚未开启：请先调用 wish_requirement（action=start），或让用户输入 /wish。');
      }

      if (action === 'record') {
        const dimension = isStage(args.dimension) ? args.dimension : state.stage;
        if (dimension !== state.stage) {
          throw new Error(
            `只能记录当前层「${STAGE_LABEL[state.stage]}」。回到「${STAGE_LABEL[dimension]}」用 action=revisit；已收尾层用 action=revise。`,
          );
        }
        if (cleanText(args.summary) === '' && !hasAnyField(dimension, args)) {
          throw new Error(`action=record 至少需要 summary 或本层的一个字段（${FIELD_SPEC[dimension].lists.concat(FIELD_SPEC[dimension].texts).join(' / ')}）。`);
        }
        const next = reduce(state, opFromArgs('record', dimension, args));
        writeState(agent.session, next);
        warnings.push(await writeStageFile(ctx, next, agent, dimension));
        return buildValue(
          ctx,
          agent,
          next,
          `已记录「${STAGE_LABEL[dimension]}」的进展，尚未确认。`,
          warnings,
        );
      }

      if (action === 'conclude') {
        const dimension = state.stage;
        if (!isExploreStage(dimension)) {
          throw new Error('高度层不适用 conclude：高度是对话层，直接 record + confirm。');
        }
        if (cleanText(args.summary) === '' && cleanText(state.summaries[dimension]) === '') {
          throw new Error('conclude 需要本层结论：先把 summary 写进 record，再收尾。');
        }
        if (cleanText(args.ceiling, 3000) === '') {
          throw new Error('action=conclude 需要 ceiling：用一段话说明为什么这已是本层上限、哪些做不到。');
        }
        const candidate = mergeFields(state, dimension, opFromArgs('conclude', dimension, args));
        const missing = missingItems(candidate, dimension);
        if (missing.length > 0) {
          throw new Error(
            `「${STAGE_LABEL[dimension]}」还不能收尾，还缺：\n- ${missing.join('\n- ')}\n用 action=record 补齐后再 conclude。`,
          );
        }
        const next = reduce(state, opFromArgs('conclude', dimension, args));
        writeState(agent.session, next);
        const warning = settleOwnGoal(ctx, agent);
        if (warning !== '') warnings.push(warning);
        warnings.push(await writeStageFile(ctx, next, agent, dimension));
        return buildValue(ctx, agent, next, '', warnings);
      }

      if (action === 'confirm') {
        const dimension = state.stage;
        const userSaid = cleanText(args.userSaid, 500);
        if (userSaid === '') {
          throw new Error('action=confirm 需要 userSaid：引用用户确认时的原话。');
        }
        requireHuman(ctx, agent);
        if (allConfirmed(state)) {
          throw new Error('四层都已确认：请调用 action=close 生成方案。');
        }
        if (dimension === 'altitude') {
          if (cleanText(args.summary) === '' && cleanText(state.summaries.altitude) === '') {
            throw new Error('高度层还没有结论：先用 record 写入一句话结果（要发生什么）与成功判据。');
          }
          const surfaced = unionLists(state.fields.altitude.surfaced, cleanList(args.surfaced));
          if (surfaced.length === 0) {
            throw new Error('高度层还缺：这次谈出来的（surfaced）。如果用户原话已经完整，写一条「原话已完整，无需补充」。');
          }
        } else if (state.reviewed[dimension] !== true && args.skip_explore !== true) {
          throw new Error(
            `「${STAGE_LABEL[dimension]}」还在探索或尚未收尾：先 conclude；如果用户明确要求跳过自动探索，传 skip_explore=true。`,
          );
        }
        const next = reduce(state, opFromArgs('confirm', dimension, args));
        writeState(agent.session, next);
        const warning = settleOwnGoal(ctx, agent);
        if (warning !== '') warnings.push(warning);
        if (dimension !== 'speed') {
          const created = createStageGoal(ctx, agent, next, nextStage(dimension));
          if (created.warn !== '') warnings.push(created.warn);
        }
        warnings.push(await writeStageFile(ctx, next, agent, dimension));
        warnings.push(await writeMetaFile(ctx, next, agent));
        const note = args.skip_explore === true
          ? `已跳过「${STAGE_LABEL[dimension]}」的自动探索并按用户要求确认。`
          : `已确认「${STAGE_LABEL[dimension]}」层。`;
        return buildValue(ctx, agent, next, note, warnings);
      }

      if (action === 'revisit') {
        const dimension = args.dimension;
        if (!isStage(dimension)) {
          throw new Error('action=revisit 需要 dimension（altitude/depth/range/speed）。');
        }
        const warning = settleOwnGoal(ctx, agent);
        if (warning !== '') warnings.push(warning);
        const next = reduce(state, { action: 'revisit', dimension });
        writeState(agent.session, next);
        if (dimension !== 'altitude') {
          const created = createStageGoal(ctx, agent, next, dimension);
          if (created.warn !== '') warnings.push(created.warn);
        }
        return buildValue(ctx, agent, next, `已回到「${STAGE_LABEL[dimension]}」层。`, warnings);
      }

      throw new Error(`未知 action：${String(action)}`);
    },
    presentCall: (args) => ({
      card: 'generic',
      title: ACTION_TITLE[args.action] ?? '许愿',
      kind: PRESENT_KIND[args.action] ?? 'other',
      rawInput: args,
    }),
    presentResult: (_args, value) => ({
      card: 'generic',
      title: `许愿 · ${value.stageLabel}`,
      content: value.guidance === '' ? undefined : [{ type: 'text', text: value.guidance }],
    }),
  });

  /** Copy the recognizable stage fields out of raw tool args into an op. */
  function opFromArgs(action, dimension, args) {
    const op = { action, dimension };
    if (typeof args.summary === 'string') op.summary = args.summary;
    if (typeof args.ceiling === 'string') op.ceiling = args.ceiling;
    if (args.skip_explore === true) op.skip_explore = true;
    for (const key of LIST_FIELDS) if (Array.isArray(args[key])) op[key] = args[key];
    for (const key of TEXT_FIELDS) if (typeof args[key] === 'string') op[key] = args[key];
    return op;
  }

  /** Build the validated tool value from the next state. */
  function buildValue(ctxArg, agent, state, note, warnings, options = {}) {
    const stage = isStage(state.stage) ? state.stage : 'altitude';
    const goalInfo = goalInfoOf(ctxArg, agent, stage);
    const phase = effectivePhase(state, goalInfo);
    const done = allConfirmed(state);
    const closed = state.active !== true && (state.steps > 0 || state.summaries.altitude !== '');
    const plan = options.checklist === true ? '' : closed ? buildPlan(state) : '';
    const guidance = options.checklist === true
      ? checklistText(state)
      : guidanceText(state, note, goalInfo, warnings);
    return {
      active: state.active === true,
      topic: typeof state.topic === 'string' ? state.topic : '',
      slug: typeof state.slug === 'string' ? state.slug : '',
      stage,
      stageLabel: STAGE_LABEL[stage],
      phase,
      done,
      steps: state.steps,
      confirmed: {
        altitude: state.confirmed.altitude === true,
        depth: state.confirmed.depth === true,
        range: state.confirmed.range === true,
        speed: state.confirmed.speed === true,
      },
      reviewed: {
        altitude: state.reviewed.altitude === true,
        depth: state.reviewed.depth === true,
        range: state.reviewed.range === true,
        speed: state.reviewed.speed === true,
      },
      questions: questionsFor(state, goalInfo),
      guidance,
      plan,
      exploreDir: exploreDirOf(state, ctxArg, agent),
      nextStep: nextStepText(state, goalInfo),
      goal: goalInfo,
    };
  }

  async function writeMetaFile(ctxArg, state, agent) {
    if (state.topic === '') return '';
    const dir = exploreDirOf(state, ctxArg, agent);
    if (dir === '') return '';
    // createdAt 只在首次写入时确定，之后沿用（fold 是纯函数，不能在其中取时间）。
    let createdAt;
    try {
      const existing = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8'));
      if (existing !== null && typeof existing === 'object' && typeof existing.createdAt === 'string') {
        createdAt = existing.createdAt;
      }
    } catch {
      /* 首次写入或旧文件不可读 */
    }
    const now = new Date().toISOString();
    const payload = {
      version: 2,
      topic: state.topic,
      slug: state.slug,
      stage: state.stage,
      createdAt: createdAt ?? now,
      updatedAt: now,
      stages: STAGES,
      exploreDir: dir,
    };
    return guardedWrite(dir, 'meta.json', `${JSON.stringify(payload, null, 2)}\n`);
  }

  async function writeStageFile(ctxArg, state, agent, stage) {
    const dir = exploreDirOf(state, ctxArg, agent);
    if (dir === '') return '';
    return guardedWrite(path.join(dir, stage), 'summary.md', renderStageMarkdown(state, stage));
  }

  async function writePlanFile(ctxArg, state, agent) {
    const dir = exploreDirOf(state, ctxArg, agent);
    if (dir === '') return '';
    return guardedWrite(dir, 'plan.md', buildPlan(state));
  }
}
