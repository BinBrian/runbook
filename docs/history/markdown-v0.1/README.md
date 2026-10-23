# Windows Runbook 桌面工具

把补丁维护 Markdown 整理成可交互、可追踪、可留档的本地操作手册。V0.1 已实现 Windows 桌面初版，使用 Tauri 2、React、TypeScript、Tiptap/ProseMirror、CodeMirror 6、SQLite、Tailwind CSS 和基于 Radix 的 shadcn 风格组件。

维护指令只会复制到剪贴板。操作者在外部工具执行，再填写结果；应用没有 shell、进程执行或服务器连接入口。

## 开始使用

本机独立开发版位于 `target/debug/runbook-desktop.exe`，双击即可打开，无需启动前端服务。该文件内嵌界面资源，依赖 Windows WebView2 Runtime。本轮未生成安装器、签名或发布包。

1. 新建模板后默认进入“文档”，直接编辑排版后的内容，也可以粘贴 Markdown 或导入 `.md` 文件。
2. 点击正文行后，在该行左侧点“＋”，就地选择步骤、指令、人工检查点或其他元素；空行输入 `/` 也可打开菜单。已有文字会保留，空行直接变为所选元素。也可选中文字通过工具栏转换。步骤与指令显示为卡片，内部标记与 UUID 由系统维护。高级用户可切换“源码”或“源码对照”使用原有 CodeMirror。也可以导入 [已标记示例](../../../examples/patch-maintenance.runbook.md)。示例仅供体验，不代表真实环境可执行流程。
3. 选择主机名、版本或路径等固定文本，点击“设为变量”，填写变量名称和默认值。变量标签连接参数面板，创建独立实例时填写本次参数；也可以导入 [参数化示例](../../../examples/parameterized-maintenance.runbook.md) 体验。高级源码中的入口仍名为“转为变量”。
4. 复制实例中已经替换参数的指令，记录回显，再手动标记完成、失败或跳过；失败和跳过必须填写原因。用“编辑实例”修改本次 Markdown、指令、顺序、检查点或参数，点击“应用并返回执行”更新流程。内容变化的步骤重新待处理，旧轮次继续保留，模板不受影响。
5. 结束并留档，或关闭窗口稍后继续。导出 Markdown 报告供阅读，导出完整 JSON 备份供恢复。

输入约 500 毫秒后自动保存，正常关窗会刷新未保存内容；保存失败会保留输入并提供重试和临时文本导出。异常退出只能保证已确认写入的内容。留档实例只读，再次使用会创建新实例。

模板与实例共用编辑能力，但各自持有文档；实例另外持有自己的参数和执行记录。模板更新不会覆盖已有实例。用“重试 / 再次记录”建立新轮次，用“更正结果”追加修正；修改参数之前的指令、参数值和回显保留在旧轮次中。

数据默认位于 `%LOCALAPPDATA%/local.runbook.desktop/runbook.sqlite3`，WebView 缓存位于同目录的 `webview/`。数据库采用 WAL，请通过应用的完整 JSON 备份功能备份，不在运行中仅复制主数据库文件。导入始终创建独立副本。

当前机器的默认 AppData 目录写入被拒绝，因此本开发副本已通过 EXE 同目录的 `runbook.local.json` 显式配置为 `<仓库目录>/.local-data`。数据库和 WebView 缓存均保存在该目录，清理构建产物不会删除它们。若清理 `target/` 后重新构建，运行 `node scripts/configure-local-data.mjs` 恢复配置再启动；移动工程时需更新配置中的绝对路径。配置无效会报错，不会静默切换数据库。选择规则见 [ADR 0005](../../decisions/0005-explicit-data-directory.md)。

若启动失败，应用会弹出具体错误，并在 EXE 同目录写入 `runbook-startup.log`；该目录不可写时使用 `%TEMP%/Runbook/runbook-startup.log`。日志只包含本次启动阶段、路径和技术错误，不包含文档或执行记录。日志每次启动覆盖；排查问题时请先保留失败那次的日志，不要删除数据库。

## 开发与验证

已验证环境：Windows x64、Node.js 24、pnpm 11.7、Rust 1.99、Visual Studio 2019 C++ 工具链、WebView2。依赖版本固定在 `pnpm-lock.yaml` 与 `Cargo.lock`。

