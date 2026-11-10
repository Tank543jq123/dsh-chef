# 主厨 · Master Agent 插件

> 左侧栏常驻入口 + 一个常驻的总调度 preset。**零产品耦合**。
> 位置：`<repo>\` · 已装进 `profiles\web`

---

## 它是什么

三件事：

| 部分 | 做什么 |
| :--- | :--- |
| **host 半** (`lib/index.js`) | 启动时调 `agentPresets.register()`，注册一个 id=`master` 的 preset |
| **client 半** (`lib/client.js`) | 侧栏常驻一行「主厨」入口 + 主区一个面板 |
| **bundle patch** (`cordis.patch.yml`) | 让宿主把本包插进组装（**没有它装了不起作用**） |

---

## 三个真实坑（都是实测踩出来的）

### 坑 1：声明式 preset 行在本 harness 上**不可靠**

我最初按 Hard is 的写法，在 `cordis.patch.yml` 里加：

```yaml
- insert:
    - id: preset-dispatcher
      name: '@deepseek-ai/dsh-agent-preset'
      config: { id: dispatcher, ... }
```

**界面上永远不出现。** 探针实测根因：

```
[PROBE] agentPresets 服务类型: AgentPresetRegistry
[PROBE] definitions size = 0          ← 一个都没注册上
```

`dsh-agent-preset` 靠 `[Service.init]` 里一行 `register()` 注册，这条路径在本环境没跑通。

**本插件的做法：自己直接调服务 API。**

```js
ctx.inject(['agentPresets'], async (c) => {
  const reg = c.get('agentPresets');
  await reg.register({ id: 'master', name: '主厨 · Master Agent', order: 0, plugins: [...] });
});
```

这正是 `dsh-agent-preset` 内部做的事，但**时机可控、失败能打日志**。

### 坑 2：`isolate: workflowEngine` 缺 provider → 整个 preset 变 broken → 被 UI 静默过滤

第一版注册成功了，但界面上还是没有。探针给出：

```
master     broken=tool-workflow (@deepseek-ai/dsh-tool-workflow): waiting for workflowEngine
```

`dsh-agent-preset-registry` 的 `activate()` 遇到 mount 失败时**只 `logger.warn`，不抛错**：

```js
} catch (error) {
    record.broken = error.message;
    this.owner.logger.warn(`agent preset ${record.config.id}: ${record.broken}`);
}
```

而 UI 端（`dsh-client-ui-agent-preset/lib/client.js:1169`）会：

```js
presets.filter((preset) => preset.broken === void 0)
```

**直接过滤掉。** 所以「配置对、组装对、就是不出现」——它 broken 了，只是没人告诉你。

**根因**：`isolate: { workflowEngine: true }` 会开一个**空的工作流引擎域**。域里必须有人注册 provider，否则 `tool-workflow` 永远在等待。官方 `standard` / `ptc` / `cordis` 都在同一组里先放 `workflow-ptc` —— 我漏了。

**修法**：在 `delegation` 组里、`tool-workflow` 之前加：

```js
{ id: 'workflow-ptc', name: '@deepseek-ai/dsh-workflow-ptc', config: { provider: 'spawn' } },
```

修完后 6 个 preset 全部 `broken=(none)`。

### 坑 3：`pnpm install` 会把 `dsh.profile.bundles` 里的条目**删掉**

我把 `dsh-chef` 同时加进 `dependencies` 和 `dsh.profile.bundles`，然后跑 `dsh plugin --profile web install`。

结果：**`bundles` 里的 `dsh-chef` 被 pnpm 删掉了**（`Packages: +1 -26`）。

`dump-config` 里一行都没有。反复确认后发现：

```
dependencies 里有 master: True
bundles 里有 master: False      ← 被删了
```

**修法**：`install` 之后再手工把条目加回 `bundles`。或者顺序反过来 —— 先 install，再改 bundles。

---

## package.json 的两个必需字段

```json
{
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // ← 缺它，装了不起作用
    "client": {                                     // ← 缺它，左侧栏不出现
      "inject": ["@deepseek-ai/dsh-client-ui-layout", "@deepseek-ai/dsh-client-ui-sidebar"],
      "platform": "web"
    }
  }
}
```

两个都漏过：

- 漏 `dsh.bundle.patch` → `dump-config` 里没有任何行（包被 skip，且**不报错**）
- 漏 `dsh.client` → host 半正常，但 `ClientModuleRegistry.table` 里没有它，侧栏没入口

补齐后探针输出：

```json
"id": "dsh-chef",
"url": "plugins/??dsh-chef/client.js&rev=01ac50424add",
"inject": ["@deepseek-ai/dsh-client-ui-layout", "@deepseek-ai/dsh-client-ui-sidebar"],
"meta": { "clientPath": "<repo>\\lib\\client.js" }
```

宿主为它生成了 bundle URL，说明 client 半被认了。

---

## 落点：为什么是 `sidebar.panellist`

手册有一条硬约束：

> **DSH 插件官方没有可插入左侧栏内容区的槽位。**
> `sidebar` 是 kind:single，被 ui-sidebar 独占；`sidebar.workspaces` 被 ui-workspace 占用。
> 唯一能"永久显示在左侧"的官方槽位是 `sidebar.panellist`（kind:list，可叠加）。

所以形态是 **侧栏一行常驻入口 + 主区面板**，两处 id / key 用同一个常量保证一致。

---

## client 半必须手写 CJS

手册要求：不能是打包器 ESM，必须是

```js
window.__ModuleLoader__.load({
  id: 'dsh-chef',
  factory: (require) => { ... return module.exports; },
});
```

并显式 `exports.apply` / `exports.inject`。代价：没有 JSX（用 `jsx()` / `jsxs()`）、没有 import（用注入的 `require`）。

---

## 配色：只用 currentColor，不写死主题色

```js
const C = {
  ink: 'currentColor',
  dim: 'color-mix(in srgb, currentColor 62%, transparent)',
  line: 'color-mix(in srgb, currentColor 18%, transparent)',
  soft: 'color-mix(in srgb, currentColor 8%, transparent)',
};
```

Hard is 项目实测过：写死深色主题值，一旦实例跑浅色主题就是「深色字压浅色底」，对比度 1.13:1，**等于隐形**。`currentColor` 继承父级文字色，不会因为这个错误变丑。

---

## 验证记录

> ⚠ **下表是 2026-11 首次交付时的快照，已过期。** 之后代码改过（见下方「2026-11-05 变更」），
> `len=3825` / `3709 字节` 这类写死的数字**必然对不上**，不要再拿它们当验收依据。
> 重跑方法见本节末尾。

| 项 | 结果（历史快照） |
| :--- | :--- |
| `node --check` 两个文件 | ✅ exit 0 |
| `dump-config` | ✅ 2094 行，出现 `# == dsh-chef` |
| host 半注册 | ✅ `[master] 主厨 preset 注册成功` |
| roster 里存在 | ✅ `master order=0 broken=(none)` |
| **`resolve('master')`** | ✅ `{"id":"master"}` —— **无 broken 字段 = 可用** |
| **`readDocument('master')`** | ✅ len=3825，persona / subagent / workflow-ptc / 主厨 全在 |
| client 半登记 | ✅ `ClientModuleRegistry.table` 里有 `dsh-chef`，有 bundle URL |
| **面板真实渲染** | ✅ 真实 React 服务端渲染出 3709 字节 HTML，9 项文案全在，「服务不可达」误报 false |
| 其它 8 个插件未受影响 | ✅ 全部仍在 |

