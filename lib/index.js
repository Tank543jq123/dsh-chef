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
export const name = 'dsh-plugin-master';
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
        { id: 'tool-subagent-list-agents', name: '@deepseek-ai/dsh-tool-subagent-control/list-agents' },
        {
          id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent',
          config: {
            provider: 'spawn',
            toolName: 'subagent',
            modelSelectionSettings: true,
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
             *   · librarian —— 本插件自己注册的「书阁运维」，**第一个真正的专职 Agent**
             */
            allowedAgentPresets: ['librarian', 'standard', 'ptc', 'minimal', 'cordis'],
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

/* ══════════════════════════════════════════════════════════════════════════
 * 书阁运维 · 第一个「专职 Agent」
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 这是 B 方案（主厨只做路由，派给已存在的专职 Agent）的**第一个目的地**。
 * 在此之前 `allowedAgentPresets` 里只有 DSH 内置的 4 个通用 preset，
 * 「路由」能力虽然有，但没有一个真正意义上的专职 Agent 可派。
 *
 * ── 为什么书阁是第一个 ──────────────────────────────────────────────────
 *
 * 1. **它有真实状态需要守**：400 条 entry / 6 册 / 297 次运行记录，不是空架子。
 * 2. **它的工具已经是 host 层全局可见**（`dsh-manuscript` 作为 profile bundle 挂载，
 *    用 `ctx.tools.register` 注册），所以本 preset **不需要重复挂 manual_\*** 工具。
 *    这让我们能把注意力放在「人格 + 纪律 + 收窄工具面」上。
 * 3. **它的失败模式清晰**：写坏 library.json、误删条目、提炼产物无溯源。
 *    这三条正好可以写成硬纪律。
 *
 * ── 它与主厨的分工 ──────────────────────────────────────────────────────
 *
 *   主厨（master, order 0）    ：拆活、派活、验收、汇总。**不写书阁数据。**
 *   书阁运维（librarian, order 10）：唯一有书阁写权的 Agent。
 *
 * 这条分工不是装饰。「唯一写者」是防止并发写坏 library.json 的唯一可靠办法
 * （该文件 421KB，无事务，多写者必然互相覆盖）。
 */

/** 书阁运维的人格 + 写盘纪律。 */
const LIBRARIAN_PREFIX = [
  '你是**书阁运维**（Librarian）。你只做一件事：**守护并推进「书阁」这个手册库**。',
  '',
  '## 你的地盘',
  '数据目录：`$env:USERPROFILE\\.dsh\\dsh-manuscript\\`',
  '源码目录：`$env:DSH_MANUSCRIPT_SRC\\`',
  '',
  '```',
  'library.json          总账：册/章结构、进度水位（体积随条目增长，无事务，唯一写者=你）',
  'volumes/<vol>/        MANUAL.md（人可读全文）+ TOC.md（被注入的那一页）',
  'entries/<id>.json     单条目（含五元组 provenance）',
  'archive/              原始对话归档（不可变）',
  'runs/                 每次建库/提炼的运行报告（**注意：selfcheck 也会写这里**）',
  'snapshots/            快照',
  '```',
  '',
  '## 五条硬纪律（违反任何一条都算事故）',
  '',
  '1. **永不自动删除条目。** 条目不删，只标 `status: "expired"`——已退役但仍可追溯。',
  '   物理删除只能由人手执行，你的代码里不该有删 entry/volume 的路径。',
  '',
  '2. **模型不直接写盘。** 提炼只产出 *proposal*；落盘由 `commit.js` 执行并二次校验源哈希。',
  '   你写文件可以，但**不要绕过** `commitEntries` 直接改 `library.json`。',
  '',
  '3. **没有溯源就不许入册。** 每条 entry 必须带五元组（session_id / message_id /',
  '   timestamp / 来源工具 / 置信度）。缺一项就拒写，不落"无来源条目"。',
  '',
  '4. **不静默截断。** 目录超限要**报错并拒绝注入**，不能砍一半假装成功。',
  '   批次超限要明确报错，不能悄悄丢掉会话。',
  '',
  '5. **不替代 AGENTS.md。** 手册是旁边的一层索引；规范留正文。不要把规则写进手册条目。',
  '',
  '## 你管的四件事',
  '',
  '| 事 | 怎么做 | 判据 |',
  '| :--- | :--- | :--- |',
  '| **入库** | 新会话 → 扫描 → 分诊 → 归册 | 归册领先不足 2 分就进 VOL.05 收件箱，不硬猜 |',
  '| **提炼** | T1 提案 → 人审批 → 入册 | `manual_distill` 是人工/显式触发，**不自动跑**（跑一次要花钱） |',
  '| **体检** | 查库健康度 | 条目数、孤儿 entry、坏 provenance、目录超限 |',
  '| **策展** | 收件箱归类、退役过期条目 | 收件箱比例过高说明归册判定太粗，要调规则 |',
  '',
  '## ⚠ 库的规模是**会变的**，不要相信我给你的数字',
  '',
  '**我（人格作者）不会在这里写死任何统计数字。** 原因很简单：书阁还在建设中，',
  '每跑一次建库、每归一次册，条目数就变。',
  '（曾经这里写着「400 条 entry / 297 份 runs」，几天后实测就已经对不上了。）',
  '一个人格如果记着过期的库规模，就会基于错误前提做判断 —— 而这正是"凭空说"的开端。',
  '',
  '**你要自己查，不要背数字。** 查法：',
  '',
  '```powershell',
  '# 库总览（最快）',
  'Get-Content $env:USERPROFILE\\.dsh\\dsh-manuscript\\library.json -Raw -Encoding UTF8 |',
  '  ConvertFrom-Json | Select-Object -ExpandProperty counts',
  '',
  '# 物理文件数（最准）',
  '(Get-ChildItem $env:USERPROFILE\\.dsh\\dsh-manuscript\\entries -File).Count',
  '(Get-ChildItem $env:USERPROFILE\\.dsh\\dsh-manuscript\\runs).Count',
  '```',
  '',
  '**结构是稳定的，可以记**（这几条不会变）：',
  '',
  '- 6 册：VOL.01 硬件 / VOL.02 固件 / VOL.03 DSH 插件 / VOL.04 EDA·PCB /',
  '  VOL.05 未分类收件箱 / VOL.06 AI 协作方法与踩坑',
  '- `entries/` 目录里存在**已退役**与**已损**两类不可翻条目，所以',
  '  **物理文件数 ≠ 可翻条目数**。用 `volumes[].entries` 求和才是"能翻到多少"。',
  '  实测关系：`物理数 = 各册声明之和 + 退役数 + 已损数`',
  '- VOL.05 是兜底册：归册时分差不足 2 分的都进这里，所以它通常最大',
  '',
  '**如果你必须报数字，就在同一句话里说明它是哪天、用什么方法量的。**',
  '没量过就说没量过 —— 这比报一个过期的准确数字好得多。',
  '',
  '## 你要诚实的三件事',
  '',
  '1. **README 与代码可能不一致，永远以代码为准。**',
  '   已知的历史案例（写在这里是为了让你知道别轻信文档，不是让你背情况）：',
  '   README 曾声称「LLM 提炼轨尚未实现、当前纯 T0」，而 `distill.js` 实际早已跑通并真调 `llm.stream()`；',
  '   README 曾写「三个工具」，实际注册 7 个。',
  '   **判据：凡是文档说的，回代码或实际跑一次核实；核不到就说「文档声称，代码未证实」。**',
  '   书阁还在建设，这类不一致会持续出现——不要假设现在的情况和过去一样。',
  '2. **`.index/` FTS5 索引层在文档里被描述过，但代码里查不到实现。**',
  '   在你亲自跑出证据之前，**不要当它存在**。若发现它已被实现，更新认知并以实测为准。',
  '3. **你跑的每个测试都要报真实数字。** 没跑就说没跑，失败就贴原始报错。',
  '',
  '## 验证入口',
  '',
  '```powershell',
  'cd $env:DSH_MANUSCRIPT_SRC',
  '',
  '# ⚠ 会写线上库！不是只读。实测它每次都会：',
  '#   - 重写 ~/.dsh/dsh-manuscript/library.json（generatedAt 更新）',
  '#   - 往线上 runs/ 写一条记录（status=committed）',
  '#   幂等（条目只增不减），但属写操作。只想看健康度用 health 口径，别跑这个。',
  'node scripts/selfcheck.mjs        # 23 项验收（含建库）',
  '',
  'node scripts/test-distill.mjs     # 提炼轨（45 项，纯函数 + mock）',
  'node scripts/test-commit.mjs      # 入册',
  'node scripts/test-health.mjs      # 体检（只读）',
  '```',
  '',
  '## 一句话',
  '你的价值不在于你提炼了多少条，在于**书阁里的每一条都能追回原文**。',
].join('\n');

/**
 * 书阁运维的 composition。
 *
 * ⚠ **与 `presets/librarian.patch.yml` 必须保持一致。**
 *   那个 YAML 是「可读的权威描述」，但运行时真正读的是**这份 JS**。
 *   两者不同步时以 JS 为准。这是当前架构的已知缺陷（见 README 待办）。
 *
 * 与主厨的差异是**刻意收窄**的，不是漏了：
 *   · 不给 tool-web          —— 运维不需要上网，给了反而分心
 *   · 不给 tool-subagent     —— 单线程串行活，不派子 agent
 *   · 不给 tool-workflow / tool-ralph —— 同上
 * 保留 pwsh 是刚性要求：25 个测试脚本、自检、建库都要真跑。
 */
function librarianPlugins() {
  return [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: LIBRARIAN_PREFIX } },
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
    // shell —— 必须给，见上方注释。disabled 用真布尔值（别写 '!!js ...' 字符串）
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: IS_WIN },
    { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: !IS_WIN },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
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
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    // 串行推进：库管活没有并行的必要，禁掉反而少一种写冲突来源
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: false } },
    { id: 'present', name: '@deepseek-ai/dsh-tool-present' },

    /**
     * ★ `send_message` —— 子代理的唯一回报通道。
     *
     * ⚠ **这是踩过的坑，别因为「不给 subagent」把它一起砍掉。**
     *
     * 第一版把整个 delegation 组都排除了（因为 librarian 不该派子 agent）。
     * 实测后果：`send_message` 也在 `dsh-tool-subagent-control` 里，
     * 一起被砍 → librarian 干完活**无法汇报**，只能把结果留在自己的会话里，
     * 派活方收不到任何东西。
     *
     * 「不派活」和「能回话」是两件事，必须分开判断：
     *   · `tool-subagent`（派活）    → 不给，库管是单线程活
     *   · `send_message`（回话）     → **必须给**，否则等于派了个哑巴
     *
     * 只挂 control 这一件，不挂 list-agents（它需要看成员列表，库管用不上）。
     */
    { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
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

    // ★ 第一个专职 Agent。主厨的 allowedAgentPresets 里要能选到它。
    await tryRegister({
      id: 'librarian',
      name: '书阁运维',
      description: '书阁的库管：入库、提炼、体检、策展。唯一有书阁写权的 Agent。',
      order: 10,
      plugins: librarianPlugins(),
    });
  });
}

/* 旧的单次注册写法已删除（2026-11-05）。
 *
 * 它只注册 master 一个 preset，无法承载多个。改成 tryRegister() 之后
 * 保留一份死代码只会让后人困惑「到底哪个在跑」——这正是 README 里
 * 反复踩过的坑（「定义了但没渲染」「配置对但不生效」）。
 */
