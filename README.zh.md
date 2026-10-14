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
| `initialize` | ✅ 完整能力声明（`loadSession`、`promptCapabilities.image`、`sessionCapabilities.list/resume/close/delete`） |
| `authenticate` | ✅ 直接成功的 no-op（dsh 凭据在 ACP 之外；`authMethods` 保持为空） |
| `session/new` | ✅ 持久 dsh agent + 模式 + 斜杠命令广播 + 初始 `configOptions` |
| `session/prompt` | ✅ 流式 `agent_message_chunk` / `agent_thought_chunk`（推理）、`plan` 更新、完整工具调用生命周期、`{stopReason, usage}`；失败的 turn 以携带原因的 JSON-RPC 错误拒绝；**图片块**经 dsh attachments 持久化；单条 `/命令` 文本路由到 dsh 命令注册表 |
| `session/set_config_option` | ✅ 按会话覆盖 `model`（`<provider>/<model>`）与 `reasoning_effort`；下一个 step 生效（live 求值，无挂载期快照）；不支持的开关/取值以精确 `-32602` 拒绝；变更时推送 `config_option_update` |
| `usage_update` / `usage` | ✅ 由 token 记账驱动的上下文用量（`used`/`size`）；prompt 响应附带本次 turn 的 token 汇总（实验性 ACP 字段） |
| `session/list` | ✅ 全部持久 + 活跃会话（id、cwd、标题） |
| `session/resume` | ✅ 不回放地重开持久会话（vendor 方法的标准形态） |
| `session/load` | ✅ 重开并以 `user_message_chunk` / `agent_message_chunk` 回放记录 |
| `session/set_mode` | ✅ `default` ⇄ `plan`，桥接 dsh plan mode，推送 `current_mode_update` |
| `available_commands_update` | ✅ dsh 命令注册表，按会话广播、每 turn 刷新 |
| `session/request_permission` | ✅ dsh 审批桥接到客户端（允许/拒绝 一次/总是） |
| `elicitation/create` | ✅ 对声明 `elicitation.form` 的客户端发送 dsh 用户问题表单；单个单选问题可回退到权限按钮；复杂问题交给宿主后续回答器 |
| `session/cancel` | ✅ 中止 turn，prompt 返回 `cancelled` |
| `$/cancel_request` | ✅ 由 ACP SDK 处理：请求的 abort 信号取消进行中的 dsh turn |
| `session/close` | ✅ 取消、落盘、释放 agent |
| `session/delete` | ✅ 删除持久会话的产物目录；对打开中/活跃中/被他方占用的会话给出明确拒绝 |
| `fs/read_text_file`、`fs/write_text_file` | ☑️ 有意不调用——dsh 工具在进程内直接读写宿主文件系统，服务端不会把文件访问绕经客户端（声明了 fs 能力的客户端也不会收到这类请求） |

路线图：`session/fork`（在 ACP SDK 中仍为 UNSTABLE）、URL 模式 elicitation、音频、文档同步（`document/didOpen` 等——本服务端刻意保持单会话职责）；dsh↔dsh 客户端半边、发现与身份规划为**独立包**——见[设计文档](research/acp-dsh-design.md)。

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

## 用脚本驱动 dsh（`run`）

`dsh-acp-server run` 是给**外部 agent / 编排器**的一次性 CLI：它启动真实的 `dsh --profile acp`，通过与其他客户端完全相同的 SDK 讲 ACP，打印答案后退出——调用方不需要实现任何 ACP 协议：

```bash
dsh-acp-server run "修复失败的测试并总结原因" \
  --cwd /path/to/workspace \
  --json                                  # stdout 输出单个 JSON 对象
  --session acp-69041a38-...              # 续接持久会话（免去每次冷启插件树）
  --model liepin/glm-5-3                  # 临时 <provider>/<model> 覆盖
  --timeout 600                           # 600 秒后取消 turn
  --permission-policy auto                # auto | ask | deny
  --attach /tmp/screenshot.png            # 可重复；图片走 image block
```

