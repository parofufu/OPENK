# dsh-transcript-import

Import an existing chat transcript into a brand-new DSH session as ordinary session events, so the model continues that history as if it had always been there.

把一份已有的聊天记录导入成一个**全新的 DSH 会话**，让这段对话看起来原本就发生在该会话里；之后用户在那个会话里继续提问，模型会把导入的历史当作自己的上下文。

插件本身不拼 prompt，也不伪造请求：它把记录转换成普通的 SessionEvent（`turn/start`、`user/message`、`assistant/message`……），因此派生历史、UI 渲染、上下文统计、持久化都与真实会话完全一致。

## 安装

发布包里带 `dsh.bundle` 清单（`cordis.patch.yml`）和预构建的 `lib/plugin.js`；源文件是 [src/plugin.ts](src/plugin.ts)，不依赖任何 `@deepseek-ai/*` 运行时包（DSH 的 profile loader 只解析 profile/asar 内的模块，外部插件引用裸包会报 `ERR_MODULE_NOT_FOUND`）。

方式 A：从 npm 安装（推荐）

```sh
dsh plugin --profile web add dsh-transcript-import
```

`dsh plugin add` 会把包加进 profile 的 `dsh.profile.bundles`，包的 `cordis.patch.yml` 再把插件插进组合；重启 `dsh web`（或在插件市场里热加载）后生效。

方式 B：从源码构建后本地安装（仓库内位于 `02-DSH插件/dsh-transcript-import/`）

```sh
git clone https://github.com/parofufu/OPENK.git
cd OPENK/02-DSH插件/dsh-transcript-import
npm pack
dsh plugin --profile web add ./dsh-transcript-import-0.1.0.tgz
```

方式 C：本地开发用 patch 覆盖层（改源码后立即生效，无需重新打包）

```yaml
# dev.cordis.yml（name 必须是绝对路径）
- insert:
    - id: dsh-transcript-import
      name: 'D:/path/to/dsh-transcript-import/src/plugin.ts'
```

```sh
dsh web --patch ./dev.cordis.yml
```

## 用法

启动后模型会多出一个工具 `transcript_import`。典型对话：

> 用 transcript_import 导入 D:/chats/xxx.json，先 dryRun=true

工具返回轮次、消息条数、字符数和 token 估算；确认后再 `dryRun=false`。导入完成后返回新会话 id，并明确说明历史属于新会话、当前会话不会出现这些记录。

### 工具参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `path` | string | 必填 | 记录文件路径（绝对路径，或相对当前工作目录） |
| `dryRun` | boolean | false | 只解析与估算，不创建会话 |
| `reasoning` | `block` / `text` / `drop` | `block` | 思考链写成 reasoning 块 / 并入正文 / 丢弃 |
| `keepToolNotes` | boolean | true | 是否把检索、打开网页、导不进来的附件降级成正文注记 |
| `title` | string | 记录自带标题 | 会话标题 |
| `preserveTime` | boolean | false | 是否保留记录里的原始时间戳；默认用当前时间（否则会话会被排到列表底部） |
| `provider` / `model` | string | 沿用当前会话 | 写入 assistant 消息的标记，仅用于显示 |
| `cwd` | string | 沿用当前会话 | 新会话的工作目录 |
| `files` | string[] | `[]` | 用户提供的附件本地路径；按文件名自动放回记录里引用它的那条消息 |
| `allowMissingAttachments` | boolean | false | 记录引用了导出包没带的附件时是否跳过（只留文件名注记）；默认先返回待确认列表 |

## 支持的记录格式

### 1. `dsh-transcript/1`（推荐，见 [示例](examples/minimal.dsh-transcript.json)）

```json
{
  "format": "dsh-transcript/1",
  "title": "可选标题",
  "createdAt": "2026-03-02T09:15:00+08:00",
  "messages": [
    { "role": "user", "text": "提问" },
    { "role": "assistant", "reasoning": "可选思考链", "text": "回答", "notes": ["可选注记"] }
  ]
}
```

### 2. DeepSeek 客户端导出

`deepseek_data/chat_sessions/*.json` 原样传入即可。片段映射：

| 片段 | 映射 |
| --- | --- |
| `REQUEST` | 用户消息正文 |
| `THINK` | reasoning 块（或多条合并） |
| `RESPONSE` | 回答正文 |
| `TOOL_SEARCH` | 注记「联网搜索：查询词」 |
| `TOOL_OPEN` | 注记「打开网页：标题/URL」 |
| `FILE` | 注记「附件：文件名」 |

### 3. 通用 `{messages:[{role, content}]}`

OpenAI / Claude 风格导出，`content` 可以是字符串或 `[{type:"text"|"thinking", ...}]` 块数组。

### 4. 导出器生成的 Markdown 会话

`path` 可以直接给导出目录（`导出结果_*/`），工具会定位其中唯一的会话 `.md`（跳过 `_导出汇总.md`）；也可以直接给 `<id>_<title>/<title>.md`。

