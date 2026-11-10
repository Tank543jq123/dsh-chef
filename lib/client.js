/**
 * `dsh-chef` 的**客户端半** —— 左侧栏常驻的「主厨」入口。
 *
 * ## 为什么是手写 CJS
 *
 * 手册已明确：DSH client 插件**必须**是手写 CommonJS 闭包，
 * 走 `window.__ModuleLoader__.load({ id, factory })`，并在模块内显式
 * `exports.apply` / `exports.inject`。不能是打包器输出的 ESM。
 *
 * 代价（实测）：
 *   · 没有 JSX —— 必须直接调 `jsx(...)` / `jsxs(...)`
 *   · 没有 import —— 用 factory 注入的 `require`
 *
 * ## 落点：为什么是 `sidebar.panellist`
 *
 * 手册有一条关键约束：**DSH 官方没有「可插入左栏内容区」的槽位**。
 * `sidebar` 是 kind:single，被 ui-sidebar 独占；`sidebar.workspaces` 被
 * ui-workspace 占用。唯一能"永久显示在左侧"的官方槽位是
 * `sidebar.panellist`（kind:list，可叠加）—— 它放的是**图标/入口行**。
 *
 * 所以本插件的形态是：**侧栏一行常驻入口 + 主区一个面板**。
 * 这正是手册建议的「图标 + main 主面板两处联动」。
 *
 * ## 两处注册的 id / key 必须一致
 *
 * `sidebar.panellist` 的 `id` 与 `main` 的 `key` 必须相同，
 * 否则点击导航行会抛 `main panel "X" is not registered`
 * （`dsh-client-ui-layout/lib/client.js:412-415`）。
 * 这里用同一个常量 `PANEL_ID`，结构上不可能不一致。
 */