- **默认输出**是最终 assistant 回答的纯文本（stdout）；进度（工具调用、权限提示）走 stderr。`--json` 输出单个对象：`{sessionId, stopReason, text, toolCalls: [{title, status}], usage?, error?}`。
- **退出码**：`0` 完成 · `1` 出错 · `2` 超时（turn 已被取消）· `3` 被取消 · `4` 有权限请求被拒绝。脚本按退出码分支，无需解析散文。
- `--session <id>` 续接持久会话（`dsh-acp-server run ... --session "$(cat last-session)"` 可跨次调用保持同一会话）；不给则每次新建。
- `--model <provider>/<model>` 映射到 `session/set_config_option`，仅覆盖该会话；profile 的 `agent-default-model` 不受影响。
- `--permission-policy auto` 自动放行（allow once），`deny` 一律拒绝（发生拒绝则退出码 `4`），`ask`（默认）在终端询问——stdin 非 TTY 时保守降级为拒绝。

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

错误码：`401` 身份凭据缺失/错误 · `404` 未知连接 ID 或路由 · `400` 请求体无法解析。一个进程可挂多个客户端（每个一条 ACP 连接）。

## dsh/* vendor 扩展（宿主平面）

ACP v1 标准化的是"一段对话"，不是它周围的宿主。会话历史、任务、目标、技能、
实时代理树通过 `dsh/` vendor 方法暴露；宿主写操作和调度方法见下节：

| 方法 | 返回 |
|---|---|
| `dsh/sessions/list` | 全部持久+活跃会话（id、标题、创建时间、cwd、父会话、`acp` 标记） |
| `dsh/sessions/read` | 单个会话的记录文本（`{seq, type, text}`） |
| `dsh/sessions/search` | 按 ID、标题、工作目录查找会话（`{query, limit?}`） |
| `dsh/sessions/resume` | 把持久会话重开为活跃 ACP 会话（带完整上下文） |
| `dsh/jobs/list` | 后台任务（id、kind、label、状态、属主） |
| `dsh/goals/list` | 每个活跃代理的当前目标（objective、phase、轮次） |
| `dsh/skills/list` | 已安装技能（name、description、provider） |
| `dsh/agents/tree` | 活跃代理及其父/模型/cwd（子代理树） |
| `dsh/sessions/watch` / `unwatch` | 订阅任意会话的翻译实时流——`dsh/session/update` 帧与属主收到的 SessionUpdate 同构（编排、仪表盘、审计） |

### Master 调度与宿主操作

`session/list` → `session/resume` / `session/load` 可切换到已有会话；`dsh/sessions/search` 可按 ID、标题或目录定位会话。`dsh/sessions/prompt` 接受 `{sessionId, prompt, mode?: "queue" | "steer", permissionPolicy?: "ask" | "auto" | "deny"}`，立即返回；随后用 `dsh/sessions/wait`、`dsh/sessions/read`、`dsh/sessions/watch` 跟踪结果。`dsh/sessions/cancel` 和 `configure` 分别取消任务、调整权限策略。`session/new` 的 `_meta['dsh/agentPreset']` 可选择预设，`_meta['dsh/permissionPolicy']` 可在首轮前设置策略。

`dsh/remote/catalog` 列出当前 Typert 宿主方法、参数 schema 与 `available` 状态；`dsh/remote/invoke` 用 `{endpoint, args}` 调用普通方法；流式方法用 `dsh/remote/stream`，接收 `dsh/remote/item` / `dsh/remote/end`，并可用 `dsh/remote/cancel` 停止。独立 `acp` profile 挂载工作区、目录浏览、工作区文件和设置控制器；挂在 `dsh web` 里的 ACP 还会自动看到 Web 组合的其他宿主方法。方法目录以实际组合为准。例如，调用 `workspace/create` 的参数是 `{"endpoint":"workspace/create","args":{"request":{"path":"/absolute/project"}}}`。

设置更新同样经 `dsh/remote/invoke` 调用 `settings/update`；先从 catalog 读取参数 schema，再用 `settings/describe` 取得 namespace 与 revision。宿主操作按 DSH 本机 operator 身份执行。Web 挂载模式接受 DSH Web 的登录 cookie，也可配置独立 ACP Bearer token 供脚本使用；独立 `serve` 模式用 `--token`。

脚本可用同一套能力，无需手写 JSON-RPC：