### 怎么重跑（需要 shell，本环境没有）

```bash
node --check <repo>\lib\index.js
node --check <repo>\lib\client.js
node <repo>\scripts\verify-client.mjs   # vm 真跑 client.js + renderToStaticMarkup
node <repo>\scripts\verify-preset.mjs   # 动态 import index.js，查 name/inject/apply
dsh web --dump-config | findstr "dsh-chef"
```

---

## 2026-11-05 变更（续）：修一个「看起来对、实际恒假」的 bug

### ④ `disabled` 写成字符串 → 主厨在 Windows 上**永远没有 pwsh**

这是本次最严重的一处，而且**是我自己引入的**（第一版从 profile 的 YAML 里照抄写法）。

原写法：

```js
{ id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: '!!js process.platform !== "win32"' }
```

看起来完全正确，实际条件**恒为禁用**。根因在
`dsh-agent-preset-registry/lib/index.js:267-274`：

```js
function disabledContribution(value, evaluateExpression) {
  if (isJsExpr(value)) try { return Boolean(evaluateExpression(value.__jsExpr)); }
                       catch { return 'conditional'; }
  return Boolean(value);        // ← 非 !!js 节点走这里
}
```

`!!js` 在 **YAML 里是标签**，解析后是带 `__jsExpr` 的对象。但在 **JS 对象里写字符串**，
`isJsExpr()` 为假，于是走 `Boolean(value)` —— **非空字符串恒为 `true`**，
和 `process.platform` 一点关系都没有。

