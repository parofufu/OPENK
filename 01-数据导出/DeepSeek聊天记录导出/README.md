# DeepSeek 聊天记录导出

把 DeepSeek 客户端导出的 zip，变成一份可读、可核对、可直接交给大模型的 Markdown。

## 能做什么

- 按**会话标题**模糊检索，大小写不敏感
- 导出 Markdown + `attachments/`，保留思考链、联网搜索、网页打开记录
- 生成 `_导出汇总.md`：会话数、片段构成、附件未打包/缺失、时间倒挂、空网页
- 可选导出 `session.json` 原始数据

## 选哪个版本

| 版本 | 适合谁 | 文件 |
|---|---|---|
| 零依赖 exe | Windows，不想装 Python | [`工具/DeepSeek聊天记录导出.exe`](工具/DeepSeek聊天记录导出.exe) |
| 大模型版 | 有 Python 3.8+，或让大模型代操作 | [`工具/DeepSeek聊天记录导出_大模型版.py`](工具/DeepSeek聊天记录导出_大模型版.py) |
| GUI 源码 | 想审查、修改或自行打包 | [`工具/DeepSeek聊天记录导出_GUI.py`](工具/DeepSeek聊天记录导出_GUI.py) |

## 快速开始（Windows exe）

1. 在 DeepSeek 客户端导出聊天记录，得到 zip。
2. 解压到一个独立文件夹，例如 `deepseek_data`。zip 内**没有外层目录**，解压后应直接看到 `chat_session_index.json`。
3. 把 exe 放在与该文件夹同级的目录，双击运行；UAC 弹窗选“是”。
4. 输入关键词 → 回车或点“搜索”；列表单击为预选，按住 Ctrl 再单击为多选。
5. 底部选择格式（Markdown / Markdown + JSON / 仅 JSON），点“确定”。
6. 结果在 `导出结果_时间戳/`。

## 命令行 / 大模型版

```bash
# 发现数据目录
python "工具/DeepSeek聊天记录导出_大模型版.py" --scan

# 列出命中会话
python "工具/DeepSeek聊天记录导出_大模型版.py" --keyword "关键词" --list

# 导出
python "工具/DeepSeek聊天记录导出_大模型版.py" --keyword "关键词" --export --format md

# 精确指定会话
python "工具/DeepSeek聊天记录导出_大模型版.py" --id "<会话ID>" --export --format md+json
```

格式：`md`、`md+json`、`json`。脚本内置给大模型的操作提示，运行 `--prompt` 可打印；完整版见 [提示词_大模型导出.md](提示词_大模型导出.md)。

## 导出物

```text
导出结果_YYYYMMDD_HHMMSS/
├── _导出汇总.md              # 会话清单 + 自检指标
└── <id>_<标题>/
    ├── <标题>.md             # 正文、思考链、搜索记录、图片
    ├── session.json          # 仅 md+json / json
    └── attachments/          # 仅图片附件
```

## 已知边界

- **只匹配标题**，不搜索正文。要全文检索请换关键词或改用其他工具。
- **只打包图片**。docx / pdf / txt 等非图片附件只保留文件名、大小等元数据，原文件不随导出包提供；汇总中标为“未打包”，这不是程序错误。
- 相邻消息的时间戳可能倒挂几毫秒，导出按数组顺序，不按时间排序。
- exe 为单文件打包，首次启动需解压数秒；个别杀毒软件可能误报，可将其加入白名单。
- 导出内容可能包含 `user_id`、会话标题与正文。工具全程本地处理，是否分享由你决定。

## 教程

教程正文将在抖音发布后同步到本文件夹的 `教程.md`。

## 文件说明

```text
DeepSeek聊天记录导出/
├── README.md
├── 教程.md
├── 提示词_大模型导出.md
├── 配图/                    # 教程插图
└── 工具/
    ├── DeepSeek聊天记录导出.exe
    ├── DeepSeek聊天记录导出_GUI.py
    └── DeepSeek聊天记录导出_大模型版.py
```

## 隐私

工具不上传、不联网、不写入导出包以外的位置。建议只导出自己需要的那几条会话，而不是整包分享。
