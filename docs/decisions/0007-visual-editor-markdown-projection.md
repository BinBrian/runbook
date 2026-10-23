# ADR 0007：可视化编辑与 Markdown 投影

状态：已实现并验证。承接 ADR 0002、0003、0006，保留原文权威和实例/历史边界。

## 背景

源码编辑将文档头、Runbook 标记和 UUID 暴露给用户。用户确认采用类似飞书的所见即所得内容块交互，步骤、指令和变量通过控件操作，源码降为高级入口。

## 决策

使用 Tiptap/ProseMirror 提供富文本编辑、事务和撤销能力，React 自定义节点展示步骤、指令和变量。文档树仅为前端编辑投影，SQLite 继续保存 Markdown，原生 parser/store 继续裁决文档合法性、步骤版本、实例和历史。不增加第二套持久化内容树，不迁移旧库。

Lezer 顶层节点辅助隔离语义标记，普通富文本通过 Markdown 适配器转换。保留原片段及内容签名，未改变的区段原样回写；改变的正文可规范化 Markdown 表达。未知结构保留原文并提供预览和源码入口。指令以专门纯文本节点保存，保留空白和换行；身份和参数定义作为节点/文档属性维护。

模板与实例共享组件但持有独立文档。实例编辑中的复制明确标为草稿指令，复制前经原生参数解析取准确内容；执行流程仍由显式应用更新。自定义步骤复制分配新身份，移动保留身份。

## 取舍

- 保留 CodeMirror 默认源码编辑的实现成本较低，但无法解决用户接触内部标记的问题。
- 全量迁移为 JSON 文档树会改变已有导入导出和数据权威，本次不采用。
- Markdown 适配增加复杂度，须测试命令精度、未知语法和身份。保留区段可以避免普通编辑误改其他内容，但新增或编辑的富文本不承诺排版字节与原写法完全一致。
- 不以通用 Markdown 转换器的输出代替原生校验。非法草稿继续保存，提示修复并可回到源码。

## 验证

2026 年 10 月 15 日完成验证：前端 84 项测试（其中模型 32 项）、TypeScript 检查和独立 EXE 构建通过。真实 Tauri 隔离库验证模式往返、局部编辑、步骤复制/移动/移除、变量与实例历史隔离、Markdown/HTML 粘贴、内部语义复制、长文滚动及归档只读；详情与复现入口见 ../testing.md。数据库与原生存储格式未改变。

## 依据

- [Tiptap React Node Views](https://tiptap.dev/docs/editor/extensions/custom-extensions/node-views/react)：自定义可交互节点。
- [Tiptap Markdown](https://tiptap.dev/docs/editor/markdown)：Markdown 与编辑文档的解析/序列化。
- [ProseMirror Markdown 示例](https://prosemirror.net/examples/markdown/)：源码与结构化编辑间的转换模式。
