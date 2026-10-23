# GitHub 提交与验证

公开仓库为 [BinBrian/runbook](https://github.com/BinBrian/runbook)，采用 [MIT 许可证](../LICENSE)。本文件说明源码提交范围、验证入口和发布边界。

## 已整理的范围

- 本地仓库采用 `main` 分支，提交包含源码、测试、公开文档、虚构示例及 `pnpm-lock.yaml` / `Cargo.lock`。
- 环境使用 `sandboxa` 至 `sandboxd`，区服、玩家和账号使用不同的虚构编号段；生成脚本、参数引用及测试断言同步。
- 原始业务材料和修改前副本仅保存在被忽略的 `.artifacts/`；已导入的真实工作数据库不改动。
- 本机数据、WebView缓存、工具链、构建产物、验收截图/PPT、启动配置、详细验收记录不进入候选提交。README 的界面预览使用隔离虚构示例采集，作为公开素材保存在 `docs/images/`。公开开发规则见根目录 `CONTRIBUTING.md`。
- README 按简介、界面预览、三组核心功能、获取方式与文档入口组织；Windows 开发前提、依赖安装与数据目录见 [CONTRIBUTING.md](../CONTRIBUTING.md)，验证入口见 [testing.md](testing.md)。

## 首次提交的顺序

1. 核对根目录 `LICENSE` 的 MIT 许可文本与版权信息。
2. 按[测试说明](testing.md)运行类型、测试和构建检查，执行 `pnpm check:repo` 核对候选文件。检查器覆盖本机文件、文件大小、JSON及少量明显凭据模式，不能替代人工检查业务内容。
3. 人工查看示例、文档和 Git 差异，确认没有真实账号、环境、图片或业务材料。测试说明中未完成的系统交互仍如实保留。
4. 核对 Git 作者身份，再执行本地暂存与首个提交：

   ```powershell
   git status --short
   git add .
   git diff --cached --stat
   git diff --cached --check
   git diff --cached
   git commit -m "Initial Runbook source with anonymized examples"
   ```

5. 首次发布使用公开空仓库，配置 `origin` 为 `https://github.com/BinBrian/runbook.git` 后推送 `main`；已有历史通过普通提交更新，不覆盖远端历史。
6. 从 GitHub 克隆到新目录，用系统工具链和锁文件重新安装、测试、构建；这一步通过后再标记“干净克隆验证完成”。

## 验证与后续

2026 年 10 月 23 日完成本地准备：

- 类型检查、186 项前端测试、41 项清单原生测试通过。
- 匿名化示例连续生成两次结果一致，步骤顺序、变量身份和作用域检查通过；存档示例的 JSON 与图片校验通过。
- 离线冻结锁文件检查通过（`--lockfile-only --ignore-scripts`），这不代表全新环境安装已验证。
- `pnpm check:repo` 通过，包含 MIT 许可证及公开界面预览的候选共 282 个文件、约 2.95 MB；已知业务标识扫描、示例 ZIP 内容核对及本地文档链接检查未发现遗留项。首页截图已检查，仅包含虚构演示数据。

公开可复现入口见 [testing.md](testing.md)。上述结果来自已有开发环境，干净机器安装、CI、安装器、签名或 Release 发布尚未验证。Windows CI 可在首次干净克隆构建通过后加入，桌面 GUI 与真实系统对话框仍需有交互会话的独立验收。

源码公开和分发可执行文件是两个步骤；开发 EXE 不应直接加入源码提交。