**后果**：主厨这个「总调度」永远没有 shell。它只能说「我已派人去验证」，
自己却验不了任何东西 —— 这恰好违反主厨自己的人格铁律第一条
（「不验收没验过的东西」）。而且**不报错**，只是静默少了几个工具。

**修法**：用真布尔值。

```js
const IS_WIN = process.platform === 'win32';
{ id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: IS_WIN },
{ id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: !IS_WIN },
```

**怎么发现的**（这条值得记）：不是靠读代码读出来的，是靠**派子 agent 探测工具面**发现的——
子 agent 明明继承了主厨的人格，却报告「没有 pwsh」。人格继承、工具面却缺，说明问题在
composition 而不是 delegation。顺着这条线才查到 `disabledContribution`。

**同时纠正一条我之前说错的话**：我曾说「主厨 preset 自己带着 `tool-pwsh`，所以主厨会话有
shell，只是 lead 会话没有」。**这句话是错的**——主厨一直没有 pwsh，因为它是被字符串
`disabled` 恒禁用的。当时我看到了那行配置就下了结论，没验证它是否真的生效。
这正是「看到配置当成看到结果」的典型错误。

---

## 2026-11-05 变更（二）：验证结果

重启后实测（**这次是真跑出来的，不是推断**）：

| 验证项 | 方法 | 结果 |
| :--- | :--- | :--- |
| 主厨 preset 是否存活 | 当前会话的 system prompt 就是 `MASTER_PREFIX` 原文 | ✅ 活着 |
| `tool-schedule` 是否生效 | 直接调用 `schedule_list()` | ✅ 返回 `[]`（服务在线、无提醒） |
| `agent_preset` 参数是否存在 | 子 agent 读自己的 `subagent` schema | ✅ 存在，`enum: ["standard","ptc","minimal","cordis"]` |
| **路由是否真生效** | **派一个 `agent_preset: minimal` 的子 agent** | ✅ **人格与工具面双双改变** |

**路由生效的对照证据**（这是本次最硬的一条）：

| 对照组 | 人格首句 | 工具面 |
| :--- | :--- | :--- |
| 不指定 preset（继承主厨） | `你是**主厨**（Master Agent）…` | 有 write/edit，**无 pwsh** |
| 指定 `agent_preset: "minimal"` | `You are a helpful software engineer assistant.` | **有 pwsh**，无 write，无 subagent |

指定 preset 后人格和工具面**同时**变化 —— 这是路由链路端到端打通的直接证据。

⚠ **顺带发现**：`minimal` preset 反而**有** pwsh 而主厨没有。这既是上面 ④ 号 bug 的旁证，
也说明「不同 preset 的工具面差异是实打实的」，路由到不同 preset 确实会改变能力边界。

---

## 2026-11-05 变更（三）：dispatcher 已停用

`profiles/web/cordis.patch.yml:903` 加了 `disabled: true`。

**为什么是停用而不是删除**：本会话没有 shell，无法 `--dump-config` 验证搬运结果；
手抄 190 行 YAML 只要错一个缩进就会破坏整个 profile。单行 `disabled` 效果等价（不进 roster），
且完全可逆。等有 shell 的环境下再做物理清理（步骤写在那一行的注释里）。

⚠ **删除前必须先确认 master 的 `allowedAgentPresets` 生效** —— dispatcher 有这项能力、
master 直到今天才补上。若顺序搞反，会出现一段「谁都不能派给指定 preset」的能力真空期。

---


三处改动，起因是审计发现「主厨名为总调度，实际没有任何路由能力」。

### ① `tool-schedule` 补回来了（`lib/index.js`）

旧 `dispatcher` 有、主厨第一版漏了。它是内置能力里**唯一**接近「自动」的一件：
没有它，主厨连「过 10 分钟再看一眼」都做不到，更谈不上无人值守。

配置依据：官方 `dsh-web-app/cordis.patch.yml:135-140` 明确把 `schedule` 服务放 host 层，
并注明「the four reminder tools belong to the `standard`, `cordis`, and `ptc` presets,
which declare them in their own scope」——所以 `tool-schedule` 属于 preset 层，加得对。
它用 `ctx.inject(['schedule'], …)` 延迟注入，host 没这个服务时会静默待命，不会把 preset 搞坏。

