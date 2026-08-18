# LR-Agent 基于 DeepSeek Harness 的本地-云端协同智能体平台架构设计

 
> **核心目标**：在 Harness 插件化 Agent Runtime 的基础上，增加云端协同、本地数据处理、智能文档处理、GIS 工作空间三大能力，并形成可扩展、可维护、可商用的整体架构。


# 1. 项目概述

## 1.1 项目背景

DeepSeek Harness 的核心思想是：

> **Everything is a Plugin**

Harness 并不是一个需要不断修改核心 Agent Loop 的传统 Agent 框架，而是通过插件化机制提供：

- Agent Runtime
- Tool
- Session
- File System
- Sandbox
- Approval
- Jobs
- Workflow
- Web
- Client Modules
- LLM

等能力扩展点。

LR-Agent 不建议直接大规模修改 Harness Core，而应该通过 Harness 官方 Extension Point 进行二次开发：

```text
DeepSeek Harness
       +
LR Plugins
       +
LR Web UI
       +
LR Services
```

最终形成一个：

> **Local + Cloud + Document + GIS + Agent Workflow 的智能体工作空间平台**

---

# 2. 产品定位

LR-Agent 最终不是一个简单的 ChatBot，而是一个：

> **Agentic Workspace（智能体工作空间）**

核心理念：

```text
用户
 ↓
自然语言
 ↓
Agent
 ↓
工具 / 数据 / 文档 / GIS / 云服务
 ↓
实时执行
 ↓
人工干预
 ↓
最终结果
```

产品同时具备：

```text
Agent Runtime
+
Local Agent
+
Cloud Agent
+
Document Agent
+
GIS Agent
+
Workflow
+
Human-in-the-loop
```

---

# 3. 总体架构

```text
                         Internet
                            │
                            ▼
              ┌──────────────────────────┐
              │      Cloud Services      │
              │                          │
              │ Cloud API                │
              │ Object Storage           │
              │ GIS Service              │
              │ OAuth / IAM              │
              │ Notification             │
              └────────────┬─────────────┘
                           │
                     HTTPS / WSS
                           │
                           ▼
┌───────────────────────────────────────────────────────────────┐
│                     Local Machine                            │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                  DeepSeek Harness                      │ │
│  │                                                         │ │
│  │ Agent Runtime                                           │ │
│  │ Tool Registry                                           │ │
│  │ Session                                                 │ │
│  │ Approval                                                │ │
│  │ Sandbox                                                 │ │
│  │ Jobs                                                    │ │
│  │ Workflow                                                │ │
│  └─────────────────────────────────────────────────────────┘ │
│                     │            │             │              │
│            ┌────────┘            │             └────────┐     │
│            ▼                     ▼                      ▼     │
│     Cloud Plugin         Document Plugin           GIS Plugin│
│            │                     │                      │    │
│            ▼                     ▼                      ▼    │
│       Cloud Gateway       Document Engine          GIS Gateway│
│            │                     │                      │    │
│            ▼                     ▼                      ▼    │    │
│       Local Cache          PDF/Office Engine        GIS SDK   │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                    Web UI                              │ │
│  │                                                         │ │
│  │ Chat │ Files │ Documents │ GIS │ Tasks │ Settings      │ │
│  └─────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

---

# 4. 核心设计原则

## 4.1 不修改 Harness Core

不建议大规模修改：

```text
Agent Loop
Tool Pipeline
Session
FS
Sandbox
Web
```

而应该：

```text
Harness Core
   │
   ├── 官方 Plugins
   ├── LR Cloud Plugin
   ├── LR Document Plugin
   ├── LR GIS Plugin
   ├── LR Workflow Plugin
   └── LR Office Plugin
```

---

# 5. Harness 能力映射

LR-Agent 重点利用 Harness 的以下能力：

| Harness 能力 | LR-Agent 用途 |
|---|---|
| `ctx.llm` | LLM 推理 |
| `ctx.agents` | Agent 管理 |
| `ctx.tools` | Cloud / Document / GIS Tool |
| `ctx.fs` | 本地文件 |
| `ctx.sandbox` | 安全执行 |
| `ctx.approval` | 人工审批 |
| `ctx.jobs` | 长耗时任务 |
| `ctx.web` | Web访问 |
| `ctx.workflowEngine` | 跨 Agent 工作流 |
| `ctx.clientModules` | 文档/GIS前端扩展 |
| `ctx.webServer` | Plugin API |

核心思想：

```text
Harness
   ↓
