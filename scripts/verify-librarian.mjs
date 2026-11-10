/**
 * verify-librarian.mjs —— 真实验证 librarian preset 能否注册成功。
 *
 * ⚠ 这是**风险最高的一步**：`allowedAgentPresets` 里写了 librarian，
 *   如果它注册失败，`validate()` 会 reject → master 整个变 broken 并从 UI 消失。
 *
 * 但本脚本**无法**在没有 cordis 运行时的情况下真正 mount preset
 * （那需要完整的 Host 上下文）。所以它做两件事：
 *
 *   ① 静态：确认 librarian 的 composition 里没有已知会导致 broken 的模式
 *      （空 workflowEngine 域、依赖不存在的服务等）
 *   ② 动态：真 `await import()` 后调用 `apply()`，用**假 ctx** 捕获两次 register 调用，
 *      断言 register 收到的 config 结构合法（id / name / order / plugins 齐全）
 *
 * 真正"能不能 mount 成功"只能靠重启后看日志 —— 脚本里明确标注这一点。
 *
 * 运行：node scripts/verify-librarian.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.resolve(HERE, '../lib/index.js');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) {
    pass += 1;
    console.log(`✓ ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail += 1;
    console.log(`✗ ${name}${detail ? '  ' + detail : ''}`);
  }
};

console.log(`目标：${INDEX_PATH}\n`);

/* ── ① 动态导入 + 假 ctx 调用 apply ────────────────────────────── */

let mod;
try {
  mod = await import(pathToFileURL(INDEX_PATH).href);
  ok('lib/index.js 可导入', true);
} catch (e) {
  console.log(`✗ 导入失败：${e.message}`);
  process.exit(1);
}

const registered = [];
const errors = [];

/**
 * 假 ctx —— 只实现 apply() 真正用到的部分。
 *
 * apply 的实际行为：
 *   ctx.inject(['agentPresets'], cb)  → cb(假容器 c)
 *   c.get('agentPresets')             → 假注册表 reg
 *   reg.register(def)                 → 记录 def，返回 dispose 函数
 *   c.effect(fn)                      → 记录
 */
const fakeReg = {
  async register(def) {
    registered.push(def);
    return () => {}; // dispose
  },
};

const fakeC = {
  get(name) {
    if (name === 'agentPresets') return fakeReg;
    return undefined;
  },
  effect(fn) {
    /* 记录 dispose，不执行 */
  },
};

const fakeCtx = {
  /**
   * ⚠ 关键：把 cb 返回的 Promise **存起来**，因为 apply() 是同步外壳。
   *
   * 第一版写成 `inject(s, cb) { return cb(fakeC) }`，然后 `await mod.apply(fakeCtx)` ——
   * 看起来对，实际 `apply()` 自己不 await 这个 Promise（它只是转手调 inject），
   * 于是检查 registered 时第二个 preset 还没注册完 → **假失败**。
   *
   * 这不是被测代码的 bug，是测试桩的 bug。
   */
  inject(services, cb) {
    pending.push(cb(fakeC));
    return cb; // 无实际意义，仅保持接口形状
  },
};

/** apply() 期间产生的所有 async 回调 Promise */
const pending = [];

const origError = console.error;
console.error = (...args) => errors.push(args.join(' '));

try {
  mod.apply(fakeCtx);
  /* apply 是同步外壳；真正的注册发生在 pending 里的 Promise 中 */
  await Promise.all(pending);
  ok('apply() 执行无异常', true);
} catch (e) {
  ok('apply() 执行无异常', false, e.message);
} finally {
  console.error = origError;
}

/* ── ② 断言注册结果 ────────────────────────────────────────────── */

ok('注册了 2 个 preset', registered.length === 2, `实际 ${registered.length}`);

const byId = Object.fromEntries(registered.map((d) => [d.id, d]));
ok('注册了 master', 'master' in byId);
ok('注册了 librarian', 'librarian' in byId);

for (const [id, def] of Object.entries(byId)) {
  ok(`  [${id}] 有 name`, typeof def.name === 'string' && def.name.length > 0, def.name);
  ok(`  [${id}] 有 description`, typeof def.description === 'string' && def.description.length > 0);
  ok(`  [${id}] 有 order`, typeof def.order === 'number', String(def.order));
  ok(`  [${id}] plugins 是非空数组`, Array.isArray(def.plugins) && def.plugins.length > 0,
    `${def.plugins?.length} 项`);
}

/* order 关系：主厨必须是 0（排最前），librarian 在其后 */
ok('master order = 0（排最前）', byId.master?.order === 0, String(byId.master?.order));
ok('librarian order > 0', (byId.librarian?.order ?? -1) > 0, String(byId.librarian?.order));

/* ── ③ librarian 工具面的正反断言 ──────────────────────────────── */

