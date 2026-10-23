# 开发约定

Runbook 是本地优先的 Windows 桌面工具。命令仅用于显示与复制；维护操作由用户在外部工具完成。工作文档、参数及记录使用独立快照，已推进内容与结果不可被后续编辑覆盖。

## 本地开发

已在 Windows、Node.js 24.19.0、pnpm 11.7.0、Rust/Cargo 1.99.0 下验证。新机器需要 Node.js 24、`packageManager` 指定的 pnpm、Rust MSVC 工具链、Visual Studio C++ 生成工具及 Windows SDK、WebView2 运行时。Python 3 只用于重新生成和检查示例。

在仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

独立程序使用 `pnpm build:desktop` 构建，输出到 `target/debug/runbook-desktop.exe`，内嵌界面资源。这是开发 EXE，不生成安装器；源码仓库不包含预编译程序。`pnpm dev:web` 仅启动前端，不能替代原生数据实现。

脚本优先使用可选的项目内 `.toolchain/`，不存在时使用系统 PATH 中的 Rust，无须复制其他开发者的工具链。当前源码目录和模块职责见[整体架构](docs/architecture.md)。

## 开发数据目录

数据目录优先级为 `RUNBOOK_DATA_DIR` → EXE 同目录 `runbook.local.json` 的 `dataDirectory` → Windows AppLocalData；遇错明确报错，不静默换库。

开发时可运行 `node scripts/configure-local-data.mjs`，将数据明确放到当前仓库的 `.local-data/`；脚本不覆盖已有的不同配置。数据、配置和启动日志不进入 Git。启动失败会显示原生提示并写 `runbook-startup.log`。备份通过应用导出完整工作存档。

## 实现边界

- 原生数据、状态、存档及冻结规则以 `native/runbook-checklist/` 为准；前端通过 `checklist_*` IPC 请求动作。
- 当前前端入口是 `apps/desktop/src/checklist/`。旧 Markdown 模块及历史模板脚本只作兼容参考，不是新增产品功能的依据。
- 改动状态或格式时，同步核对 Rust DTO、前端 `types.ts`、导入校验和定向测试。
- 变量按稳定 ID 与作用域绑定；同名不等于同一个变量。草稿不能替代已应用参数，历史显示冻结快照。
- 前端与原生测试使用隔离数据；不要用真实工作记录作为夹具，也不要让验证脚本运行维护命令。

## 提交前验证

安装依赖后，至少执行类型检查、相关前端或原生测试。交互改动用当前桌面专项脚本验证，滚动改动检查逐帧过程与最终位置。命令和验证边界见[测试说明](docs/testing.md)。

提交源文件和锁文件，不提交 `target/`、`.local-data/`、`.toolchain/`、`.artifacts/`、`reports/` 等本机目录。示例采用明确的虚构标识，生成示例先修改生成入口，再检查重复生成不产生差异。提交前运行 `pnpm check:repo`，并人工查看完整差异。

维护及收藏步骤示例使用 `python scripts/generate-scoped-examples.py` 重新生成，不会修改已导入的工作。首次公开的操作顺序见[公开仓库准备](docs/public-repository.md)。

本项目采用 [MIT 许可证](LICENSE)。仓库位于 [BinBrian/runbook](https://github.com/BinBrian/runbook)，问题和改进建议通过仓库 Issues 提交。
