# 清单重构实施契约

当前收藏与多选合组规则以 [ADR 0014](decisions/0014-favorite-steps-and-selection-grouping.md) 为准：收藏页不独立编辑，支持单步与整组快照，参数只带原默认值，插入后身份独立；多选合组保留原步骤身份及历史。下文早期步骤块编辑入口仅保留形成时背景。

当前清单实现入口；基础业务范围以 ADR 0008 为准，全局/局部参数和步骤块以 [scoped-blocks-implementation.md](scoped-blocks-implementation.md) 及 [ADR 0009](decisions/0009-scopes-and-reusable-blocks.md) 为准。新增原生实现、最终真实桌面闭环与两次正常退出重启已通过验证，证据见 [testing.md](testing.md)。复用桌面壳，清单数据库为配置目录中的 `checklist.sqlite3`；不读取、迁移或删除旧 `runbook.sqlite3`。测试只写隔离目录。

## 当前工作契约（ADR 0013）

产品移除模板模块。应用读取 checklist_load_work → {workspace,convertedTemplates}，原生按事务转换旧清单定义为未开始工作，同事务备份原始工作区和身份映射。Workspace.templates 转换后为空；已有工作原样保留。只有定义存在才转换，重复读取及删除转换项后不重复生成。旧模板 JSON 预览即转换为工作，随后按原导入事务提交。

新动作 create_work {id,name,document} 直接创建工作并初始化参数默认值；repeat_work {id,name,sourceId,carryValues} 复制来源工作文档，按选项复制已应用值或默认值，创建独立 draft/空条目，清除开始/结束/当前步骤/终止/归档字段。新 work sourceTemplateId=null，sourceInstanceId 仅作追溯，来源后续修改/删除不影响副本。原内部 instance/ZIP 契约继续使用；以下模板动作属于历史读取/旧测试支撑，产品不调用。

前端旧模板草稿依 convertedTemplates 重定向到工作，操作名称/原因及 carryValues 以对象草稿保留；关闭不提交。历史导入与再做一次分别保留进度/清空进度，不混用。

## 数据

新写入采用 `formatVersion=2`，kind 为 template / instance / block。已有清单 v1 可读取，缺省组字段和块集合为空、参数全局；读取不自动改写数据库。变更或导入目标升级 v2，导出升级输出副本而不修改源对象，历史结果数组与快照不重新渲染。原生拒绝使用 v1 版本号混入非空作用域或组结构。旧 Markdown 数据不属于兼容范围。

TextParts 为 `(string | {parameterId: string})[]`；步骤包含 id、title、description、commands 和可选 groupId，命令包含 id、text。参数包含 id、name、description、defaultValue 和可选 ownerId。无 ownerId 为全局，否则必须指向本文件的一个步骤或组；步骤仅能引用全局、本步骤和所属组的参数。Document.groups 为 `{id,name,description?,sourceBlockId?}[]`；组不嵌套，非空且成员连续，组/步骤身份不能碰撞。参数 ID 在文档内唯一，名称可以跨组重复。

Workspace = `{templates: Template[], instances: Instance[], blocks: BlockDefinition[]}`，缺失 blocks 按空数组读取。Template 包含 id、name、document、createdAt、updatedAt（导入旧样例缺少时间时可补默认值）。Instance 完整携带 document、parameterValues、entries、status、currentStepId、来源与时间字段。条目为 result/comment/image；结果快照保存已替换文本与当时参数值；评论含 text、editedAt；图片含 path、mediaType、caption。条目以数组顺序作为相同时间时的稳定顺序。原生保存、导入和每次动作均校验结构、作用域和状态。

状态：draft / in_progress / completed / terminated，archivedAt 独立。当前步骤之前的内容冻结；结果只能追加到当前步骤，完成/跳过后推进，失败停留。结束不可改文档或参数，但可补充、修改评论及删除图片。终止需原因；新副本仅复制文档和当前参数值，从 draft 开始；另存模板保留原默认值。

