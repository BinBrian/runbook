# 测试与已知验证边界

本文件记录可在源码仓库复现的入口。详细逐帧轨迹、验收截图、PPT、原始业务材料和本机路径不随公开源码分发。README 中的公开界面预览单独使用虚构演示数据采集。

## 基础检查

在仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
node scripts/cargo.mjs test --locked -p runbook-checklist
pnpm build:desktop
pnpm check:repo
```

原生离线依赖已缓存时可增加 `--offline`。首次安装需要获取锁文件指定的依赖；本机缓存验证不能证明全新机器已通过。

## 当前桌面专项

先构建独立开发程序，再逐个运行 `node scripts/check-desktop.mjs <脚本路径>`。启动器创建 `target/desktop-smoke-*` 隔离数据，仅管理自己启动的进程。

使用复制请求夹具时，先设置 `$env:RUNBOOK_CLIPBOARD_TEST_MODE='transport'`；这只核对插件请求，不代表实际系统剪贴板验收。

| 脚本 | 主要覆盖 |
| --- | --- |
| `scripts/smoke-step-navigation-advance.mjs` | 92步流程、目录平滑跟随、跨组、末尾、宽窄布局、手动中断、筛选 |
| `scripts/smoke-step-advance-scroll.mjs` | 正文26次连续推进、布局稳定、编辑提交、减少动态效果 |
| `scripts/smoke-acceptance-heading-image.mjs` | 标题单双击/键盘编辑、图片预览关闭 |
| `scripts/smoke-acceptance-panel.mjs` | 变量菜单、窄窗面板、主题颜色 |
| `scripts/smoke-acceptance-workspace.mjs` | 变量直达、引用搜索恢复、参数生效与当前步骤操作 |
| `scripts/smoke-variable-management.mjs` | `{{` 快捷创建、局部转全局、筛选全选与批删、引用固化、草稿及历史锁定 |
| `scripts/smoke-favorites.mjs` | 收藏步骤、插入副本与连续步骤合组 |
| `scripts/smoke-work-records.mjs` | 新建、再做一次、独立内容与记录、归档 |
| `scripts/smoke-work-migration.mjs` | 清单历史模板转换、导入和旧工作保留 |

`node scripts/check-close-drafts.mjs` 独立检查正常关闭、重开和本机草稿恢复。历史脚本可能针对旧界面，不应不加区分地批量运行全部 `smoke-*`。

## 验证结果的含义

2026年10月23日，本机类型检查和186项前端测试通过；目录专项27项、正文连续推进26次及工作区17项定向检查通过。匿名化改变仓库演示内容与测试夹具，没有修改用户已导入的工作。公开准备的检查结果另见[准备记录](public-repository.md)。

同日变量管理补充后，类型检查、204项前端和46项清单原生测试通过；最终桌面变量专项10组、工作区17处回归通过。涵盖快捷创建、作用域提升、批量删除及两主题/宽窄面板；原生测试另核验保存、冻结拒绝、重开和存档恢复。桌面 reload 与原生重开不等于真实桌面进程重启验收。

以下项目须区分：

- transport 模式核对复制插件请求及准确文本，不等于真实 Windows 剪贴板往返。
- 文件对话框返回路径的夹具检查，不等于手动操作真实系统对话框；ZIP、SQLite、图片与导入校验仍实际执行。
- 合成 composition 事件仅检查输入守卫，不等于使用真实中文输入法。
- WebView2 的测试视口尺寸，不等于多屏、DPI或原生窗口拖动验证。

真实剪贴板、系统文件框、中文输入法及干净机器安装仍需独立验收。普通 CI 不应把上述系统交互标记为已经完成。
