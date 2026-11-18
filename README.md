# deepseek-chat

English | [简体中文](README.zh-CN.md)

A desktop chat client for the DeepSeek API and third-party compatible providers, built with Electron, React and rspack. It forked from [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) and adds a desktop shell, provider switching, multimodal input and web search.

The Windows build keeps settings, provider keys and conversations in `%APPDATA%\DeepSeek Chat`, so upgrading or moving the executable never loses your configuration. A browser dev mode is available for UI work.

## Fork and license

This project is a fork of [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo). Both this project and the upstream project are released under the [MIT License](LICENSE).

Copyright (c) 2026 DeepSeek (upstream project).

## Features

- Multiple conversations with automatic titles, renaming and deletion; edit prompts, regenerate replies and switch message branches.
- Streaming replies with deep thinking, smart search, link reading and source citations; stop generation or continue eligible replies.
- Attachments by upload, paste or drag and drop; voice input and read-aloud playback.
- Markdown, syntax highlighting, KaTeX math and Mermaid diagrams.
- Simplified Chinese and English, light and dark themes, mobile layouts, location settings, and chat history import/export.
- Third-party providers under Settings → Models, speaking OpenAI Chat Completions, Anthropic Messages, Google Gemini or OpenAI Responses. The model catalog is read from `GET /models`; multimodal, context-length and max-output capabilities are filled in automatically when the provider reports them, and can be edited per model.
- A model switcher in the input area, plus built-in presets for Command Code.
- App-side web search for third-party models: either the provider's own search endpoint (for example Command Code's `/alpha/web-search`), or the DeepSeek official `/v1/tools/search` with your DeepSeek key. Results appear as a folded "found N pages" tool step instead of being echoed in the answer, and greetings are not searched.

## Getting started

Install Node.js 22.12+ and pnpm, then run:

```sh
git clone https://github.com/xia-sc/deepseek-chat.git
cd deepseek-chat
pnpm install
pnpm dev
```

Open http://localhost:8090 to use the browser mode (API key and settings in localStorage, conversations in IndexedDB), or run the desktop shell as described below.

For desktop-shell development with hot reload, run the dev server in one terminal and the Electron shell in another:

```sh
pnpm dev              # terminal 1: rspack dev server on http://localhost:8090
pnpm dev:desktop:win  # terminal 2: Electron loading the dev server
```

`dev:desktop:win` copies the Electron runtime outside the workspace, because a workspace marked with a Low integrity label makes an in-tree Electron crash on startup. On other platforms use `pnpm dev:desktop`. Only run `pnpm dist:exe` when you need a release build.

## Windows desktop build

```sh
pnpm dist:exe
```

This produces `E:/build/deepseek-chat/DeepSeek-Chat-<version>-portable.exe`; double-click to run, no installation needed.

- Settings, provider keys and conversations are stored in `%APPDATA%\DeepSeek Chat` (the system user data directory) on Windows, so upgrading or moving the exe never loses your configuration. Set `DEEPSEEK_CHAT_DATA_DIR` to use a portable data folder instead (e.g. on a USB stick).
- Provider and active-model settings live in `config.json` in that directory, which you can back up or edit by hand; Settings → Models shows the full path and can open its folder.
- Conversations and attachments live under `session/` in the same directory. The app serves the page on a fixed `127.0.0.1:37821`, so data survives restarts and reloads; if that port is taken the app reports it instead of switching ports.
- For development, run `pnpm build` once and then `pnpm desktop` to launch the desktop shell (it uses the same system user data directory).

## Building the front end

```sh
pnpm build
```

The output is written to `dist/`. The desktop build packages this directory; you can also serve it from a static web server for a browser-only preview. Opening `dist/index.html` directly requires browser support for storage on `file://` pages and an API service that permits their cross-origin requests.

## Data and storage

- Desktop: settings, provider keys and conversations live in `%APPDATA%\DeepSeek Chat` (`config.json` and `session/`), so they survive upgrades and moving the executable.
- Browser mode: the API key and settings live in the browser's localStorage, conversations and original attachments in IndexedDB.
- Sending messages, uploading attachments and using speech features send the relevant content to the configured API service.
- History import and export in Settings use ZIP archives. After confirmation and successful validation, importing replaces all local conversations and attachments. Exports include conversations and locally available original images, but exclude API keys, settings, and original non-image attachments. See the [history import/export documentation (Chinese)](src/services/chat/history/README.md) for the archive format and preservation details.
- Settings → Data → Delete all chats clears all local conversations, original attachments and unsent drafts after confirmation. It stops ongoing replies and returns to a new chat. Your API key and settings are preserved; files already uploaded to the API service are not deleted.

## Development

| Command        | Description                   |
| -------------- | ----------------------------- |
| `pnpm dev`     | Start the development server  |
| `pnpm build`   | Build into `dist/`            |
| `pnpm desktop` | Build and launch Electron     |
| `pnpm dist:exe`| Build the Windows release     |
| `pnpm type`    | Run TypeScript type checks    |
| `pnpm lint`    | Lint with oxlint              |
| `pnpm format`  | Format with oxfmt             |

[rspack.config.ts](rspack.config.ts) uses `https://api.deepseek.com` by default. Use `createConfig({ apiOrigin, devServer })` to customize the API origin and development server proxy.

The official path uses `deepseek-flash` by default through Anthropic-compatible Messages / Files APIs. Speech features use ASR / TTS endpoints. Requests include extensions for search, link reading, titles, and `latest_reminder`, so the configured service must support the corresponding capabilities. Supported attachment formats are determined by server-side validation.

```text
src/
  app/                 Application layout, themes, and global styles
  components/          Chat, settings, Markdown, and other UI components
  i18n/                English and Chinese translations
  services/
    api/               API requests, SSE, protocol adapters, and provider model catalog
    chat/              Conversations, message branches, storage, and history import/export
    markdown/          Markdown parsing, syntax highlighting, and diagrams
    speech/            Audio recording and read-aloud playback
  utils/               Shared utilities
electron/              Electron main process and preload bridge
```

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
