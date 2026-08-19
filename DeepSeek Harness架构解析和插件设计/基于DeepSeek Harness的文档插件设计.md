# LoongBuddy 基于 DeepSeek Harness + OfficeCLI 的智能文档工作空间设计方案

> **文档版本**：V1.0
> **定位**：用于指导基于 DeepSeek Harness 构建类似 WorkBuddy 的智能文档处理能力。
> **核心目标**：实现“左侧大模型 Agent 实时输出 + 右侧原始/实时变化文档 + 用户可随时干预”的交互体验，并支持 Word、Excel、PPT 等办公文档的结构化修改、实时预览、版本管理和人工审批。
---

## 1. 项目背景与目标

用户希望基于 DeepSeek Harness 的插件化 Agent Runtime，结合 [iOfficeAI/OfficeCLI](https://github.com/iOfficeAI/OfficeCLI)，实现类似 WorkBuddy 的文档处理体验：

- 打开原始文档
- Agent 分析文档
- 大模型一边流式输出，一边生成文档修改计划
- 文档按“操作级”实时发生变化
- 用户可以在执行过程中继续输入新的修改要求
- 支持暂停、继续、回滚、确认、拒绝
- 支持文档版本、Diff 和 Checkpoint
- 最终生成新的文档文件

核心体验可以抽象成：

```text
用户输入
   ↓
Harness Agent
   ↓
LLM Stream
   ↓
Document Operation Plan
   ↓
Document Operation
   ↓
OfficeCLI
   ↓
Save / Render
   ↓
Document Event
   ↓
Web UI

左侧：Agent 实时输出
右侧：文档实时变化
底部：用户随时干预
```

---

# 2. 核心设计结论

最重要的设计原则是：

> **不要把“大模型输出内容”和“文档修改过程”做成一个过程。**

应该拆成两个并行、但通过 Operation ID 关联的事件流：

```text
                 Harness Session
                       │
          ┌────────────┴────────────┐
          │                         │
          ▼                         ▼
    Agent Stream              Document Stream
          │                         │
          ▼                         ▼
      Chat Panel              Document View
```

## 2.1 Agent Stream

负责：

```text
agent.delta
agent.message
agent.plan
agent.status
```

例如：

```text
正在分析文档……

我发现文档中有17处阿拉伯数字。

计划：
1. 将普通数字转换成中文大写
2. 年份保持原样
3. 不修改技术参数
```

## 2.2 Document Stream

负责：

```text
document.operation.created
document.operation.started
document.operation.progress
document.operation.completed
document.rendered
document.version.created
```

例如：

```json
{
  "type": "document.operation.progress",
  "operationId": "op-007",
  "index": 7,
  "total": 17,
  "message": "正在处理第 7 处金额"
}
```

这样前端才能真正做到：

```text
左边：AI 正在说什么
右边：文档现在做到了哪一步
```

---

# 3. DeepSeek Harness 与 OfficeCLI 的职责边界

建议形成明确的三层架构：

```text
┌─────────────────────────────────────┐
│         DeepSeek Harness            │
│                                     │
│ Agent / Session / Tool / Approval   │
│ Sandbox / Jobs / Workflow           │
└──────────────────┬──────────────────┘
                   │
                   ▼
┌─────────────────────────────────────┐
│      Document Operation Engine      │
│                                     │
│ DocumentModel / Operation / Version │
│ Event / Checkpoint / Diff           │
└──────────────────┬──────────────────┘
                   │
                   ▼
┌─────────────────────────────────────┐
│           OfficeCLI                 │
│                                     │
│ DOCX / XLSX / PPTX 操作与渲染       │
└─────────────────────────────────────┘
```

三者分别负责：

| 层                        | 主要职责                                                |
| ------------------------- | ------------------------------------------------------- |
| Harness                   | 决定“做什么”、调用哪个 Tool、Session、Approval、Sandbox |
| Document Operation Engine | 决定“具体修改什么”、维护操作、版本、事件和回滚          |
| OfficeCLI                 | 真正执行 Office 文件结构化读写和渲染                    |

这是整个方案最关键的边界。

---

# 4. 为什么不能直接让 LLM 调 OfficeCLI

最简单的实现方式是：

```text
LLM
 ↓
shell
 ↓
officecli set/add/remove
```

这种方式可以快速做 Demo，但不适合商业产品。

问题包括：

1. Agent 可以自由拼接 CLI，难以约束。
2. 无法可靠记录每一步修改。
3. 不容易实现 Diff。
4. 不容易实现版本树。
5. 回滚成本高。
6. 不容易做权限和审批。
7. 用户很难在中间步骤干预。
8. OfficeCLI 未来替换时 Agent 层会被绑定。

因此推荐：

```text
Harness Tool
    ↓
Document Operation
    ↓
OfficeCLI Adapter
    ↓
OfficeCLI
```

也就是说：

> **OfficeCLI 是文档执行后端，不应该成为 Agent 的直接业务接口。**

---

# 5. Document Workspace 产品形态

建议增加一个独立的：

```text
lr-document-workspace
```

负责：

- 当前打开文档
- 当前工作副本
- 当前版本
- Operation Timeline
- 文档预览
- Diff
- Checkpoint
- 回滚
- 用户审批

核心状态模型：

```text
Workspace
│
├── documentId
├── sourcePath
├── workingCopy
├── currentVersion
├── operations[]
├── checkpoints[]
├── renderURL
└── status
```

---

# 6. 总体系统架构

```text
┌───────────────────────────────────────────────────────────┐
│                      LoongBuddy UI                          │
├───────────────────────┬───────────────────────────────────┤
│                       │                                   │
│      Chat Panel       │       Document Workspace          │
│                       │                                   │
│  LLM Stream           │  Document Preview                 │
│  Plan                 │  Live Render                       │
│  Operations           │  Diff                              │
│  Status               │  Version                           │
│                       │  Selection                         │
└───────────────┬───────┴─────────────────┬─────────────────┘
                │                         │
                ▼                         ▼
         Harness Session          Document Workspace
                │                         │
                ▼                         ▼
             Agent                 Document Service
                │                         │
                ▼                         ▼
          Document Tools             OfficeCLI
```

---

# 7. 前端三大核心组件

建议前端拆成：

```text
ChatPanel
DocumentViewport
Composer
```

进一步增加：

```text
OperationTimeline
VersionPanel
DiffPanel
ApprovalPanel
```

---

# 8. ChatPanel 设计

左侧负责展示 Agent 的实时过程：

```text
用户：
请把这个文档中的数字转换成中文大写。

Agent：
正在读取文档……

✓ 找到17处数字

正在执行：
1/17
2/17
3/17
...
```

注意：

> 不要让模型“假装输出”1/17、2/17 这种进度。

真实进度必须来自 Document Operation Event：

```json
{
  "type": "document.operation.progress",
  "operationId": "op-001",
  "index": 7,
  "total": 17,
  "message": "正在处理第7处金额"
}
```

这样 UI 展示的数据才是真实状态。

---

# 9. DocumentViewport 设计

右侧显示当前文档的实时版本。

OfficeCLI 已提供 Office 文档的结构化操作与渲染能力，因此推荐利用 OfficeCLI 的 HTML/PNG/watch 等能力实现 Preview。

推荐链路：

```text
OfficeCLI
   ↓
Render
   ↓
Preview Server
   ↓
DocumentViewport
```

可以采用：

```text
iframe
```

或自研：

```text
Document Canvas
```

第一阶段优先使用 OfficeCLI 的 Preview，降低自研成本。

---

# 10. Document Service

建议增加：

```text
DocumentService
```

核心接口：

```typescript
interface DocumentService {
    open(path: string): Promise<DocumentHandle>;

    inspect(documentId: string): Promise<DocumentModel>;

    find(documentId: string, query: string): Promise<Match[]>;

    apply(
        documentId: string,
        operation: DocumentOperation
    ): Promise<OperationResult>;

    render(documentId: string): Promise<RenderResult>;

    snapshot(documentId: string): Promise<Checkpoint>;

    rollback(documentId: string, checkpointId: string): Promise<void>;

    commit(documentId: string): Promise<CommitResult>;
}
```

---

# 11. Document Intermediate Representation

不要让不同文档格式直接暴露给 Agent。

建立统一的：

```text
DocumentModel
```

例如：

```typescript
interface DocumentModel {
    id: string;
    type: "docx" | "xlsx" | "pptx" | "pdf";
    blocks: Block[];
    metadata: Metadata;
}
```

Block 可以包括：

```text
Paragraph
Heading
Table
Image
List
Page
Slide
CellRange
Chart
Shape
```

这样 Agent 面对的是统一的文档语义，而不是 DOCX XML、XLSX XML 等底层结构。

---

# 12. Word处理架构

```text
DOCX
 ↓
OOXML Parser / OfficeCLI
 ↓
DocumentModel
 ↓
DocumentOperation
 ↓
OfficeCLI
 ↓
DOCX
```

支持操作：

```text
replace_text
insert_text
insert_paragraph
delete_paragraph
update_style
move_block
insert_table
update_table
```

例如：

```json
{
  "operationId": "op-001",
  "documentId": "doc-001",
  "type": "replace_text",
  "target": "/paragraph[12]/run[3]",
  "old": "123456.78",
  "new": "壹拾贰万叁仟肆佰伍拾陆元柒角捌分"
}
```

---

# 13. Excel处理架构

Excel 不能简单看成文本。

应该建模为：

```text
Workbook
 ├── Sheet
 │    ├── Row
 │    ├── Cell
 │    ├── Formula
 │    ├── Style
 │    └── Chart
```

Agent 操作：

```text
rename_sheet
update_cell
insert_row
delete_row
set_formula
format_range
create_chart
```

示例：

```text
用户：
把销售额低于100万的行标红，并增加一个总计行。

Agent：
inspect workbook
    ↓
找到对应 Sheet
    ↓
定位销售额列
    ↓
生成 Operation
    ↓
执行
    ↓
Render
    ↓
实时显示
```

---

# 14. PPT处理架构

PPT 建模为：

```text
Presentation
 ├── Slide
 │    ├── Text
 │    ├── Image
 │    ├── Shape
 │    └── Chart
```

支持：

```text
修改标题
修改正文
增加页面
删除页面
调整页面顺序
生成目录
统一字体
统一版式
增加图表
```

非常适合实时预览，因为每一页修改后都可以重新 Render。

---

# 15. PDF处理架构

PDF 应区别处理。

普通 PDF：

```text
PDF
 ↓
Text Layer
 ↓
DocumentModel
 ↓
Operation
 ↓
Render
```

扫描 PDF：

```text
PDF
 ↓
Page Image
 ↓
OCR
 ↓
DocumentModel
```

PDF 的“修改”需要根据实际需求区分：

- 文本替换
- 注释
- 重排生成新 PDF
- 转 Word 后修改再导出

因此 PDF 不建议和 DOCX 完全共用 Renderer。

---

# 16. Document Operation 层

这是整个系统最关键的抽象。

```typescript
type DocumentOperation =
  | InsertText
  | DeleteText
  | ReplaceText
  | InsertParagraph
  | DeleteParagraph
  | UpdateCell
  | InsertRow
  | DeleteRow
  | InsertSlide
  | DeleteSlide
  | UpdateStyle
  | MoveBlock
  | AddImage
  | AddTable
  | AddChart;
```

每个 Operation 至少包括：

```text
operationId
documentId
type
target
before
after
status
createdAt
createdBy
metadata
```

---

# 17. 为什么 Operation 是核心

只保存：

```text
old.docx
new.docx
```

不足以支持：

- 实时过程
- 审计
- Diff
- Undo
- Redo
- Rollback
- Human-in-the-loop
- 阶段性执行

而有了 Operation：

```text
Step 1 replace_text
Step 2 insert_paragraph
Step 3 update_table
```

就可以构建：

```text
Operation Timeline
Version Tree
Diff
Rollback
Approval
Audit Log
```

---

# 18. “边生成边修改”不应该是 Token 级别

不建议：

```text
LLM Token
 ↓
立即写文档
```

例如模型生成：

```text
“本项目位于北京市朝阳区……”
```

每生成几个字就触发 DOCX 保存，这是不可控且低效的。

原因：

- Token 不一定构成完整语义
- 操作可能不完整
- 文档会频繁写盘
- 可能产生中间非法状态
- 失败恢复困难

---

# 19. 推荐“语义块级流式”

LLM 应输出结构化 Operation。

例如：

```xml
<operation>
{
  "type": "replace",
  "target": "/paragraph[12]",
  "content": "新的内容"
}
</operation>
```

当完整 Operation 解析完成后才执行：

```text
LLM Stream
   ↓
Operation Parser
   ↓
Operation Completed
   ↓
Document Apply
   ↓
Render
```

也就是：

> **Token级流式生成，Operation级流式执行。**

---

# 20. Plan Stream + Operation Stream

建议系统存在两类流：

## Agent Stream

```text
agent.delta
agent.message
agent.plan
agent.status
```

## Document Stream

```text
document.operation.created
document.operation.started
document.operation.progress
document.operation.completed
document.rendered
document.version
```

前端：

```text
Agent Stream
      ↓
ChatPanel

Document Stream
      ↓
DocumentViewport
```

这就是 WorkBuddy 类产品实时体验的关键。

---

# 21. Harness Tool 设计

建议提供统一的 Document Tools：

```text
document.open
document.inspect
document.find
document.replace
document.insert
document.delete
document.format
document.move
document.copy
document.add_table
document.add_image
document.add_chart
document.render
document.snapshot
document.diff
document.rollback
document.commit
```

Agent 看到的是这些高层业务工具，而不是 Shell。

---

# 22. OfficeCLI Adapter

定义：

```typescript
class OfficeCliService {
    async open(path: string);
    async inspect(path: string);
    async get(path: string, selector: string);
    async set(path: string, selector: string, props: object);
    async add(path: string, selector: string, type: string, props: object);
    async remove(path: string, selector: string);
    async render(path: string);
    async watch(path: string);
    async close(path: string);
}
```

Harness Tool 再调用：

```typescript
const documentReplaceTool = defineTool({
    name: "document.replace",
    description: "Replace text or structured document content",
    parameters: {/* schema */},
    execute: async (args) => {
        return officeCli.replace(args);
    }
});
```

这样以后可替换底层执行器：

```text
OfficeCLI Adapter
      ↓
Future Adapter
      ↓
Cloud Office API
```

而不会影响 Agent 层。

---

# 23. 文档状态机

建议定义状态：

```text
IDLE
  ↓
ANALYZING
  ↓
PLANNING
  ↓
WAITING_APPROVAL
  ↓
EXECUTING
  ↓
VERIFYING
  ↓
RENDERING
  ↓
COMPLETED
```

失败：

```text
EXECUTING
    ↓
FAILED
    ↓
ROLLBACK
```

用户取消：

```text
EXECUTING
    ↓
CANCELLED
    ↓
CHECKPOINT
```

---

# 24. 实时 Operation 事件

开始：

```json
{
  "type": "document.operation.started",
  "sessionId": "session-001",
  "documentId": "doc-001",
  "operationId": "op-007",
  "operation": {
    "type": "replace_text",
    "target": "/paragraph[12]",
    "description": "将阿拉伯数字转换成中文大写"
  }
}
```

结束：

```json
{
  "type": "document.operation.completed",
  "sessionId": "session-001",
  "documentId": "doc-001",
  "operationId": "op-007",
  "status": "success",
  "renderVersion": 12
}
```

前端收到：

```text
document.operation.completed
        ↓
加载 renderVersion = 12
        ↓
DocumentViewport 更新
```

---

# 25. 最终调用链

```text
User
 │
 ▼
Chat UI
 │
 ▼
Harness Session
 │
 ▼
Agent
 │
 ├── LLM Stream
 │
 └── Tool Call
       │
       ▼
 document.inspect
       │
       ▼
 Document Service
       │
       ▼
 OfficeCLI
       │
       ▼
 Document Model
       │
       ▼
 Agent Plan
       │
       ▼
 document.replace
       │
       ▼
 Operation Engine
       │
       ▼
 OfficeCLI
       │
       ▼
 Save
       │
       ▼
 Render
       │
       ▼
 Document Event
       │
       ▼
 WebSocket / SSE
       │
       ├──────────► Chat UI
       │
       └──────────► Document UI
```

---

# 26. 阶段性人工干预

这是比普通“AI改文档”更重要的能力。

例子：

当前任务：

```text
17 / 32
```

用户输入：

> 金额不要转换，日期继续转换。

执行过程：

```text
Cancel Current Batch
        ↓
Checkpoint
        ↓
Update User Intent
        ↓
Re-plan
        ↓
Continue
```

这要求 Agent 不把一个长任务绑定成不可中断的黑盒函数，而应由多个可独立执行的 Operation 组成。

---

# 27. Checkpoint 设计

建议每 N 个 Operation 或关键阶段生成 Checkpoint：

```text
v1 原始

checkpoint-1
操作 1~5

checkpoint-2
操作 6~10

checkpoint-3
操作 11~15
```

用户可以：

```text
rollback(checkpoint-2)
```

同时可以建立版本树：

```text
        v1
        │
        ▼
        v2
       /  \
     v3    v3-b
      │
      ▼
      v4
```

---

# 28. 文档版本管理

每一个版本至少记录：

```text
versionId
documentId
parentVersion
operationIds
createdBy
createdAt
filePath
fileHash
renderVersion
```

支持：

```text
Version
Diff
Fork
Revert
Checkpoint
Commit
```

---

# 29. 文档权限与审批

建议将写操作分级：

```text
READ
WRITE_DRAFT
WRITE
DELETE
EXPORT
```

默认策略：

| 操作        | 默认策略   |
| ----------- | ---------- |
| READ        | Allow      |
| WRITE_DRAFT | Allow      |
| WRITE       | Ask        |
| DELETE      | Ask / Deny |
| EXPORT      | Ask        |

核心安全链路：

```text
Original
   ↓
Working Copy
   ↓
AI Modify
   ↓
Preview
   ↓
Human Approve
   ↓
Commit
```

不要让 Agent 默认直接覆盖原始文件。

---

# 30. Document Preview 服务

建议建立独立的：

```text
Document Preview Service
```

结构：

```text
Document Service
      │
      ├── OfficeCLI Process
      ├── Render Service
      └── Preview Server
```

第一阶段可直接复用 OfficeCLI 的：

```text
HTML Preview
PNG Render
Watch
```

后续再考虑自研高性能 Viewer。

---

# 31. 推荐工程目录

```text
lr-agent/
│
├── upstream/
│   └── deepseek-harness/
│
├── plugins/
│   └── lr-document/
│       ├── src/
│       │   ├── plugin.ts
│       │   ├── service/
│       │   │   ├── document-service.ts
│       │   │   ├── operation-service.ts
│       │   │   ├── version-service.ts
│       │   │   └── render-service.ts
│       │   │
│       │   ├── tools/
│       │   │   ├── open.ts
│       │   │   ├── inspect.ts
│       │   │   ├── find.ts
│       │   │   ├── replace.ts
│       │   │   ├── insert.ts
│       │   │   ├── delete.ts
│       │   │   ├── render.ts
│       │   │   ├── rollback.ts
│       │   │   └── commit.ts
│       │   │
│       │   ├── events/
│       │   │   └── document-events.ts
│       │   │
│       │   └── adapters/
│       │       └── officecli/
│       │
│       └── package.json
│
├── services/
│   └── document-preview/
│
└── web/
    └── document-workspace/
        ├── ChatPanel
        ├── DocumentViewport
        ├── OperationTimeline
        ├── VersionPanel
        └── Composer
```

---

# 32. TypeScript + Python 混合架构

Office 文档生态在 Python 中非常成熟，因此推荐：

```text
Harness / TypeScript
        ↓
Document RPC
        ↓
Python Worker
```

Python Worker 负责：

```text
PyMuPDF
python-docx
openpyxl
python-pptx
LibreOffice
OCR
```

TypeScript 负责：

```text
Agent
Plugin
Session
Event
Workflow
UI
```

通信可以采用：

```text
HTTP
Unix Domain Socket
gRPC
```

第一版使用本机 HTTP 或 Unix Domain Socket 即可，后续如果出现高并发或跨进程流式场景，再切 gRPC。

---

# 33. 第一阶段 MVP：只做 DOCX

不建议第一阶段同时支持：

```text
DOCX
XLSX
PPTX
PDF
```

推荐优先跑通 DOCX 全闭环。

目标：

```text
打开文档
 ↓
解析
 ↓
Agent 理解
 ↓
生成修改计划
 ↓
用户确认
 ↓
逐 Operation 修改
 ↓
实时预览
 ↓
Checkpoint
 ↓
最终保存
```

例如：

> 把全文的阿拉伯数字改成中文大写，但年份不要修改。

系统应做到：

```text
Agent 理解约束
        ↓
Find
        ↓
生成 17 个 Operation
        ↓
逐个执行
        ↓
实时更新
        ↓
用户中途干预
        ↓
继续执行
```

---

# 34. 第二阶段：Excel

典型业务：

> 把销售额低于100万的行标红，并增加一个总计行。

流程：

```text
inspect workbook
      ↓
找到 Sheet
      ↓
定位销售额列
      ↓
生成 Operations
      ↓
apply
      ↓
render
      ↓
UI 实时刷新
```

同时支持：

- 单元格修改
- 公式修改
- 行列插入/删除
- Sheet 管理
- 表格操作
- 图表生成
- 格式化

---

# 35. 第三阶段：PPT

典型业务：

> 把这个 PPT 改成科技蓝风格，标题统一，增加一个架构页。

执行：

```text
分析母版
 ↓
分析每页
 ↓
生成修改计划
 ↓
逐页执行
 ↓
逐页 Render
```

UI：

```text
Slide 1 ✓
Slide 2 ✓
Slide 3 ●
Slide 4 ○
```

这会非常接近 WorkBuddy 的实时处理体验。

---

# 36. 第四阶段：视觉检查 Agent

这是后续非常值得做的一项能力。

流程：

```text
Document
 ↓
OfficeCLI Render
 ↓
PNG
 ↓
Vision Model
 ↓
Layout Check
 ↓
发现问题
 ↓
Document Operation
 ↓
再次 Render
```

形成闭环：

```text
生成
 ↓
渲染
 ↓
看
 ↓
修
 ↓
再渲染
```

也就是说，Agent 不仅“会修改文档”，还能够“看见修改结果并进行自检”。

---

# 37. 最终 UI 形态

```text
┌───────────────────────────────────────────────────────────┐
│ LoongBuddy                                                   │
├───────────────────────┬───────────────────────────────────┤
│                       │                                   │
│ AI Agent              │ Document Workspace                │
│                       │                                   │
│ 正在分析文档...       │ ┌──────────────────────────────┐ │
│                       │ │                              │ │
│ 找到 17 个数字        │ │       Live Document          │ │
│                       │ │                              │ │
│ ✓ 1/17               │ │       原始 → 修改中          │ │
│ ✓ 2/17               │ │                              │ │
│ ✓ 3/17               │ │                              │ │
│ ● 4/17               │ │                              │ │
│                       │ └──────────────────────────────┘ │
│                       │                                   │
├───────────────────────┴───────────────────────────────────┤
│ [ 输入新的修改要求... ]                     [暂停] [继续] │
└───────────────────────────────────────────────────────────┘
```

用户最终可以做到：

```text
暂停
继续
撤销
回滚
添加要求
切换版本
接受
拒绝
```

---

# 38. 与 WorkBuddy 类体验的关键对应关系

| 体验                | LoongBuddy 实现                     |
| ------------------- | --------------------------------- |
| 左侧 AI 输出        | Harness Session + Agent Stream    |
| 右侧文档            | Document Workspace                |
| 文档实时变化        | Document Operation + Render Event |
| AI 一边输出一边操作 | Token Stream + Operation Stream   |
| 用户中途继续输入    | Session + Re-plan                 |
| 暂停                | Job/Operation Cancel              |
| 继续                | Resume from Checkpoint            |
| 回滚                | Version/Checkpoint                |
| 原始文档            | Immutable Source                  |
| 工作副本            | Working Copy                      |
| 实时预览            | OfficeCLI Render / Watch          |
| 真实进度            | Document Operation Event          |
| 人工确认            | Harness Approval                  |

---

# 39. 最终推荐架构

```text
                    DeepSeek Harness
                           │
                   Agent / Session
                           │
                     Document Plugin
                           │
                  ┌────────┴────────┐
                  │                 │
             Document SDK      Operation Engine
                  │                 │
                  └────────┬────────┘
                           │
                    OfficeCLI Adapter
                           │
                 ┌─────────┼─────────┐
                 ▼         ▼         ▼
               DOCX      XLSX      PPTX
                 │         │         │
                 └─────────┼─────────┘
                           ▼
                    Render / Preview
                           │
                     Event Stream
                           │
                 ┌─────────┴─────────┐
                 ▼                   ▼
             ChatPanel       DocumentViewport
```

---

# 40. 核心工程原则

## 原则 1：Harness 只做 Runtime

```text
Harness
=
Agent Runtime

LR Plugin
=
Business Capability
```

不要把 Office 业务逻辑直接写死在 Harness Core。

---

## 原则 2：文档一定结构化

不要：

```text
LLM → DOCX
```

应该：

```text
DOCX
 ↓
DocumentModel
 ↓
Operation
 ↓
Version
 ↓
Renderer
```

---

## 原则 3：Token 流和文档修改流分离

```text
LLM Token Stream
       │
       ▼
Operation Parser
       │
       ▼
Document Operation
```

不要 Token 级频繁写文件。

---

## 原则 4：所有写操作可回滚

```text
Original
 ↓
Draft
 ↓
Preview
 ↓
Approval
 ↓
Commit
```

---

## 原则 5：OfficeCLI 作为 Adapter 后端

不要让 Agent 依赖 OfficeCLI CLI 参数格式。

```text
Agent
 ↓
Document API
 ↓
OfficeCLI Adapter
 ↓
OfficeCLI
```

---

## 原则 6：所有过程事件化

```text
Tool
 ↓
Document Event
 ↓
Session
 ↓
WebSocket / SSE
 ↓
UI
```

只有事件化之后，才能实现真正的实时 Workspace。

---

## 原则 7：所有长任务 Job 化

例如：

```text
Parse
Render
Batch Modify
Index
Export
```

统一使用 Job。

---

## 原则 8：Human-in-the-loop 是默认能力

尤其对：

```text
覆盖原文件
大量替换
删除内容
批量格式化
导出/发布
```

默认应该支持确认。

---

# 41. 最终产品定位

LoongBuddy 不应该只是：

```text
“一个调用 OfficeCLI 的 Agent”
```

真正合理的产品定位是：

> **基于 DeepSeek Harness 的 AI Document Workspace。**

其技术栈形成：

```text
DeepSeek Harness
        ↓
Agent Runtime
        ↓
Document Plugin
        ↓
Document Operation Engine
        ↓
OfficeCLI Adapter
        ↓
Office 文档执行
        ↓
Live Render
        ↓
Document Workspace UI
```

最终用户体验：

```text
自然语言
   ↓
Agent
   ↓
分析文档
   ↓
生成计划
   ↓
用户确认/调整
   ↓
逐 Operation 修改
   ↓
实时渲染
   ↓
检查
   ↓
版本保存
   ↓
Commit
```

最终达到类似 WorkBuddy 的核心体验：

> **左侧 AI 实时工作，右侧文档实时变化，用户可以随时介入整个修改过程。**

并进一步提供 WorkBuddy 普通“修改文档”模式之外的工程能力：

- 可追踪 Operation
- 可回滚 Version
- Checkpoint
- Diff
- Human-in-the-loop
- Agent Tool 权限控制
- Sandbox
- Session Replay
- 视觉自检
- 可替换 Document Adapter

这套架构可以作为后续继续扩展到 PDF、Excel、PPT、GIS、云端文件和企业办公自动化的统一 Document Workspace 基础。
