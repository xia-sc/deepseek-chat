# deepseek-chat

[English](README.md) | 简体中文

基于 DeepSeek API 与第三方兼容供应商的桌面聊天客户端，使用 Electron、React 与 rspack 构建。项目 fork 自 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)，在其基础上增加了桌面外壳、供应商切换、多模态输入与联网搜索。

Windows 版把设置、供应商密钥与会话都保存在 `%APPDATA%\DeepSeek Chat`，升级版本或移动 exe 都不会丢配置；日常改界面也可以用浏览器开发模式。

## 来源与许可

本项目 fork 自 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)，本项目与原项目均采用 [MIT License](LICENSE) 开源协议。

Copyright (c) 2026 DeepSeek（原项目）。

## 功能特性

- 多会话管理：自动生成标题、重命名与删除；编辑提问、重新生成回答、切换消息分支。
- 流式回答，支持深度思考、智能搜索、阅读链接与来源引用；可停止生成或续写符合条件的回答。
- 支持上传、粘贴与拖拽添加附件；支持语音输入与朗读回答。
- Markdown 渲染、代码高亮、KaTeX 公式与 Mermaid 图表。
- 简体中文与英文界面、明暗主题、移动端布局、位置设置，以及会话历史的导入导出。
- 设置 → 模型 中可添加第三方供应商，支持 OpenAI Chat Completions、Anthropic Messages、Google Gemini 与 OpenAI Responses 四种协议。模型目录通过 `GET /models` 获取，供应商返回的多模态、上下文长度与最大输出能力会自动填入，也可以按模型手动修改。
- 输入框内可直接切换当前模型，并内置 Command Code 的快捷预设。
- 第三方模型的联网搜索：可用供应商自己的搜索接口（例如 Command Code 的 `/alpha/web-search`），或用 DeepSeek API Key 调用官方 `/v1/tools/search`。搜索结果以「搜索到 N 个网页」的工具步骤折叠展示，不再写进正文，寒暄类提问也不会触发搜索。

## 快速开始

准备 Node.js 22.12+ 和 pnpm：

```sh
git clone https://github.com/xia-sc/deepseek-chat.git
cd deepseek-chat
pnpm install
pnpm dev
```

打开 http://localhost:8090 即可使用浏览器模式（API Key 与设置存 localStorage，会话存 IndexedDB），或按下面的说明启动桌面外壳。

调试桌面外壳（热更新）时，开两个终端：

```sh
pnpm dev              # 终端 1：rspack dev server（http://localhost:8090）
pnpm dev:desktop:win  # 终端 2：Electron 加载 dev server
```

`dev:desktop:win` 会把 Electron 运行时复制到工作区外，因为被标了 Low 完整性标签的工作区会让工作区内的 Electron 一启动就崩溃。其他平台用 `pnpm dev:desktop`。只有需要发布时才执行 `pnpm dist:exe`。

## Windows 桌面版

```sh
pnpm dist:exe
```

产物为 `E:/build/deepseek-chat/DeepSeek-Chat-<version>-portable.exe`，双击即可运行，无需安装。

- 设置、供应商密钥与会话都保存在 Windows 的系统用户数据目录 `%APPDATA%\DeepSeek Chat`，升级版本或移动 exe 都不会丢配置；需要便携数据时可设置环境变量 `DEEPSEEK_CHAT_DATA_DIR` 指定到 U 盘等位置。
- 模型供应商与当前模型保存在该目录下的 `config.json`，可直接备份或手工编辑；设置 → 模型 里能查看完整路径并打开所在文件夹。
- 会话与附件保存在同目录的 `session/` 下。应用用固定端口 `127.0.0.1:37821` 托管页面，因此刷新或重启后数据不会因地址变化而丢失；端口被占用时会提示，而不是换端口。
- 开发时可以先用 `pnpm build`，再执行 `pnpm desktop` 启动桌面外壳（同样使用系统用户数据目录）。

## 构建前端

```sh
pnpm build
```

产物写入 `dist/`。桌面版会打包这个目录；也可以把它部署到静态服务器做纯浏览器预览。直接双击 `dist/index.html` 需要浏览器支持 `file://` 页面下的存储，并要求 API 服务允许对应的跨域请求。

## 数据与存储

- 桌面版：设置、供应商密钥与会话保存在 `%APPDATA%\DeepSeek Chat`（`config.json` 与 `session/`），升级与移动 exe 都不会丢失。
- 浏览器模式：API Key 与设置保存在 localStorage，会话与附件原件保存在 IndexedDB。
- 发送消息、上传附件与使用语音功能时，相关内容会发送给配置的 API 服务。
- 设置里的历史导入导出使用 ZIP 压缩包。确认并校验通过后，导入会替换全部本地会话与附件。导出包含会话与本地可用的图片原件，不含 API Key、设置与非图片附件原件。归档格式与保留规则见[历史导入导出说明](src/services/chat/history/README.md)。
- 设置 → 数据管理 → 删除所有对话会在确认后清空本地会话、附件原件与未发送草稿，并停止正在生成的回复；API Key 与设置保留，已上传到 API 服务的文件不会删除。

## 开发

| 命令            | 说明                     |
| --------------- | ------------------------ |
| `pnpm dev`      | 启动开发服务器           |
| `pnpm build`    | 构建到 `dist/`           |
| `pnpm desktop`  | 构建并启动 Electron      |
| `pnpm dist:exe` | 构建 Windows 发布包      |
| `pnpm type`     | TypeScript 类型检查      |
| `pnpm lint`     | 使用 oxlint 检查         |
| `pnpm format`   | 使用 oxfmt 格式化        |

[rspack.config.ts](rspack.config.ts) 默认使用 `https://api.deepseek.com`；可通过 `createConfig({ apiOrigin, devServer })` 自定义 API 地址与开发服务器代理。

官方通道默认使用 `deepseek-flash`，走 Anthropic 兼容的 Messages / Files 接口；语音功能使用 ASR / TTS 接口。请求包含联网搜索、阅读链接、标题生成与 `latest_reminder` 等扩展，因此配置的服务需要支持对应能力；附件格式由服务端校验决定。

```text
src/
  app/                 应用布局、主题与全局样式
  components/          聊天、设置、Markdown 等界面组件
  i18n/                中英文文案
  services/
    api/               接口请求、SSE、协议适配与供应商模型目录
    chat/              会话、消息分支、存储与历史导入导出
    markdown/          Markdown 解析、代码高亮与图表
    speech/            录音与朗读
  utils/               通用工具
electron/              Electron 主进程与 preload 桥接
```

## 许可证

[MIT](LICENSE)。构建会把许可证复制到 `dist/LICENSE`，分发应用时请一并保留。第三方依赖遵循其各自的许可协议。
