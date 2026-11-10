/**
 * 主厨 · Master Agent —— 常驻左侧栏的总调度入口。
 *
 * ## 为什么用插件而不是声明式 preset 行
 *
 * 本 harness 的 preset 机制是 `dsh-agent-preset-registry`（内联注册表）。
 * 声明式写法 `- id: preset-xxx / name: '@deepseek-ai/dsh-agent-preset'` 依赖
 * `dsh-agent-preset` 插件的 `[Service.init]` 去调 `agentPresets.register()`。
 * 实测该路径下 `definitions.size === 0`（一个 preset 都没注册上），
 * 而 UI 仍显示 4 个内置项 —— 说明那条路在本环境不可靠。
 *
 * 本插件改走**直接调用服务 API**：
 *
 *     ctx.agentPresets.register({ id, name, description, order, plugins })
 *
 * 这正是 `dsh-agent-preset` 内部做的事（其 `[Service.init]` 只有一行 register）。
 * 自己调用有三个好处：
 *   ① 时机可控（等 agentPresets 就绪再注册）；
 *   ② 失败能打日志（声明式那条是静默 broken）；
 *   ③ 不依赖另一个包的 Service.init 行为。
 */
export const name = 'dsh-chef';
export const inject = ['agentPresets'];

/** 主厨的人格。零产品耦合：不绑任何业务领域、不引用外部服务。 */
const MASTER_PREFIX = [
  '你是**主厨**（Master Agent）。你不是干活的，你是决定**谁去干、干到什么程度算完**的那个人。',
  '',
  '## 你的产出',
  '不是代码，不是文档，是**三样东西**：',
  '1. **一个拆开的活** —— 每块有明确输入、输出、验收判据。',
  '2. **派出去的人** —— 每块交给谁、给什么上下文、给什么写盘范围。',
  '3. **一个诚实的汇总** —— 谁交了、谁没交、哪些真做完、哪些只是看起来做完。',
  '',
  '## 三条不可退让',
  '1. **不自己下场干领域活。** 你能做不代表你该做。你一旦开始写代码，就没人管整条链了 ——',
  '   而链断了比某块写得差更致命。',
  '2. **不验收没验过的东西。** 子 agent 说"完成了"不等于完成。去看产物：',
  '   文件在不在、能不能跑、数字对不对。',
  '3. **不把推断当结论。** 没验证的标"未验证"；取不到的说取不到。',
  '',
  '## 拆活',
  '- 先问：**这件事最小可验证的一步是什么？** 从那里开始，别一上来铺全景。',
  '- 拆到「一件事 = 一个子 agent 一次能干完」为止。',
  '- 每个子 agent 的 prompt 必须自包含 —— 它看不到你的上下文。',
  '- 有写操作时必须给**写盘范围**，否则子 agent 会到处写。',
  '- 「活够不够具体」直接决定成败：派得好的子 agent 平均干 78 次工具调用，派空的只有 37 次。',
  '',
  '## 派活',
  '- 独立可并行 → 一条消息里同时派，别串行等。',
  '- 有依赖 → 用依赖关系串，不靠"我猜它做完了"。',
  '- 派完**不要空转等待**。没事干就结束这一轮，事件会唤醒你。',
  '- 禁止用 sleep / 反复 list_agents 等后台任务 —— 那是打转不是推进。',
  '- 已知上限：subagent 最大深度 3 层、Team 成员最多 8 个。',
  '',
  '## 你最容易犯的错',
  '1. **自己动手。** 因为快、因为省事、因为"就一小块"。这是最危险的失效模式。',
  '2. **假验收。** 看到"已完成"就汇总，不去看产物。',
  '3. **汇总失实。** 把"部分完成"写成"完成"，把"未验证"写成"已验证"。',
  '',
  '## 停点',
  '- 需求有歧义 → 先问，不猜。',
  '- 要花钱 / 不可逆 / 动生产 → 停下来要人确认。',
  '- 交付与验收判据对不上 → 打回去，不将就。',
  '- 你想动手干领域活 → 停，这是越界。',
  '',
  '## 一句话',
  '你的价值不在于你做得多好，在于**整条链没有断，且你对每条链的状态说的都是真的**。',
].join('\n');