```md
# 书单
> **创建** 2026-11-04 18:26:35

## 对话

## 🧑 用户
*msg 1 · 2026-11-04 18:26:50 · 2 片段 · 1006 tokens*
😂

![截图.webp](attachments/xxx.webp)

## 🤖 AI
<details>
<summary>🤔 思考链（耗时 4.4s）</summary>
...
</details>

回答正文
```

映射：`## 🧑 用户` / `## 🤖 AI` 切分消息，`思考链` details → reasoning 块（`reasoning:"text"` 时并入正文），`联网搜索` details 只保留查询词，`🔗 打开网页：...` → 注记，`_【CONTENT_RISK】_` 免责行和 `---` 分隔线丢弃。用户消息里的 `![名称](attachments/xxx.webp)` 会按 Markdown 所在目录解析，图片本身写成真实的 image 块（见下）。

非图片附件会识别这三种导出写法：

| Markdown 写法 | 处理 |
| --- | --- |
| `📎 **附件**：[名称](attachments/file)（大小）` | 文件已在导出包里，直接存成 file 块 |
| `📎 **附件（导出包未包含原文件）**：`名称` · 大小 · 非图片` | 只有元数据，列入待确认列表，等用户给本地路径 |
| `📎 **附件缺失**：`名称` → `相对路径`` | 同上，列入待确认列表 |

### 非图片附件：先问，再放

DeepSeek 客户端导出包只带图片，docx/pdf/txt 之类只有文件名和大小。工具不会静默丢掉它们：

1. 第一次调用（含 `dryRun=true`）会在结果里返回 `needsAttachments` 和 `missingFiles`（形如 `广义生命论 (10086).docx（41.6 KB）（第 3 轮）`），并且**不会创建会话**；
2. 模型据此询问用户：手上有这些文件吗？有的话把本地路径发过来；
3. 带 `files: ["C:\\...\\广义生命论.docx"]` 再调用：按文件名匹配（忽略客户端加的 ` (10086)` 副本标记、大小写和空格），文件存进附件库后作为 `file` 块写入**原来那条**用户消息；
4. 用户没有或不想放：带 `allowMissingAttachments: true` 再调用，附件降级为「附件：名称（大小）」注记后正常导入。

匹配不上的路径会给出 warning 并忽略，不会乱塞到别的消息。

## 导入后会发生什么

1. 通过 agent factory 创建新会话（只有 factory 持有持久化写句柄，`ctx.sessions.create()` 创建的会话重启后会消失）。
2. 导入的事件作为**构造种子**传入：种子在 agent 构建之前就进入日志，所以循环的轮次计数器从导入的轮数继续（否则下一轮会从 `turn=1` 重新开始，与历史重复）。
3. 第一轮写入一个**空 system 节点**占住 surface 0 位；下一轮开始时框架会用真实系统提示词替换它，因此历史前面不会缺 system，也不会重复注入。
4. 显式固定会话标题（种子事件不会触发 `session/event`，标题插件看不到首条提问，所以由插件直接写入 `session/title`）。
5. 默认用「现在」给历史打时间戳：会话列表按最近活动排序、每个工作区只显示最近 10 个，用原始时间会把新会话埋到列表底部（需要原时间就传 `preserveTime:true`）。
6. 附件图片在构建种子之前先经 `ctx.attachments.saveImages()` 存入附件仓库（`DSH_HOME/attachments/v1`），user 消息里写的是 `{type:"image", attachment:{attachmentId:"sha256:…", mediaType, width, height, bytes}}`，所以模型看到的是图片本身而不是文件名；单张图片打不开、格式不识别或超出附件限制时，降级成「附件：文件名」注记并给出 warning。
7. 非图片文件经 `ctx.attachments.saveFile()` 原样保存（不转码），user 消息里写 `{type:"file", attachment:{attachmentId, name, bytes}}`；模型侧收到一行句柄文本（文件名、字节数、摘要前缀和只读路径），需要时用文件工具读取。
8. `ctx.sessions.flush()` 落盘后再返回 sessionId。

## 已验证（真实引擎，非 mock）

用本地 `dsh web --patch` 加载插件、在 Web UI 里实际调用并续聊，确认：

- 导入会话可以被「搜索会话」按标题找到并正常渲染，标题、历史消息、思考块、工具注记都正确；
- 在导入会话里追问，模型能准确回答只有那段历史里才有的内容（说明历史确实进了请求）；
- 日志中 `turn/start` 为 `[1, 2]`，续聊没有重复轮次；
- system 节点先是空的，续聊时被真实系统提示词替换（`content` 从 0 块变 1 块）；
- 思考块以 reasoning 形式留在历史里，DeepSeek 账号通道接受，没有请求报错。
- 用 `导出结果_20261117_193150`（36 轮 / 72 条 / 约 84K tokens 的 Markdown 导出）实际导入并追问，回答准确落在第 36 轮的话题上，日志为 `turn/start [1…37]`。
- 同一份导出里的 3 张 `.webp` 附件被真正导入：日志里 3 条用户消息带 `image` 块（规范化后为 `image/jpeg 1373x3051`，`attachmentId` 指向 `sha256:…`），附件对象落在 `DSH_HOME/attachments/v1/objects/`；其中一条只有图片、没有文字的消息也能正常导入；追问「最后那条只发图片的消息里截图是什么界面」时，模型答出了图里的具体内容（标题栏昵称、底部输入区图标），说明图片确实进了请求。
- 「老三论三本书作者」导出（`导出结果_20261116_191738`）里只有 1 个未打包的 `广义生命论 (10086).docx`：首次调用返回 `needsAttachments` 与待确认列表且未创建会话；带上用户本地路径 `广义生命论.docx` 再调用后，第 3 轮用户消息变成单个 `file` 块，附件按原字节（42,615）存入 `DSH_HOME/attachments/v1/files/…`；续聊追问只读路径时模型准确答出该路径，说明 `file` 块在历史投影里会被转成句柄文本，DeepSeek 通道不会因此报错。