### ② `allowedAgentPresets` 补上了（`lib/index.js`）

**这是「能不能派给对的 agent」的分水岭。**

- 不配 → 工具 schema 里没有 `agent_preset` 参数，子 agent **只能继承父的 preset**
- 配了 → 参数里出现 `agent_preset`，模型可从中挑一个

机制出处：`dsh-tool-subagent/lib/index.js:201-256`。
前提是 provider 支持 `capabilities.agentPreset`——`spawn` 支持
（`dsh-subagent-spawn-in-process/lib/index.js:21-27`，且 `inheritsParentContext = false`）。
若将来换成进程外 provider，会因 `NO_START_CAPABILITIES` 直接抛 `UNSUPPORTED_CAPABILITY`，
**不会静默忽略**。

⚠ **不列 `master` 自己**：调度者派调度者会无限递归。

⚠ **标的错了要付出代价**：这份名单列的是 `standard` / `ptc` / `minimal` / `cordis`，
即 **DSH 内置通用 preset**，不是「专职 agent」。项目规划过的 5 个专职 agent
（L1 库管 / 技能库管理 / 原理图绘制 / 设计模块 / PCB 绘制）**一个都还没建**。
等它们注册后，把 id 加进 `allowedAgentPresets`，主厨才真的能「路由到专职 agent」。

⚠ **配置错的后果是 preset 整个消失，不是报错**：`validate()` 会遍历这份名单逐个
`readDocument(id)`，而 `readDocument` 对不存在的 id 是 **reject** 不是返回空
（`dsh-agent-preset-registry/lib/index.js:613-618`）。任一 id 不存在 → validate 抛错 →
preset 变 broken → UI 端 `filter(broken === void 0)` 直接过滤掉，**界面上什么都不显示，
也不告诉你为什么**。所以改这份名单时，必须确认每个 id 都真的注册了。

`standard` / `ptc` / `minimal` / `cordis` 四个都已确认存在
（`dsh-web-app/package.json:48-54` 的 bundle patch 列表里全部列出）。

### ③ 归档按钮：逐条容错 + `stopActivity` 说明（`lib/client.js`）

原来是一个裸 `for` 循环，整批共用外层 `try/catch`。服务端行为是
（`dsh-api-workspace-controller/lib/index.js:291-302`）：会话还有正在跑的活动时，
不带 `stopActivity` 会被拒绝并抛 `workspace/session-active`。

**后果**：撞上第一个 running 会话，整批就停 —— 前面已归档的**不回滚**，
后面的一条**不动**。用户看到「归档失败」，实际是半成品状态。

现在每条单独 try，成功的计数、失败的收集后一起报（`已归档 N 条，M 条失败（首条：… 原因）`）。

**仍未做**：没有传 `stopActivity: true`。理由是那是「强行中断正在干活的会话」，
属于危险动作，需要用户明确同意才该有——而目前面板上的按钮文案（「归档其它会话」）
并没有表达这个含义。如果要支持，应做成两个按钮或加二次确认，不能默默升级语义。


---

## 2026-11-05 变更（四）：新增「书阁运维」专职 Agent

这是 **B 方案（主厨只做路由）的第一个真实目的地**。

在此之前，`allowedAgentPresets` 里只有 DSH 内置的 4 个通用 preset
（standard / ptc / minimal / cordis）。「路由能力」虽然有，"专职 Agent" 一个都没有 ——
路修好了，路上没有目的地。

### 它是什么

| 项 | 值 |
| :--- | :--- |
| preset id | `librarian` |
| 显示名 | 书阁运维 |
| order | 10（主厨是 0） |
| 插件数 | 17（主厨 19，少的正是刻意收窄的几项） |
| 人格 | `LIBRARIAN_PREFIX`，1825 字符 |

### 「专职」的判据：工具面真的被收窄

如果它和 standard 一样满配工具，那就只是换了个提示词，不构成专职。收窄清单：

| 不给 | 理由 |
| :--- | :--- |
| `tool-web` | 运维书阁不需要上网，给了反而分心 |
| `tool-subagent` | 库管是单线程串行活，不需要再派子 agent |
| `tool-workflow` / `tool-ralph` | 同上 |

