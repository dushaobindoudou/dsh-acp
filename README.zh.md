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
