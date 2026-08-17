# dsh-acp

[![npm](https://img.shields.io/npm/v/dsh-acp-server.svg)](https://www.npmjs.com/package/dsh-acp-server)
[![CI](https://github.com/dushaobindoudou/dsh-acp/actions/workflows/ci.yml/badge.svg)](https://github.com/dushaobindoudou/dsh-acp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）提供的 Agent Client Protocol (ACP) 服务器。**

像使用 opencode 或 Gemini CLI 一样，从 [Zed](https://zed.dev)、JetBrains 或任何 ACP v1 客户端完整驱动 dsh 编码 agent：流式输出、工具调用、权限审批、持久化会话。

[English](README.md) | 中文

## 它是什么

`dsh-acp` 是一个 [`dsh` profile bundle](https://github.com/deepseek-ai/deepseek-harness)：执行 `dsh --profile acp` 会启动完整的 DeepSeek Harness（agent 循环、工具集、沙箱、会话持久化），只是把 Web UI 换成了 stdio 上的 ACP v1 JSON-RPC 服务器。

M1（当前版本）实现：

| ACP 方法 | 状态 |
|---|---|
| `initialize` | ✅ 能力声明 + agent 信息 |
| `session/new` | ✅ 创建持久化 dsh agent（存储于 `$DSH_HOME/sessions`） |
| `session/prompt` | ✅ 流式 `agent_message_chunk` / `agent_thought_chunk`（思考流）、`plan` 更新、`{stopReason}` |
| 工具调用 | ✅ 完整生命周期：`tool_call`（pending，含 title/kind/locations/rawInput）→ `in_progress` → `completed`/`failed` 及内容 |
| `session/request_permission` | ✅ dsh 审批 seam 桥接到客户端（allow once/always、reject once/always） |
| `session/cancel` | ✅ 中止当前 turn，prompt 以 `cancelled` 收尾 |
| `session/close` | ✅ 取消、flush、销毁 agent |

路线图：`session/load` 回放、`session/resume`/`list`、模式（plan mode）+ 配置项（模型切换）、斜杠命令、图片、elicitation —— 见[设计蓝图](research/acp-dsh-design.md)。

## 安装

需要 Node.js ≥ 22、pnpm 和 `dsh` CLI（`npm i -g @deepseek-ai/dsh`）。

```bash
# 从 npm 安装预构建包（推荐——无需构建授权）
dsh plugin --profile acp add dsh-acp-server

# 或从 tarball 安装
dsh plugin --profile acp add ./dsh-acp-server-0.1.0.tgz

# 或从 GitHub（源码安装，见下方说明）
dsh plugin --profile acp add github:dushaobindoudou/dsh-acp

# 在 stdio 上启动 ACP 服务器
dsh --profile acp
```

`node bin/setup-profile.mjs --pkg <spec>` 是同一命令的薄封装。

**GitHub 安装拉取的是源码而非构建产物。** 包的 `prepare` 脚本会在安装时构建 `lib/`；pnpm ≥ 10 在获得显式允许前会拒绝运行它——把 pnpm 打印的键加进 profile 的 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  dsh-acp: true
```

然后重新执行 `add`。建议锁定 commit（`github:dushaobindoudou/dsh-acp#<sha>`)；或直接用预构建的 npm 包 / tarball，完全绕开授权。随时可用 `dsh --profile acp --dump-config` 验证（应出现 `# == dsh-acp` 层）。

## 最终形态：两条命令

```bash
dsh-acp-server                    # 1) 单独启动：stdio 接编辑器，`serve` 子命令开远程
dsh web                           # 2) 同时启动：GUI 与 ACP 同端口
```

1. **`dsh-acp-server`**（`npm i -g dsh-acp-server` 后全局可用，或 npx 直接跑）
   即 `dsh --profile acp` 的单命令形态，launcher 参数全部透传
   （`serve --port 7800`、`--patch extra.yml`）。DSH home 里还没有 `acp`
   profile 时，首次运行会用官方 `dsh plugin` 命令自动引导--引导输出全部走
   stderr，编辑器读到的 stdout 永远只有 ACP 帧。
2. **`dsh web`**--往 web profile 装一次（见下节），之后每次 web 启动都同时
   服务 GUI 和 `/acp`。

为什么是独立命令而不是字面的 `dsh acp-server`：dsh launcher 的应用子命令
（`web`、`plugin`）是写死的，且在任何插件加载前就解析 argv，bundle 无法注册
新子命令；这个包装器就是同形态的单命令。

## 与 Web GUI 共用一个端口（`dsh web` + ACP）

往 `web` profile 装一次，之后每次 `dsh web` 都是同进程同端口同时服务 GUI 和 ACP：

```bash
node bin/setup-webacp.mjs        # 内部执行官方 `dsh plugin --profile web add` + 写入挂载行
dsh web                          # http://127.0.0.1:3080 = GUI，/acp = ACP
node bin/acp-chat.mjs --url http://127.0.0.1:3080
```

不想动 `web` 本体？`node bin/setup-webacp.mjs --clone webacp` 换成
`dsh --profile webacp` 同样效果。

脚本写入的行级 `inject: [agents, agentDefaultModel, webServer]` 让 Cordis 等
共享 `webServer` 服务就绪后才挂 acp-server 行——stdio 传输永远不可能与 web 启动
竞争。手动裸安装（没写这行）也安全：插件通过服务供给事件晚到挂载（终端启动直接
跳过 stdio；守护式启动有 EOF 宽限期兜底）。在 acp-server 配置里设 `token` 可启用
Bearer 鉴权。

## 远程接入（`serve`，类似 `opencode serve`）

编辑器走 stdio；同时你也可以起一个常驻 HTTP+SSE 端点--用于远程机器、共享 agent 或
curl 调试，形态跟随 ACP
[streamable-HTTP 草案](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport.md)
（POST 发客户端->服务端消息，长连 SSE GET 流回收所有服务端->客户端消息，
`Acp-Connection-Id` 绑定二者）：

```bash
dsh --profile acp serve --port 7800            # 默认只绑 127.0.0.1
dsh --profile acp serve --host 0.0.0.0 --port 7800 --token s3cret
```

| 端点 | 用途 |
|---|---|
| `POST /acp` | 每次请求体一条 JSON-RPC 消息；`initialize` 返回 `200` + `Acp-Connection-Id`；其余返回 `202`（响应走 SSE） |
| `GET /acp/stream` | 该连接的 SSE 流（头或 `?connection=`） |
| `DELETE /acp` | 关闭连接 |
| `GET /healthz` | 存活探针（免鉴权） |

一个 dsh 进程可同时挂多个客户端（每个一条 SDK 连接）。从任意机器用自带客户端连：

```bash
node bin/acp-chat.mjs --url http://127.0.0.1:7800 --token s3cret
```

不带 `serve` 时 profile 仍是 stdio 优先，Zed 用法完全不变。默认只绑回环；对外绑定时请
务必配合 `--token`。

## 不装编辑器先试试

`acp-chat` 是本仓库自带的零依赖终端交互客户端（REPL：流式输出、工具调用展示、plan 渲染、内联权限应答）：

```bash
node bin/acp-chat.mjs            # 启动 `dsh --profile acp` 并进入对话
```

现在就能用的第三方 ACP 客户端：

| 客户端 | 类型 | 用法 |
|---|---|---|
| [Zed](https://zed.dev) | 编辑器（参考客户端） | 下方 `agent_servers` 配置 |
| [acpx](https://github.com/openclaw/acpx) | 命令行 | `npx acpx@latest --agent 'dsh --profile acp' "你好"` |
| [ghost.nvim](https://github.com/assagman/ghost.nvim) / [acpear.nvim](https://github.com/Eric-Song-Nop/acpear.nvim) | Neovim | 插件配置 → 命令 `dsh-acp-server` |
| [acp.el](https://github.com/xenodium/acp.el) | Emacs | `(setq acp-agent-command '("dsh" "--profile" "acp"))` |
| [obsidian-agent-client](https://github.com/RAIT-09/obsidian-agent-client) | Obsidian | 插件设置 |
| [ACP-inspector](https://github.com/venikman/ACP-inspector) | 一致性/调试 | 校验线上流量 |

## 配置

所有配置项都有 schema 默认值，随包分发的行不带 config；在你自己的 profile 层（`$DSH_HOME/profiles/acp/cordis.patch.yml`）只覆盖想改的键：

```yaml
- id: acp-server
  config:
    agentName: my-dsh            # 报告给客户端的 initialize.agentInfo.name
    provider: deepseek           # 为 ACP 会话钉住模型
    model: reasoner              #（provider 和 model 必须成对设置）
    offerAlwaysPermissions: false # 隐藏 allow_always/reject_always（M1 把
                                  # "always" 授权按一次性决策处理）
    flushOnTurnEnd: true         # 每 turn 结束后 flush 会话持久化
```

行为遵循 harness 配置约定：schema 在插件加载时校验（类型错误或 provider/model 只给一半会带上确切的键名响亮失败），缺省键回落默认值（patch 层会整块替换 config 值，schema 负责补齐其余），不设 provider/model 则跟随 profile 的 `agent-default-model`。配置在进程启动时读取--编辑器按会话拉起进程。

## 在 Zed 中使用

Zed → 设置 → `agent_servers`：

```json
{
  "dsh": {
    "type": "custom",
    "command": "dsh-acp-server",
    "args": []
  }
}
```

npm 包名为 `dsh-acp-server`（npm 上 `dsh-acp` 这个名字属于另一个项目）；其 `dsh-acp-server` bin 是 `dsh --profile acp` 的薄启动器。可用 `DSH_BIN` 指向非 PATH 的 `dsh`。模型凭据沿用 dsh 的常规位置（`$DSH_HOME` 设置 / `DEEPSEEK_API_KEY`），与 Web UI 共享，无需二次配置。

## 开发

```bash
pnpm install
pnpm run build     # tsc -> lib/
pnpm test          # 单元测试（纯翻译层）

# 端到端：在一次性 $DSH_HOME 中启动真实的 dsh --profile acp
# 配确定性 mock LLM，断言 M1 全部线上行为
node test/e2e/e2e.test.mjs
```

e2e 测试也是迭代协议行为最快的方式：在真实 stdio 上跑 initialize → new → prompt（文本）→ prompt（工具）→ close。

### 映射关系

```
ACP 客户端 (Zed) ⇄ NDJSON JSON-RPC ⇄ dsh-acp 插件 ⇄ dsh 服务
                                          ├─ ctx.agents.create/resume   (session/new, load)
                                          ├─ agent.followup/cancel      (session/prompt, cancel)
                                          ├─ 'session/event'            (流式 session/update)
                                          ├─ 'approval/request'         (session/request_permission)
                                          └─ dsh-base: 工具、沙箱、持久化、设置
```

每个映射背后的完整调研：[`research/`](research/) —— [ACP 协议](research/acp-protocol.md)、[DSH 架构](research/dsh-architecture.md)、[同类实现](research/acp-implementations.md)、[设计蓝图](research/acp-dsh-design.md)。

## 贡献

欢迎 PR —— 见 [CONTRIBUTING.md](CONTRIBUTING.md)。里程碑计划在[设计蓝图 §4](research/acp-dsh-design.md)。

## 许可

[MIT](LICENSE)