```powershell
cd runbook
pnpm install --frozen-lockfile
pnpm dev                  # Vite + Tauri 开发窗口
pnpm typecheck
pnpm test                 # 编辑变换、IPC队列和退出保护
pnpm test:rust            # 文档核心、SQLite集成、报告
pnpm generate:types       # Rust DTO → TypeScript，不手工改生成类型
pnpm build                # 前端静态资源
pnpm build:desktop        # 内嵌前端的独立开发版，不生成安装器
node scripts/check-desktop.mjs scripts/smoke-visual.mjs # 独立 EXE + 新建隔离库，验收可视化编辑
node scripts/check-desktop.mjs scripts/smoke-context-insert.mjs # 当前行左侧加号与插入位置
```

首次开发需要 Rust MSVC 工具链、C++ 桌面开发组件和 WebView2。当前机器已在项目的 `.toolchain/` 安装 Rust；脚本优先使用该工具链，否则使用系统 PATH。`.toolchain/` 和 `target/` 不属于源码，换机器时需自行准备工具链。所有构建临时文件统一写入 `target/tmp/`。

`pnpm dev:web` 只启动界面服务。浏览器默认提示使用桌面端；`?preview=1` 为明确标识的只读示例预览，不会保存数据，不能用浏览器预览代替原生验收。

`scripts/smoke-desktop.mjs` 连接开发窗口的本地 CDP 调试端口，检查新建模板、人工转换、失败重试、跳过、留档、备份预检和重新载入。只应对隔离测试数据使用；启动测试进程时设置 `RUNBOOK_DATA_DIR` 为项目下的测试目录，以及 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`。调试参数仅用于测试，不写入产品配置。

## 工程与设计

工程组织参考 `deepseek-harness` 的 workspace 与文档分层，应用采用本项目确认的 Tauri 技术路线。

| 目录 / 文档 | 内容 |
| --- | --- |
| `apps/desktop` | React 场景与 Tauri Windows 集成 |
| `packages/core/contracts` | Rust 生成的跨进程类型 |
| `packages/markdown/editor` | 可视化文档、Markdown 原文保留、CodeMirror 与选区转换 |
| `packages/client` | UI 组件与原生调用队列 |
| `native/runbook-core` | 文档语义、执行状态、备份验证 |
| `native/runbook-store` | SQLite 事务、业务操作与幂等回执 |
| [产品需求](docs/prd.md) | 范围与验收标准 |
| [页面交互](docs/interaction.md) | 编辑、执行、历史与恢复 |
| [可视化编辑](../../visual-editor.md) | 默认文档编辑、步骤/指令/变量和原文保留边界 |
| [整体架构](docs/architecture.md) | 模块与数据流 |
| [文档模型](docs/subsystems/document.md) / [执行模型](docs/subsystems/execution.md) / [存储模型](docs/subsystems/storage.md) | 格式、状态和持久化规则 |
| [架构决策](../../decisions/README.md) | 选择依据、代价与当前实现差异 |

## 当前边界

- 参数化和实例独立编辑已纳入当前迭代；置顶、精简模式与快捷键仍属于后续 P1，便签、登录与同步暂缓。
- 文档模式支持常用正文格式、步骤、指令和变量；表格、原始 HTML 等未支持直接编辑的内容保留原文，通过源码修改。内部复制粘贴携带所引用变量，默认值冲突时拒绝整次粘贴，避免覆盖当前参数。
- 初版面向小规模个人本地工作区，加载完整工作区并串行写入。JSON 导入上限为 32 MiB，暂未实现分页、附件或大型日志归档。
- 当前数据库使用 schema 2。打开旧版 schema 1 数据时先在同目录生成 `runbook.sqlite3.schema1-backup-<UUID>.sqlite3` 一致性备份再升级；原有文档和记录保留。JSON 导出为版本 2，导入兼容版本 1 与 2，较新版本会拒绝。
- 使用结构示例完成自动验证，真实补丁文档、效率对照试用、实际剪贴板与原生文件对话框的完整人工验收和安装分发尚待完成。不能据本轮测试宣称已达到减少 25% 操作时间的目标。

验证证据见 [初版验证记录](../../testing.md)；本机实施规划不随公开源码分发。设计、架构及决策文档均保存在本项目。