const lib = byId.librarian;
if (lib?.plugins) {
  const ids = lib.plugins.map((p) => p.id);
  const names = lib.plugins.map((p) => p.name ?? '');

  /* 必须有 */
  ok('librarian 有 persona', ids.includes('persona'));
  ok('librarian 有 tool-pwsh（必须能跑测试）', ids.includes('tool-pwsh'));
  ok('librarian 有 tool-fs', ids.includes('tool-fs'));
  ok('librarian 有 tool-skill（读库管纪律）', ids.includes('tool-skill'));
  /**
   * ★ send_message 的来源，必须保留。
   *
   * 踩过的坑：第一版把整个 delegation 组砍掉（因为不派活），
   * 但 `send_message` 也在 `dsh-tool-subagent-control` 里，被一起砍掉 →
   * librarian 干完活**无法汇报**（2026-11-05 实测确认）。
   * 「不派活」和「能回话」是两件事。
   */
  ok('librarian 有 tool-subagent-control（send_message 来源，必须能回报）',
    ids.includes('tool-subagent-control'));

  /* 必须没有 —— 这是"专职"的判据 */
  ok('librarian 无 tool-web', !ids.includes('tool-web'));
  ok('librarian 无 tool-subagent（不派活）', !ids.includes('tool-subagent'));
  ok('librarian 无 tool-subagent-list-agents（不需要看成员）',
    !ids.includes('tool-subagent-list-agents'));
  ok('librarian 无 tool-workflow', !ids.includes('tool-workflow'));
  ok('librarian 无 workflow-ptc（无 isolate 域，不会 broken）',
    !ids.includes('workflow-ptc'));

  /* disabled 必须是真布尔值，不能是字符串 */
  const strDisabled = lib.plugins.filter((p) => typeof p.disabled === 'string');
  ok('librarian 的 disabled 无字符串（防恒真 bug）',
    strDisabled.length === 0,
    strDisabled.length ? `发现 ${strDisabled.map((p) => p.id).join(',')}` : '全部为布尔值或未设');

  /* persona 的 prefix 必须非空（否则等于没给这个 Agent 人格） */
  const persona = lib.plugins.find((p) => p.id === 'persona');
  const prefix = persona?.config?.prefix;
  ok('librarian 的 persona.prefix 非空', typeof prefix === 'string' && prefix.length > 100,
    `${prefix?.length ?? 0} 字符`);
  ok('librarian 人格含"书阁"', typeof prefix === 'string' && prefix.includes('书阁'));

  /**
   * ★ 人格里**不许写会过期的统计数字**。
   *
   * 踩过的坑：第一版人格写着「400 条 entry / 297 份 runs」，
   * 书阁还在建设中，几天后就变成了 409 / 308 ——
   * 一个库管 Agent 记着过期的库规模，会基于错误前提做判断。
   *
   * 这里断言两件事：
   *   ① 不得出现裸的库规模数字（如「NNN 条 entry」「NNN 份」）
   *   ② 必须给出「自己查」的方法，而不是让 Agent 背
   *
   * 允许的例外：测试项数（23 项 / 45 项）、固定结构（6 册）、
   * 阈值（2 分）、源码行数（931 行）—— 这些不随入库增长而变。
   */
  if (typeof prefix === 'string') {
    const ALLOWED = /(23 项|45 项|6 册|2 分|931 行|7 个|曾经)/;
    const stale = prefix
      .split('\n')
      .filter((line) => /\d+\s*(条|份|KB)/.test(line) && !ALLOWED.test(line));
    ok('人格里没有会过期的库规模数字', stale.length === 0,
      stale.length ? `发现：${stale[0].trim().slice(0, 50)}` : '干净');

    ok('人格要求 Agent 自己查数字而非背', /不要背数字|不要相信我给你的数字/.test(prefix));
    ok('人格给了查证方法（读 library.json 或数列目录）',
      /library\.json|Get-ChildItem/.test(prefix));
    ok('人格说明物理数 ≠ 可翻条目数', /物理文件数 ≠ 可翻条目数/.test(prefix));
    ok('人格警告 selfcheck 会写线上库', /会写线上库|不是只读/.test(prefix));
    ok('人格声明文档以代码为准', /以代码为准/.test(prefix));
  }
}

/* ── ④ master 侧：librarian 必须在可路由名单里 ──────────────────── */

const master = byId.master;
const subagent = master?.plugins
  ?.find((p) => p.id === 'delegation')
  ?.config?.find((p) => p.id === 'tool-subagent');
const allowed = subagent?.config?.allowedAgentPresets;
ok('master 的 tool-subagent 配了 allowedAgentPresets', Array.isArray(allowed), JSON.stringify(allowed));
ok('  名单含 librarian（能路由到专职 Agent）', Array.isArray(allowed) && allowed.includes('librarian'));
ok('  名单不含 master（防递归）', Array.isArray(allowed) && !allowed.includes('master'));

/* ── ⑤ 日志检查：apply 期间不应有注册失败 ─────────────────────── */

ok('apply 期间无 console.error（即无注册失败）', errors.length === 0,
  errors.length ? errors.join(' | ') : '干净');

/* ── 汇总 ──────────────────────────────────────────────────────── */

console.log('\n' + '='.repeat(60));
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`);
console.log('');
console.log('⚠ 本脚本验证的是「register() 能被正确调用且 config 结构合法」。');
console.log('  它**不能**证明 preset 真的 mount 成功 —— 那需要完整 cordis 运行时。');
console.log('  真正的 mount 验证 = 重启 DSH 后：');
console.log('    ① 日志里应有 [master] preset "librarian" 注册成功');
console.log('    ② 新建会话的 preset 列表里应出现「书阁运维」');
console.log('    ③ dump-config 里应能看到 5 个 dsh-agent-preset（4 内置 + librarian 不是，');
console.log('       librarian 由插件运行时注册，不进 dump-config）');
process.exit(fail === 0 ? 0 : 1);
