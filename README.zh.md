# dsh-acp-server

[![npm](https://img.shields.io/npm/v/dsh-acp-server.svg)](https://www.npmjs.com/package/dsh-acp-server)
[![CI](https://github.com/dushaobindoudou/dsh-acp/actions/workflows/ci.yml/badge.svg)](https://github.com/dushaobindoudou/dsh-acp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的 Agent Client Protocol（ACP）服务端。**

从 [Zed](https://zed.dev) 或任意 ACP v1 客户端完整驱动 dsh 编程 agent——流式输出、工具调用、权限确认、持久会话——体验与 opencode / Gemini CLI 一致。

[English](README.md) | 中文

## 它做什么

一个 [`dsh` profile bundle](https://github.com/deepseek-ai/deepseek-harness)：启动完整的 DeepSeek Harness（agent 循环、工具、沙箱、会话持久化），以 ACP v1 JSON-RPC 服务替代——或伴随——Web UI 运行。

| ACP 方法 | 状态 |
|---|---|
| `initialize` | ✅ 能力协商 + agent 信息 |
| `session/new` | ✅ 持久 dsh agent（落盘于 `$DSH_HOME/sessions`） |
| `session/prompt` | ✅ 流式 `agent_message_chunk` / `agent_thought_chunk`（推理）、`plan` 更新、完整工具调用生命周期、`{stopReason}`；失败的 turn 以携带原因的 JSON-RPC 错误拒绝 |
| `session/request_permission` | ✅ dsh 审批桥接到客户端（允许/拒绝 一次/总是） |
| `session/cancel` | ✅ 中止 turn，prompt 返回 `cancelled` |
| `session/close` | ✅ 取消、落盘、释放 agent |

路线图：`session/load` 回放、`session/resume`/`list`、模式与配置项、斜杠命令、图片、elicitation——见[设计文档](research/acp-dsh-design.md)。

## 最终形态：两条命令

```bash
dsh-acp-server       # 1) 单独启动：stdio 接编辑器，`serve` 子命令开远程 HTTP
dsh web              # 2) 同时启动：GUI 与 ACP 同进程同端口
```

### 形态 1 —— 单独启动（`dsh-acp-server`）

`npm i -g dsh-acp-server` 后全局可用（或 npx 直接跑）。该命令以当前 stdio 启动 `dsh --profile acp`，所有 launcher 参数透传（`serve --port 7800`、`--patch extra.yml`）。DSH home 里还没有 `acp` profile 时，首次运行会用官方 `dsh plugin` 命令自动引导——引导输出全部走 stderr，编辑器读到的 stdout 永远只有 ACP 帧。

Zed → 设置 → `agent_servers`（完整样例见 [examples/zed-settings.json](examples/zed-settings.json)）：

```json
{
  "agent_servers": {
    "dsh": { "type": "custom", "command": "dsh-acp-server", "args": [] }
  }
}
```

### 形态 2 —— 同时启动（`dsh web`）

往 `web` profile 装一次，之后每次 `dsh web` 都同端口服务 GUI 和 ACP：

```bash
node bin/setup-webacp.mjs        # 内部执行官方 `dsh plugin --profile web add` + 写入挂载行
dsh web                          # http://127.0.0.1:3080 = GUI，/acp = ACP
node bin/acp-chat.mjs --url http://127.0.0.1:3080
```

不想动 `web` 本体？`node bin/setup-webacp.mjs --clone webacp` 换成 `dsh --profile webacp` 同样效果。

脚本写入的行级 `inject: [agents, agentDefaultModel, webServer]` 让 Cordis 等共享 `webServer` 服务就绪后才挂 acp-server 行——stdio 传输永远不可能与 web 启动竞争。手动裸安装（没写这行）也安全：插件通过服务供给事件晚到挂载（终端启动直接跳过 stdio；守护式启动有 EOF 宽限期兜底）。完整行说明见 [examples/patches/web-mounted.yml](examples/patches/web-mounted.yml)。

为什么是独立命令而不是字面的 `dsh acp-server`：dsh launcher 的应用子命令（`web`、`plugin`）是写死的，且在任何插件加载前就解析 argv，bundle 无法注册新子命令；这个包装器就是同形态的单命令。

## 安装

需要 Node.js ≥ 22 和 `dsh` CLI（`npm i -g @deepseek-ai/dsh`）。`dsh-acp-server` 命令会自行处理 profile；需要显式管理时：

```bash
# npm 预构建包（推荐——无需构建授权）
dsh plugin --profile acp add dsh-acp-server

# 或从 tarball
dsh plugin --profile acp add ./dsh-acp-server-0.7.0.tgz

# 或从 GitHub（源码安装，见下方说明）
dsh plugin --profile acp add github:dushaobindoudou/dsh-acp
```

**GitHub 安装拉的是源码而非构建产物。** 包的 `prepare` 脚本在安装时构建 `lib/`；pnpm ≥ 10 会拒绝执行，直到你在 profile 的 `pnpm-workspace.yaml` 里放行：

```yaml
allowBuilds:
  dsh-acp-server: true
```

然后重新执行 `add`。建议锁定 commit（`github:…/dsh-acp#<sha>`），或直接用 npm 包/tarball 免去授权。随时可用 `dsh --profile acp --dump-config` 验证（应出现 `dsh-acp-server` 层）。`node bin/setup-profile.mjs --pkg <spec>` 是同一命令的薄封装。

## 远程接入（`serve`）

编辑器走 stdio；`serve` 起常驻 HTTP+SSE 端点——用于远程机器、共享 agent 或 curl，形态跟随 ACP [streamable-HTTP 草案](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport.md)：

```bash
dsh --profile acp serve --port 7800            # 默认只绑 127.0.0.1
dsh --profile acp serve --host 0.0.0.0 --port 7800 --token s3cret
```

serve 端口还在 `GET /` 内置了一个单文件 web 客户端--浏览器打开
http://127.0.0.1:7800 就是完整聊天界面（流式、思考、工具卡片、计划、授权弹窗），
全部由上述 ACP 路由驱动--即"这套接口撑得起 web 界面"的参照实证。web 挂载模式
（形态 2）在 GUI 端口上提供相同的路由。

### HTTP 传输规范

| 方法 + 路径 | 用途 |
|---|---|
| `POST /acp` | 每次请求体一条 JSON-RPC 消息（单个 JSON 对象或 NDJSON 行）；`initialize` → `200` + JSON 体 + `Acp-Connection-Id` 头；其余 → `202`，响应走 SSE 流 |
| `GET /acp/stream` | 该连接的长连 SSE 流（头 `Acp-Connection-Id` 或 `?connection=`）；每 15 秒 `: ping` 心跳 |
| `DELETE /acp` | 关闭连接 → `204` |
| `GET /acp/healthz` | 存活探针（免鉴权；serve 模式同时应答 `/healthz`） |

错误码：`401` Bearer token 缺失/错误 · `404` 未知连接 ID 或路由 · `400` 请求体无法解析。一个进程可挂多个客户端（每个一条 ACP 连接）。

只用 curl 跑完整对话的可执行示例：[examples/curl-conversation.sh](examples/curl-conversation.sh)。

```bash
./examples/curl-conversation.sh http://127.0.0.1:7800 [bearer-token]
```

## 配置

所有配置项都有 schema 默认值；只需在 profile 层（`$DSH_HOME/profiles/<name>/cordis.patch.yml`）覆盖想改的键。完整样例见 [examples/patches/](examples/patches/)。

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `agentName` | string | `dsh` | 客户端看到的 `initialize.agentInfo.name` |
| `provider` | string | - | 钉死 ACP 会话的模型供应商（必须**与** `model` 同设） |
| `model` | string | - | 钉死 ACP 会话的模型（必须**与** `provider` 同设） |
| `token` | string | - | HTTP 传输要求 `authorization: Bearer <token>`（web 挂载模式；独立 `serve` 用命令行 `--token`） |
| `offerAlwaysPermissions` | boolean | `true` | 权限请求中包含 `allow_always` / `reject_always` 选项 |
| `flushOnTurnEnd` | boolean | `true` | 每个完成的 turn 后落盘会话 |

```yaml
- id: acp-server
  config:
    agentName: my-dsh
    provider: liepin        # 钉死（或两者都不设，跟随实时默认）
    model: glm-5-3
```

行为遵循 harness 配置约定：插件加载时 schema 校验（类型错误或只设一半的 provider/model 会带确切键名大声失败），缺省键回退默认值（patch 层整体替换 config 值，schema 补齐其余），未设置的 provider/model 跟随 profile 的 `agent-default-model`——**每次会话实时读取**，GUI 里切模型对新 ACP 会话同样生效。

模型凭据来自 dsh 既有位置（`$DSH_HOME` 设置 / 供应商 API key 环境变量），与 Web UI 共享——无需二次配置。

## 不装编辑器先试试

`acp-chat` 是仓库自带的零依赖交互式终端客户端（REPL：流式输出、工具展示、计划渲染、内联权限确认），支持两种传输：

```bash
node bin/acp-chat.mjs                                   # 启动 `dsh --profile acp`（stdio）
node bin/acp-chat.mjs --url http://127.0.0.1:7800 --token s3cret   # 远程 HTTP+SSE
```

当前可用的第三方 ACP 客户端：

| 客户端 | 类型 | 用法 |
|---|---|---|
| [Zed](https://zed.dev) | 编辑器（参考客户端） | 上方 `agent_servers` 配置 |
| [acpx](https://github.com/openclaw/acpx) | CLI | `npx acpx@latest --agent 'dsh --profile acp' "hello"` |
| [ghost.nvim](https://github.com/assagman/ghost.nvim) / [acpear.nvim](https://github.com/Eric-Song-Nop/acpear.nvim) | Neovim | 插件配置 → 命令 `dsh-acp-server` |
| [acp.el](https://github.com/xenodium/acp.el) | Emacs | `(setq acp-agent-command '("dsh-acp-server"))` |
| [obsidian-agent-client](https://github.com/RAIT-09/obsidian-agent-client) | Obsidian | 插件设置 |
| [ACP-inspector](https://github.com/venikman/ACP-inspector) | 一致性/调试 | 校验线上流量 |

## 工作原理

传输在挂载时确定性选择：`serve` 子命令 → 独立 HTTP 服务；存在（或晚到）`webServer` 服务 → 路由注册到共享服务；否则 stdio。

```
ACP 客户端（Zed / curl / acp-chat）
   │  stdio NDJSON JSON-RPC          │  HTTP POST + SSE（serve / web 挂载）
   ▼                                 ▼
  dsh-acp-server 插件 ⇄ dsh 服务
      ├─ ctx.agents.create/dispose      （session/new、close）
      ├─ agent.followup/cancel/whenIdle （session/prompt、cancel）
      ├─ 'session/event'                （流式 session/update）
      ├─ 'approval/request'             （session/request_permission）
      └─ dsh-base：工具、沙箱、持久化、设置
```

源码结构：`src/connection.ts`（方法处理器）· `translate.ts`（纯线上映射，单测覆盖）· `event-bridge.ts` / `perm-bridge.ts`（dsh ⇄ ACP 桥接）· `http-transport.ts`（共享 HTTP 路由器）· `serve-startup.ts`（`serve` 子命令）· `config.ts`（schema）· `table.ts`（会话表）。

每个映射背后的完整调研见 [`research/`](research/)——[ACP 协议](research/acp-protocol.md)、[DSH 架构](research/dsh-architecture.md)、[同类实现](research/acp-implementations.md)、[设计蓝图](research/acp-dsh-design.md)。

## 开发

```bash
pnpm install
pnpm run build     # tsc -> lib/
pnpm test          # 单元测试（纯翻译层 + 配置层）

# 端到端：在一次性 $DSH_HOME 里启动真实 dsh + 确定性 mock LLM，
# 断言完整线上行为：
pnpm run test:e2e  # stdio · serve（HTTP+SSE）· web 挂载 · 裸装宽限
```

e2e 套件是迭代协议行为最快的方式——每套都驱动一次完整会话（文本提问、工具调用生命周期、收尾）。设 `DSH_ACP_PKG`（默认仓库路径，可选 `./dsh-acp-server-*.tgz` 或 npm 规格）指定安装来源。

## 贡献

欢迎 PR——见 [CONTRIBUTING.md](CONTRIBUTING.md)。里程碑计划在 [research/acp-dsh-design.md](research/acp-dsh-design.md)。

## 许可

[MIT](LICENSE)