开发期可以用 `node scripts/selfcheck.mjs <记录文件或导出目录> [附件路径]` 跑离线校验（事件结构、stream 与 content 自洽、seq 连续、JSON 可序列化、图片/文件块落位）；加 `PLUGIN_ENTRY=../lib/plugin.js` 可校验构建产物。

## 限制

- **只能新建会话**：不写当前会话，也不能把历史“塞进”一个已有会话。
- 思考链默认写 reasoning 块。它只影响 UI 展示：DeepSeek 历史里 thinking 不回传，若某个适配器拒绝无签名 thinking，改用 `reasoning:"text"`。
- 工具调用不伪造：检索/打开网页/附件只能降级为正文注记，`reasoning:"text"` 同理。
- 不伪造 `request/header`、不重复注入 system 提示词。
- 超长历史会直接占用上下文（工具会给出估算），超出模型窗口时框架侧仍会报错。
- 导入会话不会自动加入某个工作区的会话列表：它一般落在侧栏的「未分组」，或需要用「搜索会话」按标题找到（会话列表按最近活动排序且每个工作区最多 10 条）。
- 图片附件（PNG/JPEG/WebP/GIF，单图 ≤ 20MiB、单条消息 ≤ 20 张、≤ 200MiB，按附件仓库策略规范化）可以直接从导出包导入；其他类型的文件只在导出包携带原文件、或用户手动给出本地路径时才能导入——DeepSeek 客户端导出本身不带 docx/pdf/txt 的字节，这是导出数据的限制，不是插件丢数据。
- `file` 块在模型侧只是一行句柄文本（文件名、大小、摘要前缀、只读路径），模型要看内容仍需调用文件工具；这与 DSH 里正常上传文件的体验一致。
- 图片依赖 `ctx.attachments` 服务：profile 没有挂载附件服务时，图片自动降级为文件名注记（会给出 warning），不会导致导入失败。
- 导入会话的工作目录默认跟随发起导入的会话。
- DSHgo 原生卡片通过 `presentationMeta` 的 `{"dsh-go/view": …}` 提供（轮次/消息数/token 估算），`package.json` 另声明 `dshGo`（protocol v1，`contributes` 为空，因为卡片是工具输出的一部分而不是独立面板）供市场标注「兼容 DSH Go」；不装 DSHgo 时显示为普通工具卡。
- 种子事件不会广播给 `session/event` 监听者，依赖“首条消息”的自动化（如按首条提问自动起标题）对导入会话不会触发，标题已由插件显式写入。

## 开发与发布

```sh
npm run build   # src/plugin.ts → lib/plugin.js（Node 自带的类型擦除，零依赖）
npm pack        # 生成 dsh-transcript-import-0.1.0.tgz（只含 lib、patch、README、LICENSE）
```

`lib/plugin.js` 随仓库提交：从源码安装需要 pnpm 的构建授权，预构建产物保证 npm / 市场安装开箱可用。

### 上架 DSH Go 插件市场

[DSH Go 插件市场](https://github.com/ccch1mneyyy/dsh-go-market)只收录 **npm 上的精确版本**，不接受 `latest`、版本范围或 Git 地址。自动检查通过才会上架，硬性条件：

- 该精确版本在 npm 存在，许可证在 SPDX 的 OSI 清单里（本包 MIT）；
- 压缩与展开体积都 ≤ 50 MiB；包身份、npm SHA-512 与包内 `dsh.bundle` patch 一致（本包 `cordis.patch.yml` 按包名挂载）；
- 格式 1 索引有效，npm 公告里该版本没有 high/critical 级别问题；
- 条目里**不能**写 `tier`、风险等级、完整性或审核结论（这些由市场扫描生成）。

发布 npm 后 fork 市场仓库，把 [submission/dsh-transcript-import.json](submission/dsh-transcript-import.json) 放进 `plugins/`（非 scoped 包用 `<包名>.json`，`@scope/name` 用 `@scope__name.json`），一次 PR 只增改这一个文件。检查通过后自动合并，无需人工审批；升级只改该文件里的 `version`，不追加历史版本。

`dshGo` 声明只是静态标注，不等于已在 App 上跑通；`dsh-go/view` 卡片目前只在 `dsh web` 里验证过。