Capability Seam
   ↓
LR Plugin
```

---

# 6. 三大核心能力

LR-Agent 第一阶段核心建设三大能力：

```text
┌─────────────────────────────┐
│ 1. Cloud + Local Agent      │
│    云端协同、本地数据接入    │
└──────────────┬──────────────┘
               │
┌──────────────▼──────────────┐
│ 2. Document Agent           │
│    Word/Excel/PPT/PDF       │
│    实时修改、版本管理        │
└──────────────┬──────────────┘
               │
┌──────────────▼──────────────┐
│ 3. GIS Agent                │
│    地图、图层、空间分析       │
│    嵌入 Harness Workspace    │
└─────────────────────────────┘
```

---

# 7. 第一大功能：云端协同本地 Agent

# 7.1 设计目标

建立：

> **Cloud Data Plane + Local Execution Plane**

即：

### 云端

负责：

- 用户
- 组织
- 租户
- 权限
- Agent 配置
- 云端文件
- 云端数据
- GIS 服务
- OAuth
- 远程 API

### 本地

负责：

- Agent 执行
- 本地文件
- 本地模型
- 本地缓存
- 文档处理
- 数据分析
- 敏感信息处理

---

# 7.2 Control Plane / Data Plane

```text
            Cloud
┌─────────────────────────────┐
│ Control Plane               │
│                             │
│ User                        │
│ Organization                │
│ Tenant                      │
│ Permission                  │
│ Agent Config                │
│ Task                        │
│ Device                      │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│ Data Plane                  │
│                             │
│ Object Storage              │
│ Database                    │
│ Business API                │
│ GIS                         │
└──────────────┬──────────────┘
               │
          HTTPS / WSS
               │
               ▼
┌─────────────────────────────┐
│ Local Agent                 │
│                             │
│ Harness                     │
│ Cloud Plugin                │
│ Document Agent              │
│ GIS Agent                   │
└─────────────────────────────┘
```

---

# 7.3 Cloud Plugin

建议目录：

```text
plugins/
└── lr-cloud/
    ├── cloud/
    │   ├── service.ts
    │   ├── provider.ts
    │   ├── types.ts
    │   └── errors.ts
    │
    ├── tools/
    │   ├── cloud_search.ts
    │   ├── cloud_get.ts
    │   ├── cloud_download.ts
    │   ├── cloud_upload.ts
    │   └── cloud_sync.ts
    │
    ├── auth/
    │   ├── oauth.ts
    │   └── credential.ts
    │
    └── index.ts
```

---

# 7.4 Cloud Tools

向 Agent 暴露：

```text
cloud.list
cloud.search
cloud.get
cloud.download
cloud.upload
cloud.update
cloud.sync
cloud.create_task
cloud.task_status
```

例如：

```text
用户：
把云端项目 A 最新的设计文档下载下来分析。

Agent：

cloud.search
      ↓
找到 document.pdf
      ↓
cloud.download
      ↓
Local Workspace
      ↓
Document Agent
      ↓
分析
```

---

# 7.5 云端凭据安全

禁止让 Agent 直接长期持有：

```text
AWS Secret
OSS Secret
GIS Token
Database Password
```

推荐：

```text
Agent
 ↓
Cloud Tool
 ↓
Credential Provider
 ↓
短期 Token
 ↓
Cloud API
```

凭据应该由统一 Credential Service 管理。

---

# 7.6 本地缓存

建议目录：

```text
~/.lr-agent/
├── cache/
│   ├── cloud/
│   ├── documents/
│   └── gis/
│
├── workspace/
├── sessions/
├── credentials/
└── indexes/
```

通过：

```text
remote_hash
local_hash
remote_version
last_sync
```

实现增量同步。

---

# 7.7 云端同步

流程：

```text
Cloud File
     ↓
Hash / Version
     ↓
Local Cache
     ↓
Local Index
```

发生修改：

```text
Cloud Changed
     ↓
Compare
     ↓
Sync
```

双向修改：

```text
Local Changed
+
Remote Changed
      ↓
Conflict Detection
      ↓
