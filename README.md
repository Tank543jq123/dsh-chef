# 主厨 · Master Agent 插件

> 左侧栏常驻入口 + 一个常驻的总调度 preset。**零业务耦合**。
> 这是一个 DSH Web 插件，不是独立程序。

## 它是什么

| 部分 | 作用 |
|:---|:---|
| **host 半** `lib/index.js` | 启动时注册两个 agent preset：`master`（主厨）与 `librarian`（书阁运维） |
| **client 半** `lib/client.js` | 左栏常驻「主厨」入口 + 主区面板 |
| **bundle patch** `cordis.patch.yml` | 让宿主把本包装进 profile 组装；没有它插件不起作用 |

它只负责**调度结构**：给主厨一个常驻入口、一个总调度 preset，以及一个只对书阁有写权的 librarian preset。它不绑定任何业务项目，也不替用户决定 profile 里装什么。

## 安装

前置：DSH Web、Node ≥ 22。插件以 `link:` 方式装进目标 profile：

```bash
cd ~/.dsh/profiles/<profile>
pnpm add link:/path/to/dsh-plugin-master
# 在 profile 的 package.json 里把 "dsh-plugin-master" 加进
#   dsh.profile.bundles
# 然后重启 DSH（不是刷新页面）
```

装完左栏会出现「主厨」入口。

> `librarian` preset 面向书阁（dsh-manuscript）：默认数据目录 `~/.dsh/dsh-manuscript`，源码目录由 `DSH_MANUSCRIPT_SRC` 指定。没装书阁时它仍可注册，但没有可操作的数据。

## 验证

```bash
npm install            # 只为测试装 react / react-dom
node scripts/verify-preset.mjs
node scripts/verify-librarian.mjs
node scripts/verify-client.mjs
```

- `verify-client` 现在按 `DSH_PROFILE_DIR` → `DSH_HOME/profiles/web` → `~/.dsh/profiles/web` → 仓库 `node_modules` 的顺序找 React，不再依赖作者本机路径。
- 三个脚本合计约 100 条断言；具体以当前输出为准。

## 已知边界（不粉饰）

- **没有在真实浏览器里点过归档按钮**：服务端渲染与离线组件测试通过，真实点击路径未验证。
- **没有任务台账**：面板里「拆活/派活/验收/汇总」是说明文字，不是运行状态。
- **「自动派发」未实现**：`tool-schedule` 只提供被唤醒手段，不等于会自己接活。
- **YAML 与 JS 双份定义**：`presets/librarian.patch.yml` 与 `lib/index.js` 的 `librarianPlugins()` 是两份定义；运行时只读 JS，YAML 需人工同步。
- **需要重启 DSH** 才生效；`pnpm install` 可能把 `dsh.profile.bundles` 里本插件条目删掉，安装后要复查。
- Windows / POSIX 的命令片段都未做跨平台全量验证。

更长的开发历史和逐条证据在 [docs/DEVELOPMENT_LOG.md](docs/DEVELOPMENT_LOG.md)；其中 UNVERIFIED / FAIL 项按原样保留，不升级。

## 许可

未声明；仓库已公开（2026-11-10）。如果用于分发或生产，请先明确许可证。
