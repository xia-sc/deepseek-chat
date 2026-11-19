# AGENTS.md

本文件记录本项目在当前 Windows 开发环境中的**硬性约束、已知坑和验证方式**，供后续开发者与 AI Agent 参考。遇到"应用静默退出""打包失败"这类问题时，先对照本文档排查。

## 项目速览

- Electron 桌面应用 + Rspack 前端（React 18 / zustand），无应用后端。
- 主进程入口 `electron/main.cjs`，前端源码 `src/`，构建产物 `dist/`。
- 桌面外壳用固定端口 `http://127.0.0.1:37821` 托管 `dist/`，页面 origin 固定，IndexedDB / localStorage 不会因刷新丢失。

## 常用命令

| 目的 | 命令 | 说明 |
|---|---|---|
| 前端开发 | `pnpm dev` | rspack dev server，`http://localhost:8090`，热更新 |
| 生产构建 | `pnpm build` | 约 1 秒，输出 `dist/` |
| 主进程自检 | `pnpm check:main` | mock electron 校验启动逻辑、数据目录、IPC、静态服务 |
| 桌面开发（热更新） | 终端1 `pnpm dev` + 终端2 `pnpm dev:desktop:win` | Electron 加载 dev server，不用打包 |
| 发布打包 | `pnpm dist:exe` | 产物输出到 `E:/build/deepseek-chat` |

**不要用 `pnpm dist:exe` 做日常开发**：它要 2–3 分钟，日常改界面用 `pnpm dev`。

## 坑 0：手动打包前必须先 `pnpm build`（否则打进旧前端）

`electron-builder` 只打包现有的 `dist/`，而 `pnpm dev` 只在内存里跑 rspack dev server，**不会更新 `dist/`**。
如果跳过构建直接执行 `electron-builder`，exe 里的前端就是上一次构建的旧代码，表现为“明明改了、测试也通过了，打包出来的界面却没变”。

- 首选 `pnpm dist:exe`：脚本本身包含 `pnpm build`；
- 手动打包时先 `pnpm build`，再执行 `electron-builder --win --config.npmRebuild=false`；
- 打包后可以自检 asar 是否为新构建：在 `resources/app.asar` 二进制里搜索新增的界面文案（例如新增的 i18n 字符串）应命中。

## 坑 1：工作区目录带 Low 完整性标签，Electron 在工作区内启动即崩溃（最重要）

- 现象：双击 `win-unpacked/DeepSeek Chat.exe` 或运行 `electron .` 后**静默退出**，退出码 `0x80000003`（STATUS_BREAKPOINT），无任何日志、无窗口。
- 原因：`E:\dsh\deepseek-chat` 被 DSH 的 Windows 沙箱写入常驻 ACL：
  - `Mandatory Label\Low Mandatory Level:(NW)`（低完整性标签）
  - `S-1-4-<hash>:(W,D,DC)`（工作区 capability SID 授权）
  - `Everyone:(DENY)(DC)`（拒绝 `FILE_DELETE_CHILD`）