Human Review
```

---

# 8. 第二大功能：Document Agent

# 8.1 核心目标

Document Agent 不应该只是：

```text
上传Word
 ↓
AI修改
 ↓
下载
```

而应该设计成：

> **Document Workspace**

用户可以看到：

```text
原文档
AI修改计划
修改步骤
修改过程
实时预览
版本
Diff
用户反馈
最终提交
```

---

# 8.2 Document Workspace

```text
┌──────────────────────────────────────────┐
│ 文档工作空间                              │
├──────────┬──────────────┬────────────────┤
│ 原始文档 │ AI修改过程   │ 当前版本        │
├──────────┼──────────────┼────────────────┤
│ DOCX     │ Step 1 ✓     │ Preview        │
│          │ Step 2 ✓     │                │
│          │ Step 3 ●     │                │
└──────────┴──────────────┴────────────────┘
```

---

# 9. 文档处理引擎

不能让 LLM 直接修改二进制文件。

必须：

```text
Original Document
       ↓
Parser
       ↓
Document Model
       ↓
AI Operation
       ↓
Patch
       ↓
Render
       ↓
New Document
```

---

# 9.1 Document Intermediate Representation

统一定义：

```typescript
interface DocumentModel {
    id: string
    type: "docx" | "xlsx" | "pptx" | "pdf"
    blocks: Block[]
    metadata: Metadata
}
```

Block 可以包含：

```text
Paragraph
Heading
Table
Image
List
Page
Slide
CellRange
```

---

# 10. Word处理

```text
DOCX
 ↓
OOXML Parser
 ↓
DocumentModel
 ↓
Operation
 ↓
DOCX Renderer
```

典型操作：

```text
replace_text
insert_paragraph
delete_paragraph
update_style
move_block
```

例如：

```json
{
  "op": "replace_text",
  "target": "甲方",
  "replacement": "北京XX科技有限公司"
}
```

---

# 11. Excel处理

Excel不能简单当成文本。

模型：

```text
Workbook
 ├── Sheet
 │   ├── Row
 │   ├── Cell
 │   └── Formula
```

Agent Operations：

```text
rename_sheet
update_cell
insert_row
delete_row
set_formula
format_range
create_chart
```

例如：

```text
用户：
把2025年度收入增加10%。

Agent：
识别 Sheet
 ↓
定位金额区域
 ↓
修改公式/数值
 ↓
预览
 ↓
等待确认
 ↓
提交
```

---

# 12. PPT处理

模型：

```text
Presentation
 ├── Slide
 │   ├── Text
 │   ├── Image
 │   ├── Shape
 │   └── Chart
```

支持：

```text
修改标题
重新组织页面
调整文字
补充页面
删除页面
生成目录
统一风格
```

---

# 13. PDF处理

PDF需要单独设计。

普通 PDF：

```text
PDF
 ↓
Text Layer
 ↓
DocumentModel
 ↓
修改
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

---

# 14. Document Operation

建议定义统一操作协议：

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
```

---

# 15. 为什么必须使用 Operation

如果只有：

```text
old.docx
new.docx
```

前端无法实时知道：

```text
AI到底改了什么
```

使用 Operation 后：

```text
Step 1
replace_text

Step 2
insert_paragraph

Step 3
update_table
```

UI 就可以实时显示：

```text
✓ 修改项目名称
✓ 修改项目背景
● 正在补充项目目标
○ 正在调整表格
```

---

# 16. 实时修改机制

增加 Document Events：

```text
document/open
document/parse
document/plan
document/operation-start
document/operation-progress
document/operation-complete
document/render
document/checkpoint
document/commit
document/revert
```

例如：

```json
{
  "type": "document/operation-progress",
  "operation_id": "op_001",
  "progress": 0.65,
  "description": "正在修改第三章项目实施计划"
}
```

前端通过：

```text
WebSocket / SSE
```

实时显示。

---

# 17. Human-in-the-loop

文档操作建议设计为：

```text
Draft
 ↓
AI Plan
 ↓
User Review
 ↓
Apply Step 1
 ↓
User Prompt
 ↓
Apply Step 2
 ↓
User Review
 ↓
Commit
```

例如：

用户：

> 把这份项目方案改得更正式。

Agent：

```text
修改计划：

