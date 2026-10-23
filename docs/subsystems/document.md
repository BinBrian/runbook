# 清单内容模型

当前内容为结构化 JSON。模型权威位于 `native/runbook-checklist/src/model.rs`，前端通过 `apps/desktop/src/checklist/types.ts` 使用同一契约。

新写入模板保存 id、name、document、时间与 formatVersion=2。document 包含 parameters、steps 与可选 groups；参数为稳定 id、显示名称、说明、默认文本值和可选 ownerId，缺省为全局。ownerId 指向某步或组时为局部。步骤包含稳定 id、标题、普通多行说明、命令数组及可选 groupId；命令只有身份和文本，没有执行状态。现有清单 v1 按无组、全局参数读取，旧结果快照保持原样。

标题、说明及命令使用 TextParts：字符串片段或显式 parameterId 引用。普通字符、命令本有的花括号、空白及换行保留；没有 Markdown 解析或文本占位符猜测。界面将引用显示为标签。变量转换只替换选区，复用既有变量引用同一参数。

一步只可引用全局、本步和所属组的参数。不同组同名参数不共享值。组必须单层且成员连续，以平铺 steps 确定顺序；组名、sourceBlockId 仅用于展示与追溯，不形成嵌套或依赖图。

Workspace.blocks 保存独立 kind=block 的自包含单组文档。捕获组为块时收集所需参数定义，外部全局引用本地化；插入时重建所有内部身份和局部引用，原默认值保留，不携带本次值/材料/结果。模板和实例携带插入内容快照，块库改动不自动同步已有使用项。

实例复制完整 document，另存 parameterValues 与执行数据。来源模板 ID 仅供追溯，打开实例无需读取来源。模板更新不影响实例；另存新模板复制当前定义且保留原默认值，本次值不写回默认值。

结构校验见 [模板 Schema](../schema/template.schema.json)及[块 Schema](../schema/block.schema.json)，原生还验证身份、唯一性、作用域、组连续性、文本大小和引用。示例见 [五步维护](../examples/patch-maintenance/README.md)与[复用块](../examples/blocks/README.md)。旧 Markdown 模型属于[历史文档](../history/markdown-v0.1/docs/subsystems/document.md)。
