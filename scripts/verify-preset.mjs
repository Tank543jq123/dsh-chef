/**
 * verify-preset.mjs —— 对 `lib/index.js`（host 半，ESM）做结构验证。
 *
 * ⚠ 状态：本脚本**未被执行过**。编写者所在会话没有 shell。
 *
 * 三层验证：
 *   ① 静态源码断言 —— 不需要 import 就能查的东西（括号配对由 V8 在 import 时兜底，
 *      但 `tool-schedule` 的位置、`allowedAgentPresets` 的内容这些查源码最直接）。
 *   ② 真 `await import()` —— 证明 ESM 语法可解析、导出齐全、`apply` 是函数。
 *      ⚠ 这一步只导入模块，**不调用 apply**，因此不需要 cordis 运行时。
 *   ③ `-check` 等价物：Node 没有可编程的 `--check` API，所以用
 *      `new vm.SourceTextModule` 在解析期抓语法错（需 --experimental-vm-modules），
 *      拿不到就退回 ② 的 import 结果（import 本身已经会因语法出错而抛）。
 *
 * 运行：node scripts/verify-preset.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.resolve(HERE, '../lib/index.js');

let pass = 0;
let fail = 0;
let skipped = 0;
const ok = (name, cond, detail) => {
  if (cond) {
    pass += 1;
    console.log(`✓ ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail += 1;
    console.log(`✗ ${name}${detail ? '  ' + detail : ''}`);
  }
};
const skip = (name, why) => {
  skipped += 1;
  console.log(`- ${name}（跳过：${why}）`);
};

const src = fs.readFileSync(INDEX_PATH, 'utf8');
console.log(`目标：${INDEX_PATH}（${src.length} 字节）\n`);

/* ── ① 静态源码断言 ────────────────────────────────────────────── */