| 必须有 | 理由 |
| :--- | :--- |
| `tool-pwsh` | **刚性要求**。25 个 `test-*.mjs`、`selfcheck.mjs`、建库都要真跑 |
| `tool-skill` | 它要读「库管」那套纪律 |
| `tool-fs` | 读写 library.json / entries / volumes |

> 顺带一个收益：不给 `workflowEngine` 的 isolate 域，就**绕开了「坑 2」**
> （空工作流域导致 `tool-workflow` 永久等待 → preset 变 broken → 被 UI 过滤）。
> 收窄工具面不只是省 token，也少了一整类故障模式。

### 五条写盘硬纪律（写进人格，不是写在文档里）

1. **永不自动删除条目** —— 只标 `status: 'expired'`，物理删除只能人手执行
2. **模型不直接写盘** —— 提炼只产出 proposal，落盘走 `commitEntries` 并二次校验源哈希
3. **没有溯源就不许入册** —— 每条 entry 必须带五元组，缺一项就拒写
4. **不静默截断** —— 目录超限报错并拒绝注入，不砍一半假装成功
5. **不替代 AGENTS.md** —— 手册是旁边的一层索引，规范留正文

### ⚠ 一个必须知道的连带风险

`allowedAgentPresets` 里加了 `librarian`。而 `validate()` 会遍历名单逐个
`readDocument(id)`，**没有 try/catch** —— 任一 id 读不到就 reject，整个 master 变 broken。

**也就是说：`librarian` 起不来，主厨会跟着消失。**

这是设计上的硬耦合，不是这次引入的。缓解措施：

- `apply()` 改成 `tryRegister()`，两个 preset 独立 try/catch，至少留下 error 日志
- `scripts/verify-librarian.mjs` 用假 ctx 真跑一遍 `apply()`，断言两个 preset 都被注册
- 回退命令（已验证可用）：
  ```powershell
  git checkout a3fbc54 -- lib/index.js   # 只回滚源码，保留测试脚本
  ```

### 源码与 YAML 的双份问题（已知缺陷）

`presets/librarian.patch.yml` 与 `lib/index.js` 的 `librarianPlugins()` 描述同一件事，
但**运行时只读 JS**。YAML 只是「可读的权威描述」，没有代码在读它。

这是当前架构的缺陷：两份定义必然漂移。记为待办 —— 要么让插件读 YAML，
要么删掉 YAML 只留 JS。**现在先不解决，但必须知道它不可信。**

### 验证（真实执行）

```
verify-preset.mjs     37 通过 / 0 失败 / 1 跳过
verify-client.mjs     22 通过 / 0 失败
verify-librarian.mjs  30 通过 / 0 失败
────────────────────────────────────────
合计                  89 项通过
```

`verify-librarian.mjs` 做了什么：动态 import → 假 ctx 调 `apply()` →
捕获两次 `register()` → 断言 config 结构合法、工具面正反断言、人格非空、
`disabled` 全是布尔值（防上一轮那个恒真 bug 复现）。

**它不能证明 preset 真的 mount 成功** —— 那需要完整 cordis 运行时。
真正的 mount 验证 = 重启后看：
1. 日志里有 `[master] preset "librarian" 注册成功`
2. 新建会话的 preset 列表里出现「书阁运维」
3. 主厨仍然存在（不是被 librarian 拖成 broken）

---

## 单对话：手动归档，不自动

DSH 本来就做了一半：

| 行为 | 来源 | 现状 |
| :--- | :--- | :--- |
| 反复进出工作区不堆会话 | `createInWorkspace`（只复用 blank） | ✅ 自带 |
| 侧栏隐藏非当前 blank 会话 | `sessionVisible` | ✅ 自带 |
| 发过消息的会话会留下 | — | ⚠️ 唯一堆积来源 |

所以本插件补的是最后一块：面板里一个「归档其它会话」按钮。

```js
const snap = sessions.list.getSnapshot();       // { ids, current }
const targets = snap.ids.filter(id => id !== current);
for (const id of targets) await workspaces.archiveSession(id);
```

**为什么是按钮而不是自动**：自动归档会在你不知情时让上个会话从列表消失。归档可逆
（`unarchiveSession` 就在旁边），但它改变了你看到的东西 —— 这种改动应当由你按下。

---

## ⚠ 两个必须知道的实现陷阱

### 陷阱 1：`main` 槽位组件拿不到 `ctx`

