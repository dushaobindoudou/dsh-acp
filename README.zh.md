# dsh-acp

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
# 从本仓库检出目录（发布包同样方式）
node bin/setup-profile.mjs --pkg /path/to/dsh-acp

# 在 stdio 上启动 ACP 服务器
dsh --profile acp
```

setup 脚本会创建 `$DSH_HOME/profiles/acp`（`dsh.profile.bundles = ["@deepseek-ai/dsh-base", "dsh-acp"]`）并用 pnpm 安装。可重复执行，`--force` 强制重写清单。

## 在 Zed 中使用

Zed → 设置 → `agent_servers`：

```json
{
  "dsh": {
    "type": "custom",
    "command": "dsh-acp",
    "args": []
  }
}
```

`dsh-acp`（本包安装）是 `dsh --profile acp` 的薄启动器；可用 `DSH_BIN` 指向非 PATH 的 `dsh`。模型凭据沿用 dsh 的常规位置（`$DSH_HOME` 设置 / `DEEPSEEK_API_KEY`），与 Web UI 共享，无需二次配置。

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