已推进步骤引用过的参数定义、已推进步骤拥有的全部局部定义和全部推进组拥有的局部定义冻结。所属组的身份、名称和来源冻结；当前步骤身份、位置及 groupId 固定。部分推进组内未推进成员仍可增删重排，且必须满足全局前缀与连续性校验。步骤局部值在本步推进后冻结，组局部值在全组推进后冻结；部分推进组的参数应用只改变未推进步骤，旧结果快照保留。全局参数值可继续为后续步骤修改。

## 步骤块

BlockDefinition 与 Template 字段相同，kind 为 block、格式固定 v2。块必须恰有一个组，所有步骤归本组、参数归本组或其步骤，不能引用外部全局定义。从组保存为块时收集局部定义及引用到的全局定义，将全局引用捕获为局部并重绑身份，保留原默认值，不携带实例填写值、结果、评论或图片。

插入块和复制组由前端纯文档变换实现：分配新的组、步骤、命令、局部参数身份并重绑引用，再通过 save_template / save_instance 持久化和原生最终校验。插入副本自包含且可独立编辑，sourceBlockId 只追溯来源；库修改或删除不更新使用项。实例 ZIP 保存使用副本的完整文档，恢复不依赖块库。

## IPC

- `checklist_load` → Workspace。
- `checklist_apply({action})` → Workspace。动作见下表，属性使用 camelCase。
- `checklist_pick_import` → `{name,bytes:number[]}|null`，原生文件选择。
- `checklist_preview_import({name,bytes})` → `{token,kind,name,id,duplicate}`，缓存通过验证的待导入内容。
- `checklist_commit_import({token,asCopy})` → Workspace。重复且未明确 asCopy 必须拒绝；原实例不变。
- `checklist_export_data({kind,id})` → `{name,bytes:number[]}`；kind 为 template / instance / block，模板与块 JSON / 实例 ZIP。
- `checklist_save_export({name,bytes})` → boolean，原生保存对话框及原子写文件。
- `checklist_attach_image({instanceId,stepId,name,mediaType,bytes})` → Workspace，可供粘贴和文件选择共用；只接受 PNG/JPEG/WebP/GIF，验证签名、限制 8 MiB。
- `checklist_read_image({instanceId,path})` → 图片 data URL，仅允许本实例条目引用的路径。

| action.type | 字段 |
| --- | --- |
| create_template | id, name, document |
| save_template | id, name, document |
| create_block | id, name, document |
| save_block | id, name, document |
| delete_block | id |
| create_instance | id, templateId: string\|null, fromInstanceId: string\|null, name |
| save_instance | id, name, document |
| apply_parameters | id, values: Record<string,string> |
| start_instance | id |
| record_result | id, outcome: completed/failed/skipped, reason: string\|null |
| terminate_instance | id, reason |
| archive_instance | id, archived: boolean |
| save_as_template | id（实例）, templateId（新模板）, name |
| add_comment | id（实例）, stepId, entryId, text |
| edit_comment | id（实例）, entryId, text |
| delete_entry | id（实例）, entryId；仅评论或图片 |

创建和保存草稿可以未填参数；开始前必须补齐所有引用参数，运行中应用参数同样验证。未引用参数可留空。新增参数从原默认值填入，现有实例填写值不会反写默认值。原生新动作生成时间与快照；前端不能提交任意历史结果。save_instance 要求已推进前缀完全不变，当前步骤身份、位置和所属组不变，后续可增删重排；完成/终止仅允许更名或补充材料。

模板和块导出 `.runbook.json`，实例导出 `.runbook.zip`。ZIP 包只含 runbook.json 与已引用图片；图片用包内相对路径。导入限制文件 32 MiB、解包总量 64 MiB，检查路径、重复条目、未知版本、缺失/多余图片、线性记录与原因、结果快照、参数作用域、组结构、块自包含及图片签名。预览 kind 为 template / instance / block，重复导入允许新身份完整还原，不能覆盖本地原对象；复制新工作则不带旧记录。AI 服务密钥和程序配置不进入存档。

前端原生请求全局串行，编辑约 500ms 自动保存；导航、复制、推进及关闭前刷新编辑缓冲，保存失败保留输入、显示重试，不能显示为已保存。实例运行中的参数草稿仅在“应用”时生效。原生层做冻结与记录规则的最终裁决。