`main` 槽位的组件由**宿主**渲染，它只传自己的 props（如 `{ active }`），
**不会**把插件 `ctx` 传进来。直接注册裸组件会让面板里 `ctx === undefined`。

**症状**：不崩溃，只是功能静默失效（按钮点了报「服务不可达」）。
**修法**：闭包绑定 —— `const BoundPanel = () => jsx(MasterPanel, { ctx });`

### 陷阱 2：`node --check` 抓不到「定义了但没渲染」

本轮两次栽在这个上：

- `archiveBlock` 在 JSX 里被引用，但从未定义 → 语法检查**通过**，运行时 `ReferenceError`
- `ArchiveControls` 定义完好，但 JSX 树里**没有它** → 按钮根本不出现

**唯一可靠的抓法**：注入假 `window.__ModuleLoader__` + 真实 React，
把 `client.js` 真跑一遍、真 `renderToStaticMarkup` 一次，再检查 HTML 里有没有那几个文案。

---

## 已知局限

1. **没在真实浏览器里点过。** 服务端渲染证明了组件能产出正确 HTML、ctx 能拿到服务，
   但归档按钮的真实点击路径**未实跑**。当前模型不支持图像输入，无法截图核对视觉效果。
2. **`pnpm install` 会删 bundles 条目**，会反复踩。每次 install 后都要检查 `bundles` 是否完整。
3. **需要重启才生效。**
4. **批量归档的副作用未验证** —— 运行中的会话归档是否需要确认弹窗，我只写了串行 `await`。
   2026-11-05 已把串行循环改成逐条容错（见上），但**真实点击仍未验证**。
5. **「归档其它会话」粒度太粗** —— 会归档掉所有非当前会话，包括你想留的。可逆但不够精细。
6. **`order: 0` 是否真排最前未实测** —— 只证明 roster 里是 order=0。
7. **（2026-11-05 新增）没有任务台账。** 面板里的四行（拆活/派活/验收/汇总）是**写死的说明文字**，
   不是运行状态。主厨现在看不见「谁在跑、谁交了、谁没交」。
8. **（2026-11-05 新增）「自动派发」仍然是未实现的。** `tool-schedule` 补上只是给了
   一个「被唤醒」的手段，不等于主厨会自己接活。它现在依然要靠人开会话、选 preset、打字。
   真正的自动需要 Host 侧订阅 `session/event` 并主动 dispatch —— 那是另一个量级的工程，
   而且要处理递归、成本闸门、失败重试、幂等，不是加个配置能解决的。
9. **（2026-11-06 新增）收窄工具面时差点把「回话能力」一起砍掉。**
   `librarian` 第一版为了「不派活」排除了整个 delegation 组，但 `send_message`
   也由 `dsh-tool-subagent-control` 提供，被一起砍掉 → **子代理干完活无法汇报**，
   只能把结果留在自己的会话里，派活方收不到任何东西。
   实测发现（派 librarian 自检时它明确报告"没有 send_message"）后才补回。
   **教训：「不派活」和「能回话」是两件事，收窄工具面时必须分开判断。**
10. **（2026-11-06 新增）`presets/librarian.patch.yml` 与 JS 双份定义。**
    运行时只读 `lib/index.js` 的 `librarianPlugins()`，YAML 没有代码在读。
    两份必然漂移。要么让插件读 YAML，要么删掉 YAML 只留 JS。

---

## 2026-11-06 变更：librarian 端到端验证结果

### 已验证（真实执行）

| 验证项 | 方法 | 结果 |
| :--- | :--- | :--- |
| `librarian` 是否注册 | 子代理读 `subagent` schema 的 `enum` | ✅ 在，且**是 enum 第一个值** |
| preset 描述是否可读 | 同上，看 `Available presets:` 文案 | ✅ 出现「librarian: 书阁的库管…」 |
| **主厨是否还在** | 当前会话 system prompt 开头 | ✅ 仍是「你是**主厨**（Master Agent）」 |
| **端到端路由** | 派 `agent_preset: "librarian"` 的子代理 | ✅ **人格与工具面双双改变** |

### 端到端证据（librarian 子代理的自检回报）

