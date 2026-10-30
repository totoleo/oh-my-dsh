/**
 * 许愿模式（Wish Mode）—— Web Client half (v2).
 *
 * Adds two ambient surfaces below the composer, both read-only:
 *   - a compact toggle chip in the composer tool row (`conversation.input.left`)
 *   - a four-rung progress strip below the composer (`conversation.composer.dock`)
 *
 * v2 splits the four levels into two working modes: 高度 is pure dialogue, while
 * 深度/广度/速度 run plugin-managed `goal` iterations up to that level's ceiling.
 * The client therefore reads two projections:
 *
 *   - `wish` (SPEC §7):
 *       { active, topic, slug, stage, done, steps,
 *         confirmed:{4}, reviewed:{4}, summaries:{4}, ceilings:{4}, exploreDir }
 *   - `goal` (nullable): { goal: { objective, phase, maxGoalRounds }, roundsStarted }
 *
 * The projection has no `phase` field: the client derives it with the same rule
 * as the host (confirmed → reviewed → idle / talking / exploring, SPEC §2) and
 * then overlays the live goal phase (blocked / paused) for the current level.
 *
 * Every read is feature-detected: a missing projection or goal never throws and
 * the chip still toggles the mode through `/wish`.
 */
window.__ModuleLoader__.load({
  id: '@totoleo/dsh-wish-mode',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'wish-mode';
    const PROJECTION_KEY = 'wish';
    const GOAL_PROJECTION_KEY = 'goal';
    /** Goal ownership marker (§4.1: objectives start with `[wish-<stage>] `). */
    const GOAL_PREFIX = '[wish-';
    const STAGES = ['altitude', 'depth', 'range', 'speed'];

    const zh = {
      'chip.inactive': '许愿',
      'chip.active': '许愿',
      'chip.title': '进入或退出许愿模式（高度 → 深度 → 广度 → 速度）',
      'chip.busy': '切换中…',
      'chip.error': '切换许愿模式失败',
      'dock.title': '许愿',
      'dock.hint': '先确认为什么做，再确认怎么做',
      'dock.complete': '四层已确认',
      'dock.round': '第 {round}/{max} 轮',
      'stage.altitude': '高度',
      'stage.depth': '深度',
      'stage.range': '广度',
      'stage.speed': '速度',
      'phase.talking': '对话中',
      'phase.exploring': '探索中',
      'phase.reviewing': '待你确认',
      'phase.confirmed': '已确认',
      'phase.blocked': '已暂停',
      'phase.paused': '已暂停',
      'phase.idle': '未开启',
    };

    const en = {
      'chip.inactive': 'Wish',
      'chip.active': 'Wish',
      'chip.title': 'Enter or leave wish mode (altitude → depth → range → speed)',
      'chip.busy': 'Switching…',
      'chip.error': 'Failed to toggle wish mode',
      'dock.title': 'Wish',
      'dock.hint': 'Wish it, then prove it',
      'dock.complete': 'All four levels confirmed',
      'dock.round': 'round {round}/{max}',
      'stage.altitude': 'Altitude',
      'stage.depth': 'Depth',
      'stage.range': 'Range',
      'stage.speed': 'Speed',
      'phase.talking': 'Discussing',
      'phase.exploring': 'Exploring',
      'phase.reviewing': 'Awaiting your confirmation',
      'phase.confirmed': 'Confirmed',
      'phase.blocked': 'Paused',
      'phase.paused': 'Paused',
      'phase.idle': 'Not started',
    };

    /** Wishbone W: W for Wish — three bone knobs on the top tips. */
    function glyph() {
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 16 16',
          'aria-hidden': true,
          style: { flex: 'none', display: 'block' },
        },
        h('path', {
          d: 'M2.9 3.4 5.4 12.6 8 3.4 10.6 12.6 13.1 3.4',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2.05,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 2.9, cy: 3.4, r: 1.3, fill: 'currentColor' }),
        h('circle', { cx: 8, cy: 3.4, r: 1.3, fill: 'currentColor' }),
        h('circle', { cx: 13.1, cy: 3.4, r: 1.3, fill: 'currentColor' }),
      );
    }

    function stageLabel(t, stage) {
      return t('stage.' + (STAGES.indexOf(stage) >= 0 ? stage : 'altitude'));
    }

    /** Plain-object guard for the projection's fixed-key maps. */
    function asMap(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }

    /** Current level from the projection, or `altitude` while the projection is absent. */
    function stageOf(state) {
      if (state === null || typeof state !== 'object') return 'altitude';
      return STAGES.indexOf(state.stage) >= 0 ? state.stage : 'altitude';
    }

    /** All four levels confirmed — prefer the host-computed flag when present. */
    function isDone(state) {
      if (state === null || typeof state !== 'object') return false;
      if (state.done === true) return true;
      const confirmed = asMap(state.confirmed);
      return STAGES.every((stage) => confirmed[stage] === true);
    }

    /**
     * Stage encoded in the plugin-owned goal objective (`[wish-<stage>] ...`).
     * Returns `''` when the goal projection is absent, malformed, or owned by
     * someone else (the user's own goal must not affect the UI).
     */
    function goalStageOf(projection) {
      if (projection === null || typeof projection !== 'object') return '';
      const goal = projection.goal;
      if (goal === null || typeof goal !== 'object') return '';
      const objective = typeof goal.objective === 'string' ? goal.objective : '';
      if (objective.slice(0, GOAL_PREFIX.length) !== GOAL_PREFIX) return '';
      for (const stage of STAGES) {
        if (objective.indexOf(GOAL_PREFIX + stage + '] ') === 0) return stage;
      }
      return '';
    }

    /** Next round / round cap of the current goal, or null when unavailable. */
    function goalRoundsOf(projection) {
      if (projection === null || typeof projection !== 'object') return null;
      const goal = projection.goal;
      if (goal === null || typeof goal !== 'object') return null;
      const max = Number.isSafeInteger(goal.maxGoalRounds) && goal.maxGoalRounds > 0 ? goal.maxGoalRounds : null;
      if (max === null) return null;
      const started = Number.isSafeInteger(projection.roundsStarted)
        ? projection.roundsStarted
        : Number.isSafeInteger(goal.roundsStarted)
          ? goal.roundsStarted
          : 0;
      const round = Math.min(started + 1, max);
      return { round: round < 1 ? 1 : round, max };
    }

    /**
     * Client-side phase, mirroring SPEC §2 and overlaying the live goal phase.
     * Only an `exploring` current level can be blocked or paused; a goal owned
     * by another level is ignored.
     */
    function phaseOf(state, goalProjection) {
      if (state === null || typeof state !== 'object') return 'idle';
      const stage = stageOf(state);
      const confirmed = asMap(state.confirmed);
      const reviewed = asMap(state.reviewed);
      if (confirmed[stage] === true) return 'confirmed';
      if (reviewed[stage] === true) return 'reviewing';
      if (state.active !== true) return 'idle';
      if (stage === 'altitude') return 'talking';
      if (goalStageOf(goalProjection) === stage) {
        const phase = goalProjection.goal.phase;
        if (phase === 'blocked') return 'blocked';
        if (phase === 'paused') return 'paused';
      }
      return 'exploring';
    }

    /**
     * Round progress for the current level, shown only while its own goal is
     * actively iterating (SPEC §10: `第 {roundsStarted + 1}/{maxGoalRounds} 轮`).
     */
    function explorationRoundsOf(state, goalProjection) {
      if (state === null || typeof state !== 'object' || state.active !== true) return null;
      const stage = stageOf(state);
      if (stage === 'altitude') return null;
      if (goalStageOf(goalProjection) !== stage) return null;
      const goal = goalProjection.goal;
      if (goal === null || typeof goal !== 'object' || goal.phase !== 'active') return null;
      return goalRoundsOf(goalProjection);
    }

    /**
     * Composer toggle. The projections are the host-computed truth; when they
     * are unavailable the chip still toggles, it just cannot show the phase.
     */
    function WishChip({ useProjection, t, toggle }) {
      const state = useProjection(PROJECTION_KEY);
      const goalProjection = useProjection(GOAL_PROJECTION_KEY);
      const [busy, setBusy] = React.useState(false);
      const [hover, setHover] = React.useState(false);
      const [error, setError] = React.useState(null);

      const active = !!(state && state.active === true);
      const stage = stageOf(state);
      const phase = phaseOf(state, goalProjection);
      const label = active
        ? t('chip.active') + ' · ' + stageLabel(t, stage) + ' ' + t('phase.' + phase)
        : t('chip.inactive');

      const background = busy
        ? 'transparent'
        : active
          ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent)'
          : hover
            ? 'var(--dsw-alias-bg-layer-2)'
            : 'transparent';
      const color = active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)';

      const onClick = async () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
          const failure = await toggle();
          if (typeof failure === 'string') setError(failure !== '' ? failure : t('chip.error'));
        } catch (cause) {
          setError(cause && cause.message ? String(cause.message) : String(cause));
        } finally {
          setBusy(false);
        }
      };

      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 } },
        h(
          'button',
          {
            type: 'button',
            disabled: busy,
            title: error || t('chip.title'),
            'aria-pressed': active,
            'aria-label': busy ? t('chip.busy') : label,
            onClick,
            onMouseEnter: () => setHover(true),
            onMouseLeave: () => setHover(false),
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              height: 28,
              padding: '0 8px',
              border: 'none',
              borderRadius: 6,
              cursor: busy ? 'default' : 'pointer',
              font: 'inherit',
              fontSize: 13,
              fontWeight: 500,
              lineHeight: '20px',
              background,
              color,
              opacity: busy ? 0.6 : 1,
              whiteSpace: 'nowrap',
              minWidth: 0,
            },
          },
          glyph(),
          h(
            'span',
            { style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
            busy ? t('chip.busy') : label,
          ),
        ),
        error
          ? h(
              'span',
              {
                role: 'alert',
                style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, lineHeight: '18px' },
              },
              error,
            )
          : null,
      );
    }

    /** Four-rung progress strip, visible only while the mode is active. */
    function WishDock({ useProjection, t }) {
      const state = useProjection(PROJECTION_KEY);
      const goalProjection = useProjection(GOAL_PROJECTION_KEY);
      if (!state || state.active !== true) return null;

      const confirmed = asMap(state.confirmed);
      const done = isDone(state);
      const stage = stageOf(state);
      const phase = phaseOf(state, goalProjection);
      const rounds = phase === 'exploring' ? explorationRoundsOf(state, goalProjection) : null;
      const slug = typeof state.slug === 'string' ? state.slug.trim() : '';
      const exploreDir = typeof state.exploreDir === 'string' ? state.exploreDir : '';

      const phaseText =
        rounds === null
          ? t('phase.' + phase)
          : t('phase.exploring') + ' · ' + t('dock.round', { round: rounds.round, max: rounds.max });
      const currentPhase = phaseText === '' ? null : phaseText;

      return h(
        'div',
        {
          role: 'group',
          'aria-label': t('dock.title'),
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
            padding: '2px 2px 4px',
            fontSize: 12,
            lineHeight: '18px',
            color: 'var(--dsw-alias-label-secondary)',
          },
        },
        h(
          'span',
          { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } },
          t('dock.title'),
        ),
        h(
          'span',
          { style: { display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          STAGES.map((rung) => {
            const isConfirmed = confirmed[rung] === true;
            const isCurrent = !done && stage === rung;
            const rungColor = isConfirmed
              ? 'var(--dsw-alias-state-success-primary)'
              : isCurrent
                ? 'var(--dsw-alias-brand-primary)'
                : 'var(--dsw-alias-label-secondary)';
            return h(
              'span',
              {
                key: rung,
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 3,
                  color: rungColor,
                  fontWeight: isCurrent ? 600 : 400,
                  whiteSpace: 'nowrap',
                },
              },
              h('span', { 'aria-hidden': true }, isConfirmed ? '✓' : isCurrent ? '●' : '○'),
              stageLabel(t, rung),
              isCurrent && currentPhase !== null
                ? h(
                    'span',
                    {
                      style: {
                        color: 'var(--dsw-alias-label-tertiary)',
                        fontWeight: 400,
                      },
                    },
                    '· ' + currentPhase,
                  )
                : null,
            );
          }),
        ),
        slug !== ''
          ? h(
              'span',
              {
                title: exploreDir !== '' ? exploreDir : 'wishes/' + slug + '/',
                style: {
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                  fontSize: 11,
                  color: 'var(--dsw-alias-label-tertiary)',
                  whiteSpace: 'nowrap',
                },
              },
              'wishes/' + slug + '/',
            )
          : null,
        h('span', null, done ? t('dock.complete') : t('dock.hint')),
      );
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'wish-mode: zh dictionary');
      ctx.effect(() => ctx.locale.register(NS, 'en', en), 'wish-mode: en dictionary');

      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: 'wish-mode-toggle',
            order: 20,
            locale: NS,
            inject: (sessionId) => ({
              toggle: async () => {
                const result = await ctx.remote.commands.execute(sessionId, '/wish', []);
                if (result && result.ok === false) {
                  const error = result.error || {};
                  return error.message ? String(error.message) : '';
                }
                return null;
              },
            }),
          },
          WishChip,
        ),
      );

      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.composer.dock',
            id: 'wish-mode-progress',
            order: 2,
            locale: NS,
          },
          WishDock,
        ),
      );
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.commands'],
      apply,
    };
  },
});

/* rev: 2026-10-30T01-20 */