1. 优化标题
2. 重写项目背景
3. 调整章节层级
4. 规范术语
5. 不修改技术参数
```

执行：

```text
Step 1 ✓
Step 2 ✓
Step 3 ●
```

用户：

> 项目背景不要太夸张，少用“领先”“行业第一”。

Agent：

```text
修改策略：

减少营销词
增加事实性描述
```

继续下一阶段。

---

# 18. 文档版本树

建议：

```text
Document
│
├── v1 原始版本
│
├── v2 AI第一次修改
│
├── v3 用户反馈后
│
├── v4 AI第二次修改
│
└── v5 最终版本
```

必要时支持：

```text
Fork
Revert
Diff
Checkpoint
Commit
```

---

# 19. Document Plugin目录

```text
plugins/
└── lr-document/
    ├── core/
    │   ├── document-service.ts
    │   ├── document-model.ts
    │   ├── operation.ts
    │   └── version.ts
    │
    ├── parsers/
    │   ├── pdf/
    │   ├── docx/
    │   ├── xlsx/
    │   └── pptx/
    │
    ├── renderers/
    │   ├── pdf/
    │   ├── docx/
    │   ├── xlsx/
    │   └── pptx/
    │
    ├── tools/
    │   ├── document_open.ts
    │   ├── document_read.ts
    │   ├── document_edit.ts
    │   ├── document_preview.ts
    │   ├── document_apply.ts
    │   └── document_revert.ts
    │
    ├── events/
    ├── storage/
    └── index.ts
```

---

# 20. Python Document Worker

由于 PDF/Office 生态丰富，推荐：

```text
Harness / TypeScript
        ↓
Document RPC
        ↓
Python Worker
```

Python 负责：

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

通信可以使用：

```text
HTTP
Unix Domain Socket
gRPC
```

---

# 21. 第三大功能：GIS Agent

GIS 不建议仅仅实现成 Tool。

应该做：

> **GIS Workspace Plugin**

即：

```text
GIS Tool
+
GIS Agent
+
GIS Web Client
```

---

# 22. GIS Plugin架构

```text
GIS Plugin
│
├── GIS Service
│
├── GIS Agent Tools
│
└── GIS Web Client
```

---

# 23. GIS Provider抽象

定义统一接口：

```typescript
interface GISProvider {

    getMap()

    listLayers()

    queryFeatures()

    spatialQuery()

    getFeature()

    identify()

    getLayerMetadata()

}
```

后续可以对接：

```text
ArcGIS
GeoServer
MapGIS
SuperMap
PostGIS
Cesium
MapLibre
Mapbox
```

通过 Provider 抽象避免和某个 GIS 服务强绑定。

---

# 24. GIS Agent Tools

例如：

```text
gis.list_layers
gis.search_layer
gis.query_features
gis.spatial_query
gis.identify
gis.get_feature
gis.get_statistics
gis.export
```

用户：

> 找出上海市范围内所有医院。

Agent：

```text
gis.search_layer
        ↓
hospital layer
        ↓
gis.spatial_query
        ↓
Feature
        ↓
Map Highlight
```

---

# 25. 高级 GIS Agent

例如：

> 找出距离地铁站500米以内的医院。

Agent：

```text
查询医院图层
+
查询地铁图层
+
Buffer
+
Spatial Intersection
```

结果：

```text
地图显示
+
统计结果
+
数据表
```

---

# 26. GIS嵌入 Harness

不建议第一版只使用 iframe。

推荐：

```text
Harness Web
      ↓
GIS Client Module
      ↓
GIS Map SDK
      ↓
GIS API
```

GIS 前端使用 Harness 的 `ctx.clientModules` 接入。

可以实现：

```text
GIS Sidebar
GIS Workspace
GIS Panel
GIS Command Palette
```

---

# 27. GIS UI设计

```text
┌───────────────────────────────────────────────┐
│ LR-Agent                                      │
├─────────────┬─────────────────────────────────┤
│             │                                 │
│ Agent Chat  │          GIS Map               │
│             │                                 │
│           ┌─┤        ┌──────────────┐        │
│           │ │        │              │        │
│           │ │        │     Map      │        │
│           │ │        │              │        │
│           │ │        │              │        │
│           │ │        └──────────────┘        │
│           │ │                                 │
│           │ │ Layers                          │
│           │ │ ☑ Roads                         │
│           │ │ ☑ Hospitals                     │
│           │ │ ☐ POI                           │
│             │                                 │
└─────────────┴─────────────────────────────────┘
```

---

# 28. Agent控制GIS

用户：

> 放大到北京。

Agent：

```text
set_viewport
```

地图：

```text
自动移动
```

用户：

> 显示2025年的道路数据。

Agent：

```text
set_layer_filter
```

地图自动变化。

用户：

> 查询刚才这个医院。

Agent：

```text
identify
```

返回：

```text
医院名称
地址
等级
床位
```

---

# 29. GIS与Document联动

例如：

> 把这个 GIS 区域导出成报告。

流程：

```text
GIS
 ↓