/**
 * 平台相关的 shell 工具选择。
 *
 * ⚠ **这里踩过一个坑，别改回字符串写法。**
 *
 * 最初的写法是从 profile 的 YAML 里照抄过来的：
 *
 *     { id: 'tool-pwsh', name: '...', disabled: '!!js process.platform !== "win32"' }
 *
 * 看起来对，实际**导致主厨在 Windows 上永远没有 pwsh**。根因在
 * `dsh-agent-preset-registry/lib/index.js:267-274`：
 *
 *     function disabledContribution(value, evaluateExpression) {
 *       if (isJsExpr(value)) try { return Boolean(evaluateExpression(value.__jsExpr)); }
 *                            catch { return 'conditional'; }
 *       return Boolean(value);          // ← 非 !!js 节点走这里
 *     }
 *
 * `!!js` 在 YAML 里是**标签**，解析后是个带 `__jsExpr` 的对象；
 * 但在 JS 里写 `'!!js ...'` 只是一个**普通字符串**——`isJsExpr` 为假，
 * 于是 `Boolean('!!js process.platform !== "win32"')` === **true**，
 * 条件恒为“禁用”。字符串非空就恒真，跟平台无关。
 *
 * 所以这里必须给**真正的布尔值**：Windows 上 pwsh 启用、bash 禁用，反之亦然。
 * 判据放在构建期（本文件在宿主进程里执行），不需要运行期求值。
 *
 * 代价：这个判断在插件加载时求值一次，不支持“同一进程内跨平台切换”——
 * 那本来也不是真实场景（一个 DSH 进程只跑在一个平台上）。
 */
const IS_WIN = process.platform === 'win32';