window.__ModuleLoader__.load({
  id: 'dsh-chef',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const jsxRuntime = require('react/jsx-runtime');
    const jsx = jsxRuntime.jsx;
    const jsxs = jsxRuntime.jsxs;

    /** 面板 id —— panellist 的 id 与 main 的 key 共用这一个常量。 */
    const PANEL_ID = 'master-chef';

    /**
     * 配色：全部**继承主题**，只用 currentColor / transparent 做 fallback。
     *
     * ⚠ 这是踩过的坑（Hard is 项目实测）：以前写死深色主题值，
     *   一旦实例跑浅色主题就「深色字压浅色底」，对比度 1.13:1，等于隐形。
     *   所以这里不写任何具体色值，只靠继承。
     */
    const C = {
      ink: 'currentColor',
      dim: 'color-mix(in srgb, currentColor 62%, transparent)',
      line: 'color-mix(in srgb, currentColor 18%, transparent)',
      soft: 'color-mix(in srgb, currentColor 8%, transparent)',
    };

    /* ─────────────────────────── 图形 ─────────────────────────── */

    /**
     * 侧栏图标：一口锅 + 热气。
     * 用 currentColor 描边，自动跟随侧栏文字色。
     */
    function ChefGlyph() {
      return jsxs('svg', {
        width: 20,
        height: 20,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        children: [
          // 锅体
          jsx('path', { d: 'M3.5 10.5h17a1 1 0 0 1 1 1v1.2a5.8 5.8 0 0 1-5.8 5.8H8.3a5.8 5.8 0 0 1-5.8-5.8v-1.2a1 1 0 0 1 1-1Z' }),
          // 锅盖把手
          jsx('path', { d: 'M9 10.5V9a3 3 0 0 1 6 0v1.5' }),
          // 热气两缕
          jsx('path', { d: 'M9.2 5.6c.7-.7.7-1.6 0-2.3' }),
          jsx('path', { d: 'M14.8 5.6c.7-.7.7-1.6 0-2.3' }),
        ],
      });
    }

    /* ─────────────────────────── 主面板 ─────────────────────────── */


    function MasterPanel(props) {
      const ctx = props && props.ctx;
      const rows = [
        {
          k: '拆活',
          v: '把目标拆成「一件事 = 一个子 agent 一次能干完」，每块带输入/输出/验收判据。',
        },
        {
          k: '派活',
          v: '会派子 agent，独立可并行的同时派，有依赖的按关系串。最大 3 层深度、8 个成员。',
        },
        {
          k: '验收',
          v: '不信「已完成」。自己去看产物：文件在不在、能不能跑、数字对不对。',
        },
        {
          k: '汇总',
          v: '诚实报账：谁交了、谁没交、哪些真做完、哪些只是看起来做完。',
        },
      ];

      return jsxs('div', {
        style: {
          padding: '28px 32px',
          maxWidth: '760px',
          color: C.ink,
          fontFamily: 'inherit',
          lineHeight: 1.75,
        },
        children: [
          jsxs('div', {
            style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' },
            children: [
              jsx('span', {
                style: {
                  display: 'inline-grid',
                  placeItems: 'center',
                  width: '34px',
                  height: '34px',
                  borderRadius: '9px',
                  background: C.soft,
                  border: '1px solid ' + C.line,
                },
                children: jsx(ChefGlyph, {}),
              }),
              jsx('h1', {
                style: { fontSize: '20px', fontWeight: 750, margin: 0, letterSpacing: '-0.01em' },
                children: '主厨 · Master Agent',
              }),
            ],
          }),

          jsx('p', {
            style: { margin: '0 0 22px', color: C.dim, fontSize: '13.5px' },
            children:
              '常驻的总调度。它不干活 —— 它决定谁去干、干到什么程度算完。永远只有一个主厨会话。',
          }),

          jsx('div', {
            style: {
              border: '1px solid ' + C.line,
              borderRadius: '10px',
              overflow: 'hidden',
              marginBottom: '22px',
            },
            children: rows.map((r, i) =>
              jsxs(
                'div',
                {
                  style: {
                    display: 'grid',
                    gridTemplateColumns: '72px 1fr',
                    gap: '14px',
                    padding: '12px 16px',
                    borderTop: i === 0 ? 'none' : '1px solid ' + C.line,
                    fontSize: '13px',
                  },
                  children: [
                    jsx('span', { style: { fontWeight: 700 }, children: r.k }),
                    jsx('span', { style: { color: C.dim }, children: r.v }),
                  ],
                },
                r.k,
              ),
            ),
          }),

          jsxs('div', {
            style: {
              padding: '14px 16px',
              borderRadius: '10px',
              background: C.soft,
              border: '1px solid ' + C.line,
              fontSize: '12.5px',
              color: C.dim,
            },
            children: [
              jsx('div', { style: { fontWeight: 700, color: C.ink, marginBottom: '6px' }, children: '它不做什么' }),
              jsx('div', { children: '不自己下场干领域活 · 不虚构结果 · 不替你做产品/风险决策' }),
              jsx('div', {
                style: { marginTop: '10px' },
                children:
                  '要开一个主厨会话：在新建会话的 preset 里选「主厨 · Master Agent」。',
              }),
            ],
          }),

          /* ── 单对话：手动归档其它会话 ──────────────────────────────
           *
           * 为什么是按钮而不是自动：
           *   自动归档会在你不知情时让上一个会话从列表消失。归档可逆，
           *   但它改变了你看到的东西 —— 这种改动应当由你按下。
           *
           * 这与 DSH 已有行为配合：
           *   · createInWorkspace 只复用 blank 会话，反复进出不堆会话
           *   · sessionVisible 隐藏「非当前」的 blank 会话
           *   所以真正会堆积的只有「发过消息的会话」，本按钮正是清它。
           */
          jsx(ArchiveControls, { ctx: ctx }),
        ],
      });
    }


    function ArchiveControls(props) {
      const ctx = props && props.ctx;
      const [busy, setBusy] = react.useState(false);
      const [note, setNote] = react.useState(null);

      const archiveOthers = async () => {
        setBusy(true);
        setNote(null);
        try {
          const sessions = ctx && ctx.get ? ctx.get('sessions') : undefined;
          const workspaces = ctx && ctx.get ? ctx.get('workspaces') : undefined;
          if (!sessions || !workspaces) throw new Error('会话/工作区服务不可达');

          const snap = sessions.list.getSnapshot();
          const ids = (snap && snap.ids) || [];
          const byId = (snap && snap.byId) || {};
          if (ids.length === 0) {
            setNote({ ok: true, msg: '没有会话' });
            return;
          }

          /**
           * 「当前会话」的权威判据。
           *
           * ⚠ 不能用 `snap.current` —— **list 快照里没有这个字段**。
           *   projectList() 只写了 ids / byId / phase（见
           *   dsh-api-session-controller/lib/client.js:4144-4180）。
           *   第一次实现就是因为取 snap.current 拿到 undefined，
           *   点击后报「当前没有活动会话」。
           *
           * 官方自己的取法（dsh-client-ui-workspace/lib/client.js:866-868）：
           *
           *     function mainSessionId(list) {
           *       return Object.values(list.byId)
           *         .find((s) => (s.retainedBy.mainView ?? 0) > 0)?.id;
           *     }
           *
           * 即「主视图正在保留的那一条」。这里照抄这个判据。
           */
          const current = Object.values(byId).find(
            (s) => s && s.retainedBy && (s.retainedBy.mainView ?? 0) > 0,
          )?.id;

          if (!current) {
            throw new Error('找不到当前会话（retainedBy.mainView 全为 0）');
          }

          const targets = ids.filter((id) => id !== current);
          if (targets.length === 0) {
            setNote({ ok: true, msg: '只有一条会话，无需归档' });
            return;
          }

          /**
           * ⚠ 必须逐条容错，不能一个失败就整体中断。
           *
           * 服务端行为（`dsh-api-workspace-controller/lib/index.js:291-302`）：
           * 会话还有**正在跑的活动**时，不带 `stopActivity` 会被拒绝，抛
           * `workspace/session-active`。原实现是裸 for 循环 + 外层 try/catch，
           * 一旦撞上这种会话就整批停下 —— **前面已归档的不回滚，后面的一条不动**，
           * 用户看到"归档失败"，实际是半成品状态。这种"静默半完成"最难排查。
           *
           * 现在：每条单独 try；失败的收集后一起报；成功的照常算数。
           */
          let done = 0;
          const failed = [];
          for (const id of targets) {
            try {
              await workspaces.archiveSession(id);
              done += 1;
            } catch (e) {
              failed.push({ id, msg: (e && e.message) || String(e) });
            }
          }

          if (failed.length === 0) {
            setNote({ ok: true, msg: `已归档 ${done} 条其它会话` });
          } else {
            const first = failed[0];
            setNote({
              ok: false,
              msg:
                `已归档 ${done} 条，${failed.length} 条失败` +
                `（首条：${first.id.slice(0, 8)}… ${first.msg})`,
            });
          }
        } catch (e) {
          setNote({ ok: false, msg: (e && e.message) || String(e) });
        } finally {
          setBusy(false);
        }
      };

      return jsxs('div', {
        style: {
          marginTop: '16px',
          padding: '14px 16px',
          borderRadius: '10px',
          border: '1px dashed ' + C.line,
          fontSize: '12.5px',
          color: C.dim,
        },
        children: [
          jsx('div', { style: { fontWeight: 700, color: C.ink, marginBottom: '6px' }, children: '单对话' }),
          jsx('div', {
            children:
              'DSH 本就复用 blank 会话，反复进出不堆会话。真正会留下的是「发过消息的会话」—— 需要时可以一键归档掉除当前之外的全部。',
          }),
          jsxs('div', {
            style: { marginTop: '10px', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
            children: [
              jsx('button', {
                type: 'button',
                disabled: busy,
                onClick: archiveOthers,
                style: {
                  font: 'inherit',
                  fontSize: '12.5px',
                  padding: '6px 14px',
                  borderRadius: '7px',
                  border: '1px solid ' + C.line,
                  background: 'transparent',
                  color: C.ink,
                  cursor: busy ? 'default' : 'pointer',
                  opacity: busy ? 0.55 : 1,
                },
                children: busy ? '归档中…' : '归档其它会话',
              }),
              note
                ? jsx('span', {
                    style: { color: note.ok ? 'inherit' : '#c0392b', fontSize: '12px' },
                    children: note.msg,
                  })
                : null,
            ],
          }),
          jsx('div', {
            style: { marginTop: '8px', fontSize: '11.5px' },
            children: '归档是可逆的：侧栏「显示已归档」里可以恢复。',
          }),
        ],
      });
    }

    /* ─────────────────────────── 注册 ─────────────────────────── */

    const inject = ['slots'];

    function apply(ctx) {
      // ① 左侧栏常驻入口行
      //    sidebar.panellist 是 kind:list（ui-sidebar:387-390），可叠加，不会抢别人的位置。
      //    侧栏只读 options 的 id / order / label，组件渲染为行内图标（:346-353）。
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 5, label: '主厨' },
          ChefGlyph,
        ),
      );

      // ② 主区面板 —— key 必须等于上面的 id（同一个常量保证）
      //
      // ⚠ 必须**闭包绑定 ctx**：`main` 槽位的组件由宿主渲染，它只传自己的 props
      //   （如 `{ active }`），**不会**把插件 ctx 传进来。
      //   直接注册裸组件会让面板里 `ctx === undefined` → 归档按钮报「服务不可达」，
      //   而且**不崩溃**，只是功能静默失效 —— 这种降级最难排查。
      const BoundPanel = () => jsx(MasterPanel, { ctx });
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID }, BoundPanel),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});