统计
 ↓
地图截图
 ↓
Document Agent
 ↓
生成 Word/PDF
```

最终：

```text
GIS分析
+
地图截图
+
统计表
+
分析结论
```

---

# 30. 三大模块联动

三个 Agent 不应该孤立。

```text
                    Harness
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
   Cloud Agent    Document Agent   GIS Agent
        │              │              │
        └──────────────┼──────────────┘
                       │
                    Workflow
```

---

# 31. 典型跨模块场景

## 场景1：云端文档 → 本地分析

```text
Cloud Agent
     ↓
下载 PDF
     ↓
Document Agent
     ↓
解析
     ↓
总结
```

---

## 场景2：GIS → 报告

```text
GIS Agent
     ↓
空间分析
     ↓
统计
     ↓
Document Agent
     ↓
生成 Word/PDF
```

---

## 场景3：云端规划报告 → GIS分析

```text
Cloud Agent
     ↓
下载规划报告
     ↓
Document Agent
     ↓
提取规划范围
     ↓
GIS Agent
     ↓
空间匹配
     ↓
生成分析结果
```

---

# 32. Workflow层

建议利用 Harness Workflow 能力构建统一工作流。

例如：

```text
下载文件
 ↓
解析
 ↓
AI分析
 ↓
GIS查询
 ↓
生成报告
 ↓