```bash
dsh-acp-server catalog workspace --url http://127.0.0.1:3080 --token "$DSH_ACP_TOKEN"
dsh-acp-server call workspace/create '{"request":{"path":"/absolute/project"}}' --url http://127.0.0.1:3080 --token "$DSH_ACP_TOKEN"
dsh-acp-server rpc dsh/sessions/search '{"query":"project"}' --url http://127.0.0.1:3080 --token "$DSH_ACP_TOKEN"
dsh-acp-server stream workspace/follow --limit 1 --url http://127.0.0.1:3080 --token "$DSH_ACP_TOKEN"
dsh-acp-server run "继续这个任务" --session <session-id> --json --url http://127.0.0.1:3080 --token "$DSH_ACP_TOKEN"
dsh-acp-server run "耗时任务" --detach --permission-policy auto --url http://127.0.0.1:3080 --token "$DSH_ACP_TOKEN"
```

`--url` / `--token` 也可从 `DSH_ACP_URL` / `DSH_ACP_TOKEN` 读取；不传 URL 时启动私有 stdio 服务。`--detach` 需要已有服务，立即输出 session ID；随后用 `rpc dsh/sessions/wait '{"sessionId":"..."}'` 和 `rpc dsh/sessions/read` 跟踪结果。`--preset` 可选择新会话的代理预设。`call`、`stream`、`rpc` 的 JSON 参数支持内联、`@file.json` 和 `-`（stdin）。流条数限制必须为正整数，超时必须为有限正秒数；流超时退出码为 2。

`run` 能回答用户问题表单：`auto` 选择第一个选项，`deny` 拒绝，`ask` 在终端交互。stdin 不是 TTY 时，`ask` 对用户问题选择第一个选项，对权限请求则拒绝。后台任务由服务端按会话策略回答；代理组合需要挂载提问工具。

推送：turn 结束、会话生命周期、任务变化、代理状态迁移（节流）时发 `dsh/changed {topics}` 通知。
**互操作性天然安全**--只发给通过 schema 官方扩展位
`clientCapabilities._meta['dsh/extensions']` 声明启用的连接（`_meta` 记录是
ACP 官方 schema 的一部分）；Zed 等标准客户端看到的是一个完全标准的服务端，
永远不会收到 vendor 流量。缺少底层服务的组合里，各方法干净地返回 `-32601`。

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
| `token` | string | - | Web 挂载模式的额外 ACP Bearer 凭据；未配置时仍要求 DSH Web 登录 cookie。独立 `serve` 用命令行 `--token` |
| `offerAlwaysPermissions` | boolean | `true` | 权限请求中包含 `allow_always` / `reject_always` 选项 |
| `flushOnTurnEnd` | boolean | `true` | 每个完成的 turn 后落盘会话 |
| `hostControl` | boolean | `true` | 开启 `dsh/remote/*` 宿主方法 |
| `hostControlDeny` | string[] | `[]` | 禁止的端点，如 `settings/*`、`workspace/delete`、`*` |

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

源码结构：`src/connection.ts`（方法处理器）· `translate.ts` / `config-options.ts`（纯线上映射，单测覆盖）· `event-bridge.ts` / `perm-bridge.ts`（dsh ⇄ ACP 桥接）· `session-delete.ts`（受护栏的持久会话清理）· `cli/run.ts`（一次性 CLI；`cli/run-core.ts` 是其纯映射层）· `http-transport.ts`（共享 HTTP 路由器）· `serve-startup.ts`（`serve` 子命令）· `config.ts`（schema）· `table.ts`（会话表）。

每个映射背后的完整调研见 [`research/`](research/)——[ACP 协议](research/acp-protocol.md)、[DSH 架构](research/dsh-architecture.md)、[同类实现](research/acp-implementations.md)、[设计蓝图](research/acp-dsh-design.md)。

## 开发

```bash
pnpm install
pnpm run build     # tsc -> lib/
pnpm test          # 单元测试（纯翻译层 + 配置层）

# 端到端：在一次性 $DSH_HOME 里启动真实 dsh + 确定性 mock LLM，
# 断言完整线上行为：
pnpm run test:e2e  # stdio · run CLI · serve（HTTP+SSE）· web 挂载 · 裸装宽限
```

e2e 套件是迭代协议行为最快的方式——每套都驱动一次完整会话（文本提问、工具调用生命周期、收尾）。设 `DSH_ACP_PKG`（默认仓库路径，可选 `./dsh-acp-server-*.tgz` 或 npm 规格）指定安装来源。

## 贡献

欢迎 PR——见 [CONTRIBUTING.md](CONTRIBUTING.md)。里程碑计划在 [research/acp-dsh-design.md](research/acp-dsh-design.md)。

## 许可

[MIT](LICENSE)