| 项 | 结果 |
| :--- | :--- |
| 人格首句 | `你是**书阁运维**（Librarian）。你只做一件事：…` ✅ |
| 五条硬纪律 | 逐条复述正确 ✅ |
| 数据目录 | `~/.dsh\.dsh\dsh-manuscript\` ✅ |
| 有 `pwsh` | ✅ |
| 无 `subagent` | ✅（工具面收窄生效） |
| 无 `web_search`/`web_fetch` | ✅ |
| **无 `send_message`** | ❌ **缺陷，已修**（见局限 9） |

### 修复：补回 `tool-subagent-control`

`send_message` 由 `dsh-tool-subagent-control` 提供，必须单独挂上：

```js
{ id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' }
```

但**不挂** `tool-subagent`（不派活）和 `tool-subagent-list-agents`（不需要看成员）。
librarian 插件数 17 → 18。

> ⚠ 这个修复**尚未重启验证**。重启后应派一个 librarian 子代理，
> 确认它这次能 `send_message` 回报。

### 验证脚本

```
verify-preset.mjs     40 通过 / 0 失败 / 1 跳过
verify-client.mjs     22 通过 / 0 失败
verify-librarian.mjs  32 通过 / 0 失败
────────────────────────────────────────
合计                  94 项通过
```

**回归中修过一处测试自身的 bug**：`verify-preset.mjs` 用 `body.includes('tool-subagent')`
做子串匹配，补了 `tool-subagent-control` 之后被误判成失败（前者是后者的前缀）。
已改为精确匹配 `id: 'xxx'` 字面量。**这是测试写得太糙，不是代码有问题。**

---

## 2026-11-06 变更（二）：librarian 干完第一件真活

### 两件事同时验证成功

**① `send_message` 修复生效。** 重启后派 librarian 跑自检，它明确回报：
「我用了 send_message。工具存在、调用成功。」—— 消息确实送达了。
**派出去的子 agent 现在能回话，不再是哑巴。**

**② 它真的能干活。** `node scripts/selfcheck.mjs` 结果：

```
退出码 0 · stderr 空 · 结果：23 通过 / 0 失败 / 共 23
耗时最长项：扫描会话 22618ms
```

报回的关键真实数字（均摘自 stdout）：

| 项 | 值 |
| :--- | :--- |
| 会话总数 | 294（含 18 个无版本号）· 解析错误 0 |
| 事件 / 工具调用 | 218,163 / 35,071 |
| 已归档 | 266 |
| cwd 完整率 | **294/294（100%）** |
| 分诊 | empty 47 / smoke 14 / real 233 |
| 建库 | 257 条 · 6 册 · 收件箱 60 待归 · 复跑 created=0 |
| L1 目录注入 | 47 行 / 1537 字节（上限 200 行 / 25600 字节） |

它自己复述人格首句为「你是**书阁运维**（Librarian）…」，
五条硬纪律也逐条说对 —— 说明人格注入是真的生效，不是摆设。

### ⚠ 一处口径差异：librarian 判断对了

它报告「自检输出 257 条，与我接到的 400 条现状不一致」，并推断**自检跑的是它自己建的
临时库，257 是沙箱数**。我去核了线上库，它的推断方向对了一半：

| 数字 | 含义 | 来源 |
| :--- | :--- | :--- |
| **404** | `entries/` 目录**物理文件数** | 实测 |
| **370** | 各册声明**可翻条目**（`volumes[].entries` 求和） | 实测 |
| **27** | 已退役（`counts.retired`） | 实测 |
| **257** | 自检新建库的条目数（`counts.kept`） | `counts.kept` |

`404 = 370 可翻 + 27 退役 + 7 已损` —— 那 7 条已损确实存在，只是自检路径覆盖不到。

### ⚠ 但它有一处判断错了，必须记下来

**`selfcheck.mjs` 不是纯只读的。** 它自己说「自检库是临时建的」，但实测：

- 每次跑都会重写线上 `library.json`（`generatedAt` 更新到跑完那秒）
- 每次跑都往线上 `runs/` 写一条记录（观察期间 runs 从 297 → 306）
- run 记录里写着 `status: "committed"`、`counts: {entries: 404}`、`written: 417`

**也就是说：它把重建结果真的提交到了线上库。**

好消息是**幂等**：连续跑两次，entries 保持 404 不变，条目只增不减，不丢数据。
但「selfcheck 是只读的」这个印象是错的 —— 把只读体检当安全操作、把 selfcheck 当体检，
是两个不同的东西。

> **给后续 Agent 的判据**：
> - 想**只读**体检 → 用 `checkLibraryHealth`（health.js），不要跑 `selfcheck.mjs`
> - `selfcheck.mjs` 是**验收脚本**，它会建库并 commit，属于写操作