/** 主厨的 composition：零产品耦合，全用官方包。 */
function masterPlugins() {
  return [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: MASTER_PREFIX } },
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
    // ★ 调度者的 shell：它必须能自己去看产物、跑验证，而不是只转述子 agent 的话。
    //   disabled 用真布尔值（见上方注释），绝不写 '!!js ...' 字符串。
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: IS_WIN },
    { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: !IS_WIN },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
    // 定时/唤醒 —— 主厨的「自动」只能靠它。缺了它，主厨连「过 10 分钟再看一眼」都做不到，
    // 更谈不上无人值守。旧 dispatcher 有这个，主厨第一版漏了。
    { id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' },
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
    { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
    { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
    {
      id: 'compaction', name: 'cordis:group', group: true,
      isolate: { compaction: true, toolResultPruner: true },
      config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        {
          id: 'tool-result-pruner',
          name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
          config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
        },
      ],
    },
    {
      id: 'delegation', name: 'cordis:group', group: true,
      // ⚠ `isolate.workflowEngine` 会开一个**空的工作流引擎域**。
      //   域里必须有人 register 一个 provider，否则 `tool-workflow` 会一直
      //   waiting for workflowEngine → 整个 preset 变 broken → 被 UI 过滤掉。
      //   这就是我第一版 dispatcher 在界面上不出现的真正原因（探针实测
      //   `broken=tool-workflow: waiting for workflowEngine`）。
      //   官方 standard / ptc / cordis 都在同一组里先放 `workflow-ptc`。
      isolate: { workflowEngine: true },
      config: [
        { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
        {
          id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent',
          config: {
            provider: 'spawn',
            toolName: 'subagent',
            modelSelection: true,
            modelDiscovery: true,
            maxDepth: 3,
            /**
             * 让主厨能把活**派给对的 agent**，而不是只能派「另一个自己」。
             *
             * 机制（`dsh-tool-subagent/lib/index.js:201-256`）：
             *   · 不配 → 工具参数里没有 `agent_preset`，子 agent **只能继承父的 preset**；
             *   · 配了 → 参数里出现 `agent_preset`，模型可从中挑一个。
             * 前提是 `ctx.get('agentPresets')` 存在（已满足），且 provider 支持
             * `capabilities.agentPreset`——`spawn` 支持（`dsh-subagent-spawn-in-process:21-27`，
             * `inheritsParentContext = false`）。若换成进程外 provider，会因 NO_START_CAPABILITIES
             * 直接抛 `UNSUPPORTED_CAPABILITY`，不会静默忽略。
             *
             * ⚠ **不列 master 自己**：调度者派调度者会无限递归。
             *
             * ⚠ **配置错的后果是 preset 整个消失，不是报错**：
             *   `validate()` 会遍历这份名单逐个 `readDocument(id)`，
             *   而 `readDocument` 对不存在的 id 是 **reject** 不是返回空
             *   （`dsh-agent-preset-registry/lib/index.js:613-618`）。
             *   任一 id 不存在 → validate 抛错 → preset 变 broken →
             *   UI 端 `filter(broken === void 0)` 直接过滤掉，**界面上什么都不显示**。
             *   所以加新 id 前，必须确认它真的注册了。
             *
             * 名单构成：
             *   · standard / ptc / minimal / cordis —— DSH 内置，由
             *     `dsh-web-app/package.json:48-54` 的 bundle patch 提供，必然存在
             */
            allowedAgentPresets: ['standard', 'ptc', 'minimal', 'cordis'],
          },
        },
        {
          id: 'tool-subagent-fork', name: '@deepseek-ai/dsh-tool-subagent',
          config: { provider: 'fork', toolName: 'subagent_fork' },
        },
        // ★ 工作流引擎 provider —— 缺了它 tool-workflow 就是死的
        { id: 'workflow-ptc', name: '@deepseek-ai/dsh-workflow-ptc', config: { provider: 'spawn' } },
        { id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow' },
        { id: 'tool-ralph', name: '@deepseek-ai/dsh-tool-ralph', config: { subagentProvider: 'spawn', maxRounds: 64 } },
      ],
    },
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
    { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
  ];
}

export function apply(ctx) {
  ctx.inject(['agentPresets'], async (c) => {
    const reg = c.get('agentPresets');
    if (!reg) {
      console.error('[master] agentPresets 服务拿不到 —— 主厨无法注册');
      return;
    }

    /**
     * 注册一个 preset，失败只记日志不抛出。
     *
     * 为什么 try/catch 分开：一个 preset 坏了不应该拖垮另一个。
     * 但**必须打日志**——registry 的 activate() 对 broken 只 logger.warn，
     * UI 端又 filter(broken === void 0) 直接过滤，用户只会看到「它不见了」。
     * 这里至少留下可查的痕迹。
     */
    const tryRegister = async (def) => {
      try {
        const dispose = await reg.register(def);
        console.log(`[master] preset "${def.id}" 注册成功`);
        c.effect(() => dispose);
        return true;
      } catch (e) {
        console.error(`[master] preset "${def.id}" 注册失败:`, e && e.message ? e.message : String(e));
        return false;
      }
    };

    await tryRegister({
      id: 'master',
      name: '主厨 · Master Agent',
      description: '常驻的总调度：拆活、派活、验收、汇总。不干活，只管链。',
      order: 0,
      plugins: masterPlugins(),
    });

  });
}

/* 旧的单次注册写法已删除（2026-11-05）。
 *
 * 它只注册 master 一个 preset，无法承载多个。改成 tryRegister() 之后
 * 保留一份死代码只会让后人困惑「到底哪个在跑」——这正是 README 里
 * 反复踩过的坑（「定义了但没渲染」「配置对但不生效」）。
 */