ok('声明 name 导出', /export\s+const\s+name\s*=/.test(src));
ok('name 不是空串', !/export\s+const\s+name\s*=\s*(['"`])\1/.test(src));
ok('声明 inject 导出', /export\s+const\s+inject\s*=/.test(src));
ok('声明 apply 导出', /export\s+function\s+apply\s*\(/.test(src) || /export\s+const\s+apply\s*=/.test(src));

/* tool-schedule：必须在数组里，紧跟 tool-jobs 之后 */
ok('存在 tool-schedule 条目', src.includes("id: 'tool-schedule'"));
ok(
  'tool-schedule 的包名拼写正确',
  src.includes("name: '@deepseek-ai/dsh-tool-schedule'"),
);
{
  const jobsIdx = src.indexOf("id: 'tool-jobs'");
  const schedIdx = src.indexOf("id: 'tool-schedule'");
  ok('tool-schedule 出现在 tool-jobs 之后', jobsIdx !== -1 && schedIdx > jobsIdx,
    `jobs@${jobsIdx} schedule@${schedIdx}`);
}

/* allowedAgentPresets */
ok('存在 allowedAgentPresets', src.includes('allowedAgentPresets:'));

/* 从源码里抽数组字面量，逐项核对 */
const presetMatch = src.match(/allowedAgentPresets:\s*\[([^\]]*)\]/);
ok('allowedAgentPresets 是数组字面量', presetMatch !== null);
if (presetMatch) {
  const ids = [...presetMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  console.log(`  解析出的 preset id：${JSON.stringify(ids)}`);
  ok('非空', ids.length > 0);
  ok('无重复（否则 tool-subagent 构造期直接 throw）', new Set(ids).size === ids.length);
  /* 关键：不能包含 master 自己 —— 调度者派调度者会无限递归 */
  ok('不包含 master 自己（防递归）', !ids.includes('master'), JSON.stringify(ids));
  ok('包含 standard', ids.includes('standard'));
  /* ★ 2026-11-05 新增：第一个专职 Agent 必须可路由 */
  ok('包含 librarian（第一个专职 Agent）', ids.includes('librarian'), JSON.stringify(ids));
  for (const id of ids) {
    ok(`preset id 非空且无空格: "${id}"`, id.length > 0 && !/\s/.test(id));
  }
}

/* ── ★ 新增：librarian preset 的结构断言 ──────────────────────────────
 *
 * 这组断言存在的原因：`allowedAgentPresets` 里写了 librarian，
 * 一旦 librarian 注册失败，`validate()` 会 reject → **master 整个变 broken
 * 并从 UI 消失**（见 lib/index.js 里那段注释）。
 * 所以 librarian 能不能起来，直接决定 master 会不会跟着死。
 */
ok('声明了 librarianPlugins 函数', /function librarianPlugins\s*\(/.test(src));
ok('声明了 LIBRARIAN_PREFIX 人格', /const LIBRARIAN_PREFIX\s*=/.test(src));
{
  const libFn = src.match(/function librarianPlugins\(\)[\s\S]*?\n\}/);
  ok('能提取到 librarianPlugins 函数体', libFn !== null);
  if (libFn) {
    const body = libFn[0];

    /**
     * ⚠ 这里必须用**精确的 id 字面量**匹配，不能用子串。
     *
     * 踩过的坑：原来写 `!body.includes('tool-subagent')`，
     * 后来补了 `tool-subagent-control`（send_message 来源），
     * 立刻被这条断言误判成"失败"——因为 'tool-subagent-control' 里含 'tool-subagent'。
     * 这是测试写得太糙，不是代码有问题。
     *
     * 改成匹配 `id: 'xxx'` 的完整字面量。
     */
    const hasId = (id) => body.includes(`id: '${id}'`);

    /* 刻意收窄的项：验证它们真的不在 */
    ok('librarian 不含 tool-workflow（避开 isolate 陷阱）', !hasId('tool-workflow'));
    ok('librarian 不含 workflow-ptc', !hasId('workflow-ptc'));
    ok('librarian 不含 tool-subagent（不派子 agent）', !hasId('tool-subagent'));
    ok('librarian 不含 tool-subagent-list-agents', !hasId('tool-subagent-list-agents'));
    ok('librarian 不含 tool-web（运维不上网）', !hasId('tool-web'));

    /* 刚性要求 */
    ok('librarian 含 tool-pwsh（必须能跑测试）', hasId('tool-pwsh'));
    ok('librarian 含 tool-fs', hasId('tool-fs'));
    /* ★ send_message 来源 —— 不能因为「不派活」把它一起砍掉 */
    ok('librarian 含 tool-subagent-control（能回报）', hasId('tool-subagent-control'));
  }
}
{
  const reg = src.match(/id:\s*'librarian'/);
  ok("注册调用里有 id: 'librarian'", reg !== null);
}
/* 两个 preset 都要经过 tryRegister，避免一个坏了拖垮另一个 */
{
  const regCalls = (src.match(/await tryRegister\(/g) || []).length;
  ok('使用 tryRegister 注册（至少 2 次）', regCalls >= 2, `实际 ${regCalls} 次`);
}

/* 括号配对的粗查（真配平由 ② 的 import 兜底；这里只抓明显失衡） */
{
  const count = (ch) => (src.match(new RegExp('\\' + ch, 'g')) || []).length;
  ok('花括号数量为偶数', count('{') === count('}'), `{=${count('{')} }=${count('}')}`);
  ok('圆括号数量为偶数', count('(') === count(')'), `(=${count('(')} )=${count(')')}`);
  ok('方括号数量为偶数', count('[') === count(']'), `[=${count('[')} ]=${count(']')}`);
}

/* ── ② 真 await import() ──────────────────────────────────────── */
let mod = null;
try {
  mod = await import(pathToFileURL(INDEX_PATH).href);
  ok('lib/index.js 可被 ESM 导入（语法有效）', true);
} catch (e) {
  ok('lib/index.js 可被 ESM 导入（语法有效）', false, e.message);
  console.log(`\n结果：${pass} 通过 / ${fail} 失败 / ${skipped} 跳过`);
  console.log('⚠ 本脚本由无 shell 的会话编写，编写时未执行。');
  process.exit(1);
}

ok('导出 name 存在且为字符串', typeof mod.name === 'string', String(mod.name));
ok('导出 inject 是数组', Array.isArray(mod.inject), JSON.stringify(mod.inject));
ok('inject 含 agentPresets', Array.isArray(mod.inject) && mod.inject.includes('agentPresets'));
ok('导出 apply 是函数', typeof mod.apply === 'function');

/* ── ③ 语法预解析（--check 的等价物） ──────────────────────────── */
/* vm.SourceTextModule 需要 --experimental-vm-modules；
 * 拿不到不算失败（② 的 import 已经证明语法可解析），但必须如实标"跳过"。
 */
try {
  const vmMod = await import('node:vm');
  const SourceTextModule = vmMod.SourceTextModule ?? vmMod.default?.SourceTextModule;
  if (typeof SourceTextModule !== 'function') {
    skip('独立语法预解析', '当前 Node 无 vm.SourceTextModule（需 --experimental-vm-modules）');
  } else {
    try {
      new SourceTextModule(src, { identifier: INDEX_PATH });
      ok('独立语法预解析通过', true);
    } catch (e) {
      ok('独立语法预解析通过', false, e.message);
    }
  }
} catch (e) {
  skip('独立语法预解析', e.message);
}

console.log('\n' + '='.repeat(60));
console.log(`结果：${pass} 通过 / ${fail} 失败 / ${skipped} 跳过 / 共 ${pass + fail + skipped}`);
console.log('⚠ 本脚本由无 shell 的会话编写，编写时未执行。');
process.exit(fail === 0 ? 0 : 1);