上传云端
```

最终可以做成：

> AI Workflow Designer

---

# 33. Jobs后台任务

以下任务不能阻塞 Agent：

```text
文档解析
大量文件索引
Cloud同步
PDF渲染
Office转换
GIS导出
空间分析
```

统一进入：

```text
ctx.jobs
```

任务：

```text
IndexJob
DocumentParseJob
DocumentRenderJob
CloudSyncJob
GISExportJob
```

---

# 34. 统一事件系统

建议定义：

```text
lr/cloud/*
lr/document/*
lr/gis/*
lr/task/*
```

例如：

```text
cloud/file-downloaded

document/parse-start
document/operation-start
document/operation-progress
document/operation-complete

gis/query-start
gis/query-result
gis/map-command

task/start
task/progress
task/end
```

所有事件进入：

```text
Session
 ↓
WebSocket / SSE
 ↓
UI
```

---

# 35. 安全架构

这是商业产品必须具备的核心设计。

Harness 本身已经提供：

```text
Approval
Sandbox
Permission
Filesystem Guard
Tool Pipeline
```

建议所有 LR 工具统一接入。

---

# 36. 工具权限

例如：

```text
document.read
document.write_draft
document.write
document.delete
document.export
```

建议：

| 操作 | 默认 |
|---|---|
| READ | Allow |
| WRITE_DRAFT | Allow |
| WRITE | Ask |
| DELETE | Ask / Deny |
| EXPORT | Ask |

---

# 37. 文档安全机制

绝对不要：

```text
Agent
 ↓
直接覆盖原始文件
```

应该：

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

---

# 38. Cloud安全

同样：

```text
cloud.read
cloud.write
cloud.delete
```

进行权限控制：

```text
Read
Write
Admin
```

Agent 不因为拥有 Tool 就自动拥有所有权限。

---

# 39. GIS安全

内部 GIS 数据可能涉及：

```text
企业数据
政府数据
敏感空间数据
```

因此：

```text
GIS API Token
```

必须放入：

```text
Credential Store
```

并且：

```text
空间查询
导出
下载
```

全部可审计。

---

# 40. 推荐项目目录

建议不要把所有 LR代码直接放进 Harness Core。

```text
lr-agent/
│
├── upstream/
│   └── deepseek-harness
│
├── plugins/
│   ├── lr-cloud/
│   ├── lr-document/
│   ├── lr-gis/
│   ├── lr-office/
│   └── lr-workflow/
│
├── services/
│   ├── document-worker/
│   ├── gis-gateway/
│   └── cloud-gateway/
│
├── web/
│   ├── document-workspace/
│   ├── gis-workspace/
│   └── cloud-workspace/
│
├── deploy/
│
└── docs/
```

---

# 41. Cloud Gateway

不建议：

```text
Harness
 ↓
各种云API
```

建议：

```text
Harness
 ↓
Cloud Plugin
 ↓
Cloud Gateway
 ├── OSS
 ├── S3
 ├── REST API
 ├── PostgreSQL
 ├── GIS
 └── OAuth
```

Cloud Gateway 负责：

- 统一认证
- 统一授权
- 限流
- 重试
- 缓存
- 审计
- 第三方 API 适配

---

# 42. 第一阶段 MVP

第一版不要一次做完整平台。

建议先实现：

```text
Cloud
 ├── list
 ├── search
 └── download

Document
 ├── PDF
 ├── DOCX
 ├── XLSX
 └── PPTX

Document Agent
 ├── read
 ├── summarize
 ├── edit
 └── preview

GIS
 ├── map
 ├── layers
 ├── query
 └── identify
```

---

# 43. 第一条完整业务闭环

优先实现：

```text
用户打开 DOCX
       ↓
Document Parser
       ↓
DocumentModel
       ↓
Agent分析
       ↓
生成修改计划
       ↓
用户确认
       ↓
Document Operation
       ↓
实时事件
       ↓
Web UI
       ↓
生成新 DOCX
```

这条链路一旦跑通，后面 Cloud 和 GIS 都可以按照相同的 Plugin + Tool + Event + Workspace 模式扩展。

---

# 44. 第二阶段

加入：

```text
Cloud
 ↓
Download
 ↓
Document Agent
 ↓
Modify
 ↓
Preview
 ↓
Upload
```

形成：

```text
云端
 ↓
本地
 ↓
AI
 ↓
本地
 ↓
云端
```

---

# 45. 第三阶段

加入 GIS：

```text
Cloud GIS
      ↓
GIS Plugin
      ↓
GIS Web Client
```

同时实现：

```text
Chat
+
Document
+
GIS
```

三者协作。

---

# 46. 第四阶段

实现 Workflow：

```text
Cloud
 ↓
Document
 ↓
GIS
 ↓
Document
 ↓
Cloud
```

例如：

> 从云端获取规划报告 → 提取规划范围 → GIS 空间分析 → 生成分析报告 → 上传结果。

---

# 47. 推荐技术栈

## Harness

```text
TypeScript
Node.js
Cordis
pnpm
```

## Document

```text
Python
PyMuPDF
python-docx
openpyxl
python-pptx
LibreOffice
OCR
```

## Knowledge

```text
SQLite
Qdrant
FAISS
PostgreSQL
```

## GIS Frontend

```text
OpenLayers
MapLibre GL JS
ArcGIS Maps SDK for JavaScript
```

根据实际 GIS 服务进行选择。

## GIS Backend

```text
PostGIS
GeoServer
ArcGIS REST API
```

---

# 48. 商业化架构

Harness 本身采用 MIT License，允许商业使用、修改、闭源、销售和 SaaS。

但整个 LR-Agent 的许可证边界必须分别检查：

```text
Harness
+
LR Plugins
+
Document Libraries
+
GIS SDK
+
Cloud SDK
+
Model
+
UI Components
+
Fonts
```

尤其注意：

- GIS SDK
- Office组件
- 模型权重
- 第三方前端依赖
- 数据源
- 字体

不能简单认为“基于 MIT 项目开发，所以全部都能自由商用”。

---

# 49. Harness版本风险

目前 Harness 处于：

> Developer Preview

因此未来可能存在：

```text
API变化
Plugin接口变化
Context变化
Session机制变化
Client Module变化
```

商业项目不要直接跟随 `master`。

建议：

```text
deepseek-harness
      ↓
固定 commit
      ↓
LR Adapter Layer
      ↓
LR Plugins
```

例如：

```text
upstream/
└── deepseek-harness @ <fixed_commit>
```

升级时：

```text
Harness 新版本
      ↓
Compatibility Layer
      ↓
LR-Agent
```

---

# 50. 最终产品架构

```text
                         LR-Agent
                            │
          ┌─────────────────┼─────────────────┐
          │                 │                 │
          ▼                 ▼                 ▼
     Cloud Agent       Document Agent      GIS Agent
          │                 │                 │
          │                 │                 │
     Cloud Gateway     Document Engine      GIS Gateway
          │                 │                 │
     ┌────┼────┐       ┌────┼────┐       ┌───┼────┐
     │    │    │       │    │    │       │   │    │
    OSS  API  DB      PDF DOCX XLSX     GIS REST DB

                  ┌──────────────────┐
                  │   Workflow       │
                  │   Engine         │
                  └────────┬─────────┘
                           │
                 ┌─────────┴─────────┐
                 │                   │
            Session/Event        Jobs
                 │                   │
                 └─────────┬─────────┘
                           │
                        Harness
                           │
            ┌──────────────┼─────────────┐
            ▼              ▼             ▼
           Tool          Sandbox       Approval
```

---

# 51. 最终产品形态

最终建议做成：

```text
┌───────────────────────────────────────────────────────────┐
│ LR-Agent                                                   │
├───────────┬───────────────────────────┬───────────────────┤
│           │                           │                   │
│ Chat      │ Workspace                 │ Inspector         │
│           │                           │                   │
│ Cloud     │ Document                 │ Properties        │
│ Files     │                           │ Agent Steps       │
│ GIS       │ GIS Map                  │ Versions          │
│ Tasks     │                           │ Workflow          │
│ Workflow  │                           │                   │
│           │                           │                   │
└───────────┴───────────────────────────┴───────────────────┘
```

用户工作方式：

```text
自然语言
   ↓
Agent
   ↓
判断需要的能力
   ↓
Cloud / Document / GIS
   ↓
实时执行
   ↓
实时展示
   ↓
用户干预
   ↓
最终提交
```

---

# 52. 核心工程原则总结

## 原则1：Harness只做Runtime

不要把业务逻辑塞进 Harness Core。

```text
Harness
=
Agent Runtime

LR Plugin
=
Business Capability
```

---

## 原则2：Document一定结构化

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

## 原则3：所有写操作可回滚

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

## 原则4：Cloud必须有Gateway

```text
Agent
 ↓
Cloud Plugin
 ↓
Cloud Gateway
 ↓
Cloud Services
```

---

## 原则5：GIS必须同时拥有Tool和UI

```text
GIS Agent
+
GIS Web Client
```

而不是仅仅：

```text
GIS API Tool
```

---

## 原则6：长任务必须Job化

```text
Parse
Index
Render
Sync
GIS Analysis
Export
```

全部进入 Jobs。

---

## 原则7：所有执行过程事件化

```text
Tool
 ↓
Event
 ↓
Session
 ↓
WebSocket
 ↓
UI
```

这样才能实现真正的实时 Agent Workspace。

---

# 53. 最终定位

LR-Agent 建议最终定位为：

> **基于 DeepSeek Harness 构建的本地-云端协同 Agent Workspace。**

其核心不是重新开发一个 Agent Loop，而是在 Harness 的插件化 Runtime 之上构建三个核心能力：

```text
Cloud Agent
+
Document Agent
+
GIS Agent
```

再通过：

```text
Workflow
+
Jobs
+
Session
+
Event
+
Approval
+
Sandbox
```

将三个能力组合起来。

最终形成：

```text
                         LR-Agent
                            │
             ┌──────────────┼──────────────┐
             │              │              │
         Cloud Agent   Document Agent   GIS Agent
             │              │              │
             └──────────────┼──────────────┘
                            │
                         Workflow
                            │
                     Human-in-the-loop
                            │
                         Final Result
```

这套架构可以同时覆盖：

- 本地文件操作
- 云端数据接入
- 文档理解
- 文档修改
- Office自动化
- GIS空间分析
- 实时过程展示
- Agent工作流
- 企业级权限
- 私有化部署
- 后续MCP/Plugin生态扩展

因此从工程角度，它比单纯 Fork Harness 后往里面增加几个 Tool 更适合作为一个长期商业化产品的基础架构。