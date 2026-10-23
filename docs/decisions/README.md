# Runbook 架构决策

决策记录说明结构性选择、备选方案和代价；当前结构与实体边界见[整体架构](../architecture.md)和[清单实施契约](../checklist-implementation.md)。参考 deepseek-harness 的决策与架构分离方式，Runbook 将面向项目成员的记录放在 `docs/decisions/`。

| 决策 | 状态 | 主题 |
| --- | --- | --- |
| [0001 工程组织与原生核心](0001-workspace-and-native-core.md) | 历史设计基线 | 原工程分层，Rust 管理语义与持久化 |
| [0002 Markdown 与稳定身份](0002-markdown-and-stable-identity.md) | 历史设计基线 | 显式标记、原文权威、草稿与应用版本 |
| [0003 独立实例与记录历史](0003-run-snapshots-and-attempt-history.md) | 历史设计基线 | 快照、内容版本、重试与状态更正 |
| [0004 独立仓储与嵌套备份](0004-store-and-nested-backup.md) | 历史版本已实现 | 独立 store、关系列加 payload、初版嵌套备份 |
| [0005 显式数据目录与启动诊断](0005-explicit-data-directory.md) | 已实现，清单版沿用 | 受限目录下的显式配置与无窗口错误反馈 |
| [0006 参数与独立实例编辑](0006-parameters-and-independent-instances.md) | 历史版本已实现并验证 | 参数定义、实例独立值、显式应用及历史快照 |
| [0007 可视化编辑与 Markdown 投影](0007-visual-editor-markdown-projection.md) | 历史版本已实现并验证 | 默认块编辑、原文保留、纯文本指令及高级源码入口 |
| [0008 结构化 JSON 内容与可选 AI 扩展](0008-json-content-and-optional-ai.md) | 已实现，2026-10-20 桌面闭环验收通过 | JSON 清单、独立实例、人工记录与 ZIP 存档；AI 尚待扩展 |
| [0009 参数作用域与可复用步骤块](0009-scopes-and-reusable-blocks.md) | 已实现，2026-10-20 桌面闭环验收通过 | 全局/步骤/组内参数、独立块定义、插入副本与 v2 存档 |
| [0010 一体化窗口标题栏](0010-integrated-window-titlebar.md) | 已实现，2026-10-20 真实窗口验收通过 | 复用应用顶栏、原生窗口操作与关闭保存保护 |
| [0011 就地编辑与变量上下文](0011-inline-editing-and-variable-context.md) | 已实现，2026-10-20 桌面验收通过 | 右侧作用域变量、选区复用、双击编辑和仅视图空占位 |
| [0012 本机草稿与正常关闭](0012-local-drafts-and-close.md) | 已实现，2026-10-21 真实退出重开验收通过 | 未提交输入独立保存、草稿定位、正常关闭及真实保存失败的退出选择 |
| [0013 工作记录本身就是复用起点](0013-work-records-as-prototypes.md) | 已实现，2026-10-21 隔离桌面验收通过 | 取消模板模块、直接新建、再做一次、独立参数与历史、已有清单定义安全转换 |

| [0014 收藏步骤与多选合组](0014-favorite-steps-and-selection-grouping.md) | 已实现，2026-10-21 隔离桌面验收通过 | 工作单步/组收藏、独立快照插入、明确更新与连续步骤合组 |

“设计基线”表示用于后续实现的方案，不表示已经交付。实现验证后更新为已实现并补充验证证据；方案改变时增加替代决策和关联，不将旧结论静默写成新结论。

0008 是 2026 年 10 月 20 日确认并实施的清单重构：从当前需求重新设计，不要求兼容 Markdown、旧数据格式或历史方案，亦不承担旧库迁移。新桌面业务使用独立 `native/runbook-checklist` 与 `checklist.sqlite3`，旧数据不读取、不迁移、不删除。当日真实 WebView2 闭环、系统剪贴板、原生存档与导入提交、两次正常退出重启验收通过；系统文件选择框未自动操作，返回内容和保存目的地使用夹具替换，详见[验证记录](../testing.md)。AI 配置与服务接入尚未实现。

0001–0007 保留旧版形成时的背景与验证条件，其中 0005 的路径选择和启动诊断继续沿用。其他旧模型、轮次、Markdown 投影和备份结构不约束新清单版；旧产品与子系统文档见[历史归档](../history/markdown-v0.1/README.md)。
