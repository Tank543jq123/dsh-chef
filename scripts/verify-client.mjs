/**
 * verify-client.mjs —— 对 `lib/client.js` 做**真实执行**验证。
 *
 * ⚠ 状态：本脚本**未被执行过**。编写者所在会话没有 shell。
 *   下方每一条断言都只是设计意图，不是已取得的结论。
 *
 * 做法（照搬 `dsh-manuscript/scripts/test-client-load.mjs` 的结构）：
 *   1. `node:vm` 造一个带 `window.__ModuleLoader__` 的上下文，把 client.js 整份跑一遍；
 *      client.js 的形状是 **一次调用** `window.__ModuleLoader__.load({id, factory})`，
 *      所以假 loader 只需捕获 def 对象。
 *   2. 用**真 React**（react + react/jsx-runtime）执行 factory —— 这样才能真正拿到
 *      元素树。jsx 不是数据字面量，注入假 jsx 只能验证「语法能过」，
 *      验证不了「渲染出来的 HTML 里有没有那几句话」。
 *   3. `renderToStaticMarkup` 出 HTML，再断言文案。
 *
 * 与参考脚本的差别（重要）：
 *   参考脚本注入的是 `fakeJsx`，只能证明 factory 不炸；本脚本注入真 React +
 *   renderToStaticMarkup，能证明**渲染结果里确实有目标文案**。
 *
 * 运行：node scripts/verify-client.mjs
 *   （若 react 解析失败，见文件末尾 RESOLVE 说明；也可用 MONOREPO_ROOT 指定。）
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = path.resolve(HERE, '../lib/client.js');

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

/* ── 1. 定位 React ────────────────────────────────────────────────
 * 优先级：显式 MONOREPO_ROOT → 本仓库 node_modules → DSH 安装目录。
 * 三种都试不到就直接失败，**不要静默跳过**（静默跳过会让脚本假绿）。
 */
/* ⚠ 实测：react 不在 DSH 安装目录、也不在本插件目录，而在 **profile 的 node_modules**
 *   （<profile>/node_modules/react，v19.3.0）。
 *   client 插件在浏览器里由宿主注入 react，所以它自己不带 react 依赖 ——
 *   跑离线验证必须去 profile 里借。
 */
const candidates = [
  process.env.DSH_PROFILE_DIR,
  process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'profiles', 'web') : null,
  path.join(os.homedir(), '.dsh', 'profiles', 'web'),
  path.resolve(HERE, '..'),
].filter(Boolean);

let react = null;
let jsxRuntime = null;
let renderToStaticMarkup = null;
const tried = [];
for (const root of candidates) {
  try {
    const req = createRequire(path.join(root, 'noop.js'));
    react = req('react');
    jsxRuntime = req('react/jsx-runtime');
    renderToStaticMarkup = req('react-dom/server').renderToStaticMarkup;
    break;
  } catch (e) {
    tried.push(`${root} → ${e.code || e.message}`);
    react = jsxRuntime = renderToStaticMarkup = null;
  }
}
if (!react || !jsxRuntime || !renderToStaticMarkup) {
  console.log('✗ 无法解析 react / react-dom，未执行任何断言');
  console.log('  尝试过的根：');
  for (const t of tried) console.log('   · ' + t);
  console.log('  提示：设置 MONOREPO_ROOT=<含 node_modules 的目录> 后重试。');
  process.exit(1);
}
ok('解析到 react', true, `version=${react.version ?? '?'}`);

/* ── 2. 假 window + 真 React，跑 client.js ─────────────────────── */
const src = fs.readFileSync(CLIENT_PATH, 'utf8');
ok('client.js 可读', true, `${src.length} 字节`);

let captured = null;
const fakeWindow = {
  __ModuleLoader__: {
    load(def) {
      captured = def;
    },
  },
};

const sandbox = {
  window: fakeWindow,
  document: {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  },
  console,
  setTimeout,
  clearTimeout,
};