- 这是 DSH 沙箱的**正常设计**（见 `@deepseek-ai/dsh-sandbox-windows-acl` 的 README），不是 ACL 注入 bug；DSH 的 `diagnose-windows-sandbox-acl` 也明确 `S-1-4-*` 与 Everyone deny 是 expected。但它与 Electron/Chromium 的 sandbox 不兼容。
- 结论与做法：
  - **打包产物不要在工作区内就地运行**。当前输出目录是 `E:/build/deepseek-chat`（工作区外、ACL 干净），从这里启动正常。
  - 开发桌面外壳用 `pnpm dev:desktop:win`（见坑 2 的脚本），它把 Electron 运行时复制到 `%LOCALAPPDATA%\dsh-electron-dev`。
  - **不要手工用 `icacls` 删这些条目**：DSH 视其为预期状态，手工撤销会 `ERROR_NONE_MAPPED (1332)`；切到「完全权限」也不会撤销已写入的 standing ACL。
  - 复制项目/产物到工作区外（如 `E:\build\`）再运行即可，无需改 ACL。

## 坑 2：DSH 会话自带 `ELECTRON_RUN_AS_NODE=1`，Electron 会秒退

- 现象：`electron .` 或 `DeepSeek Chat.exe` 立即退出，退出码 0、无输出；`--version` 打印的是 Node 版本而非 Electron 版本。
- 原因：DSH 终端环境设置了 `ELECTRON_RUN_AS_NODE=1`，Electron 以 Node 模式运行，加载 app 后立即结束。
- 做法：启动 Electron 前清除该变量：

  ```powershell
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  ```

  `scripts/dev-desktop.ps1` 已内置这一行；手工用 `electron` 或 `Start-Process` 时记得先清。

## 坑 3：DSH 沙箱下 electron-builder 报 `spawn EPERM`

- 现象：`pnpm dist:exe` 失败，`@electron/rebuild` 或 `app-builder.exe` 报 `spawn EPERM`（管道 stdio 被沙箱拒绝）。
- 做法：
  1. 本项目运行时依赖全是纯 JS、无原生模块，跳过 rebuild 是安全的：

     ```powershell
     pnpm exec electron-builder --win --config.npmRebuild=false
     ```

  2. `zip` / `portable` 归档阶段仍需要一次完整权限（DSH 提权到 danger-full-access）才能通过，否则会卡在 archive 步骤报同样的 `spawn EPERM`。
- 打包成功后产物：`E:/build/deepseek-chat/DeepSeek-Chat-<version>-portable.exe`、`DeepSeek Chat-<version>-win.zip`、`win-unpacked/`。

## 坑 4：PowerShell 脚本必须是 UTF-8 with BOM

- 现象：用 `powershell -File scripts/xxx.ps1` 运行时中文乱码，报 `The string is missing the terminator`。
- 原因：Windows PowerShell 5.1 按 ANSI（GBK）解码无 BOM 的 UTF-8 文件。
- 做法：新增或修改 `scripts/*.ps1` 后确认前三字节为 `EF BB BF`；缺失时用 .NET 补写：

  ```powershell
  $p = (Resolve-Path 'scripts/dev-desktop.ps1').Path
  $c = [System.IO.File]::ReadAllText($p, [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::WriteAllText($p, $c, [System.Text.UTF8Encoding]::new($true))
  ```

## 数据目录约定

- 配置、供应商密钥、会话统一保存在 **`%APPDATA%\DeepSeek Chat`**（系统用户数据目录）：
  - `config.json`：供应商列表、第三方 API Key、当前模型；
  - `session\Local Storage`：官方 API Key、主题/语言等设置；
  - `session\IndexedDB`：会话历史与附件。
- 升级或移动 exe **不会丢配置**；旧便携版 exe 同目录的 `data/` 会在首次启动时自动迁移。
- 需要便携数据（如 U 盘）时设置环境变量 `DEEPSEEK_CHAT_DATA_DIR` 指向目标目录。
- 开发模式（`dev:desktop:win`）把数据隔离在 `%LOCALAPPDATA%\DeepSeek Chat Dev`，不污染正式配置。
- 端口：生产固定 `127.0.0.1:37821`（被占用会弹错误并退出，不会换端口）；dev server 固定 `8090`。

## 验证清单

改动后按需执行：

- 改了 `electron/main.cjs`：`pnpm check:main` 必须通过（检查数据目录、迁移、IPC、静态服务、HTTP 200）。
- 改了前端：`pnpm dev` 打开 `http://localhost:8090` 验证；或 `pnpm build` 后检查 `dist/index.html`。
- 发布前：`pnpm dist:exe`，然后从 `E:\build\deepseek-chat` 启动，确认：
  - `http://127.0.0.1:37821/` 返回 200 且页面含 `id="root"`；
  - `%APPDATA%\DeepSeek Chat` 正常生成；
  - exe 同目录**不**生成 `data/`。
- 在 DSH 会话内验证窗口启动：需 `--no-sandbox` 且清掉 `ELECTRON_RUN_AS_NODE`；cwd 建议在工作区外运行时上操作（见坑 1）。

## Node.js 版本迁移约定

本机 Node 由 nvm-windows 管理。2026-11 迁移到 v26.13.1 时踩过权限坑，下次迁移按下面执行（下文用 `<NVM_HOME>` 表示 nvm 安装根目录）：

- **结构**：版本目录为 `<NVM_HOME>\nvm\v*`，激活版本是 `<NVM_HOME>\.nodejs` 链接。全局包按版本独立存放，除 `node_modules` 外还有**版本根目录下的全局 shim**（`*.cmd`、`*.ps1` 和无扩展名文件，通常几十个），迁移时必须一并复制并重建。
- **权限**：DSH 会话进程是 **Low 完整性**，写不了 `<NVM_HOME>`；安装、复制、切换要在一次 **UAC 提权进程**里完成。版本根目录 `nvm` 此前缺少当前用户写权限，必要时先补授权。
- **禁止 `takeown`，`icacls` 只做追加授权**：迁移脚本若重建 DACL，会把 `.nodejs` 下文件改成只授权管理员会话的 Logon SID，DSH 受限令牌随后读不了 `pnpm.ps1` 等文件（表现为 `pnpm` 报 Access denied）。必须保证当前用户与 `Everyone` 对 `.nodejs` 下所有文件、`node_modules\pnpm` 等全局包目录有读取/执行权限。
- **迁移后在普通非管理员 DSH 会话验证**（不能只在管理员窗口测）：`node -v`、`npm -v`、`pnpm -v`、`corepack`、`playwright-cli` 等都能运行。
- 报 Access denied 时的急救（管理员执行，先把 `<NVM_HOME>` 换成实际根目录）：

  ```powershell
  icacls '<NVM_HOME>\.nodejs' /grant 'Everyone:(OI)(CI)(RX)' /T
  icacls '<NVM_HOME>\.nodejs\node_modules\pnpm' /grant 'Everyone:(OI)(CI)(RX)' /T
  ```

- 迁移过程日志留在原迁移会话的临时目录，不随仓库提交。

## 编码与提交约定

- 注释、文档、界面文案使用中文（与现有代码一致）。
- 不提交 `node_modules/`、`dist/`、`release/`、`release-app/`、`tmp/`、`*.log`。
- 数据目录、打包输出目录都在工作区外，不要写进仓库。