try {
  vm.runInNewContext(src, sandbox, { filename: 'client.js' });
  ok('client.js 解析并执行', true);
} catch (e) {
  ok('client.js 解析并执行', false, e.message);
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(1);
}

ok('__ModuleLoader__.load 被调用', captured !== null);
ok('模块 id 为 dsh-plugin-master', captured?.id === 'dsh-plugin-master', String(captured?.id));
ok('factory 是函数', typeof captured?.factory === 'function');

const requireShim = (name) => {
  if (name === 'react') return react;
  if (name === 'react/jsx-runtime') return jsxRuntime;
  // client.js 目前只 require 这两个；多一个就说明有人偷偷加了依赖，应当报错
  throw new Error('client.js require 了未预期依赖: ' + name);
};

let exported = null;
try {
  exported = captured.factory(requireShim);
  ok('factory 执行无异常', true);
} catch (e) {
  ok('factory 执行无异常', false, e.message);
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(1);
}

ok('导出 apply 且为函数', typeof exported?.apply === 'function');
ok('导出 inject 为数组', Array.isArray(exported?.inject), JSON.stringify(exported?.inject));

/* ── 3. 真正渲染 MasterPanel，断言文案 ──────────────────────────── */
/* 面板组件挂在 `main` 槽位上（key = master-chef）。这里不跑整套 slots 宿主，
 * 而是把 apply() 的注册动作录下来，取出主面板渲染函数再真渲染。
 */
const registrations = [];
const fakeCtx = {
  slots: {
    inject(_slot, cb) {
      cb();
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
  },
};

try {
  exported.apply(fakeCtx);
  ok('apply 可执行（slots 注入不抛）', true);
} catch (e) {
  ok('apply 可执行（slots 注入不抛）', false, e.message);
}

ok('注册了 2 个槽位', registrations.length === 2, `实际 ${registrations.length}`);

const sidebar = registrations.find((r) => r.options?.name === 'sidebar.panellist');
const main = registrations.find((r) => r.options?.name === 'main');

ok('注册了 sidebar.panellist', sidebar !== undefined);
ok('注册了 main', main !== undefined);
ok(
  'panellist.id 与 main.key 一致（否则点击导航会抛 main panel not registered）',
  sidebar?.options?.id === main?.options?.key,
  `id=${sidebar?.options?.id} key=${main?.options?.key}`,
);
ok('panellist.label 为「主厨」', sidebar?.options?.label === '主厨', String(sidebar?.options?.label));

/* 真渲染主面板 */
let html = '';
try {
  html = renderToStaticMarkup(react.createElement(main.component, { active: true }));
  ok('MasterPanel 渲染成功', html.length > 0, `${html.length} 字符`);
} catch (e) {
  ok('MasterPanel 渲染成功', false, e.message);
}

/* 用户点名的四条文案 */
const REQUIRED_TEXT = ['主厨', '归档其它会话', '拆活', '它不做什么'];
for (const text of REQUIRED_TEXT) {
  ok(`HTML 含「${text}」`, html.includes(text));
}

/* 侧栏图标也要能单独渲染 —— 它是 panellist 的组件本体 */
try {
  const glyph = renderToStaticMarkup(react.createElement(sidebar.component, {}));
  ok('侧栏图标渲染成功', glyph.includes('<svg'), `${glyph.length} 字符`);
} catch (e) {
  ok('侧栏图标渲染成功', false, e.message);
}

/* ── 4. 归档按钮存在性（静态补充） ────────────────────────────────
 * 按钮的文案在 busy 时变成「归档中…」，初始应为「归档其它会话」。
 * 上面已断言 HTML 含后者，这里补一条反向断言：不应是忙态。
 */
ok('初始不是「归档中…」忙态', !html.includes('归档中…'));

console.log('\n' + '='.repeat(60));
console.log(`结果：${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`);
console.log('⚠ 本脚本由无 shell 的会话编写，编写时未执行。');
process.exit(fail === 0 ? 0 : 1);
