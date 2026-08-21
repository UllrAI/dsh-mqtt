# dsh-mqtt

[English](README.md) | 中文

适用于 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness)的 MQTT 协议驱动与 Agent Worker 网关。

`dsh-mqtt` 可以把一个 DSH 进程变成可通过 MQTT 寻址的 Agent Worker。客户端能够提交任务、观察规范化后的执行事件、对正在运行的回合执行 steer 或 inject、取消任务，并取得有关联 ID 的最终结果。DSH 主机只需主动连接 Broker，因此即使 Worker 位于 NAT 或防火墙之后，也不必对外暴露 HTTP Server。

> [!IMPORTANT]
> `0.1.5` 支持在界面上停止正在运行的任务，让某个慢会话不再拖住其他会话，并在控制端审批关闭时给出明确提示，目前适配 DSH `0.1.0-rc.8`。DSH 本身仍处于 developer preview 阶段，后续可能有破坏性变更。

## 已实现能力

- 支持通过 TCP、TLS、WebSocket 或安全 WebSocket 连接 MQTT 3.1.1 / 5 Broker；
- 支持直接配置或通过环境变量读取 Broker 用户名/密码，并支持自定义 CA 与可选的双向 TLS；
- 支持持久 MQTT Session、断线重连、retained Presence 与 Last Will；
- 支持节点级 `submit`、`steer`、`inject` 和 `cancel` 命令；
- 创建 DSH Agent，并在受控范围内续接已有 Session；
- 输出规范化的 `session/event`、Agent 状态与 Agent 错误；
- 对 QoS 1 请求和控制命令进行跨重连、跨进程重启去重；
- 持久化最终结果，并恢复重启时中断的请求；
- 通过 workspace 别名限制目录，不接受调用方传入任意文件系统路径；
- 限制活动请求数和消息大小；
- 默认输出安全事件视图，也可显式开启完整事件；
- 使用版本化、便于配置 ACL 的 Topic 结构。

它是一个随 DSH Host 常驻的插件，不是提供给模型调用的 `mqtt_publish` 或 `mqtt_subscribe` tool。MQTT 订阅由 DSH 进程长期维护，收到消息后再唤醒或控制 Agent。

## 适用场景

典型场景包括：

- 让 CI 或云端服务调用办公室电脑、个人工作站或私有服务器上的 DSH；
- 运行一小组拥有本地仓库、凭据、浏览器或 GPU 的 DSH Worker；
- 生产者与 Worker 不应维持直连的异步自动化；
- 简单的软件到 Agent、Agent 到 Agent 事件集成。

它不用于替代普通同步 HTTP API、通用 MQTT 客户端工具，也不试图实现具有 visibility timeout、优先队列、任务依赖、死信处理或 exactly-once 执行语义的工作流/任务系统。

## 工作方式

```text
客户端 / CI / SaaS
        │ request.submit（MQTT）
        ▼
   MQTT Broker
        │
        ▼
 dsh-mqtt 网关 ── 创建/恢复 ──► DSH Agent
        ▲                            │
        └──── 事件 / 最终结果 ───────┘
```

实现只使用 DSH 的公开 Agent 与事件接口：

- `ctx.agents.create()` 和 `ctx.agents.resume()`；
- `ctx.agentDefaultModel.currentSelection()` 和 Agent 范围内的模型选择；
- `agent.followup()`、`agent.steer()`、`agent.inject()` 和 `agent.cancel()`；
- `session/event`、`agent/status` 和 `agent/error`。

管理界面建立在 DSH 留给第三方客户端代码的唯一扩展点 `ctx.slots` 之上：注册一个 `settings.section` 分区，与内置分区并列，不覆盖其中任何一个。DSH 没有为插件界面提供数据通道，因此面板通过 HTTP 读取插件自己的管理 API。

## 快速上手

### 前置条件

- Node.js `^22.19.0` 或 `>=24`；
- `PATH` 中可执行的 `pnpm`（DSH 会把插件管理命令转交给 pnpm）；
- DSH 模型供应商凭据，例如 `DEEPSEEK_API_KEY`；
- MQTT Broker，以及 Mosquitto 等 MQTT 客户端。

开发环境可以先启动一个仅供本机使用的 Broker：

```sh
mosquitto -p 1883 -v
```

Mosquitto 2 在未配置 listener 时只绑定本机。不要把匿名开发 Broker 暴露到其他网络。

### 云 MQTT Broker

当 DSH Worker 与调用方位于不同网络时，使用托管 Broker 会更方便。以下服务都提供标准 MQTT 接入端点；此列表仅供选择参考，不代表项目背书：

| 服务 | 说明 |
| --- | --- |
| [MQTT.pro](https://mqtt.pro/) | Serverless 托管 MQTT Broker，支持 TLS/SSL、用户名密码认证和 ACL。 |
| [RunMQTT](https://runmqtt.com/) | 提供隔离的托管 Broker、设备身份、可复用 Topic 策略，以及 MQTT over TLS 和安全 WebSocket 接入。 |
| [EMQX Cloud](https://www.emqx.com/zh/cloud) | 全托管 MQTT 服务，支持 retained message、shared subscription、规则与数据集成。 |
| [HiveMQ Cloud](https://www.hivemq.com/products/mqtt-cloud-broker/) | 托管 MQTT 3.1.1/5 服务，支持 TLS、WebSocket、凭据和 Topic 权限。 |

把服务商生成的端点、端口、用户名和密码填入下文连接示例即可。生产使用前，请根据服务商最新文档确认协议版本、区域、认证方式、ACL、持久 Session 和配额。列入此表不表示其所有套餐都支持表中全部能力。

### 安装插件

DSH 按 profile 安装插件。第一次使用建议装到 `web` profile，这样仍可使用常规 DSH UI。无人值守部署也可以建立 `mqtt-worker` 等专用 profile。

从 npm 安装：

```sh
npx @deepseek-ai/dsh plugin --profile web add dsh-mqtt@0.1.5
```

从本地源码安装：

```sh
git clone https://github.com/UllrAI/dsh-mqtt.git
cd dsh-mqtt
npx @deepseek-ai/dsh plugin --profile web add .
```

直接从 GitHub 安装：

```sh
npx @deepseek-ai/dsh plugin --profile web add github:UllrAI/dsh-mqtt
```

Git 依赖会通过包内的 `prepare` 脚本完成构建。pnpm 10 及以上版本可能在第一次安装时拒绝执行，并输出一个 `allowBuilds` key。请把错误信息中给出的准确 key 加到 `~/.dsh/profiles/web/pnpm-workspace.yaml`（或 `$DSH_HOME/profiles/web/pnpm-workspace.yaml`）的 `allowBuilds` 下，然后重新执行安装。使用本地源码目录或已经构建好的 tarball 不需要这一步。

安装站外 bundle 时，pnpm 也可能提示缺少 DSH peer dependency。DSH launcher 会在启动时通过 profile fallback 提供自身匹配版本的核心包；应以 `--dump-config` 和下文的实际启动检查为准。

### 配置 profile

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，如设置过 `DSH_HOME`，则编辑对应目录下的文件。插件 bundle 已经插入了名为 `mqtt-gateway` 的配置行；profile patch 会替换这行的完整配置。

```yaml
- id: mqtt-gateway
  config:
    url: mqtt://127.0.0.1:1883
    namespace: ullrai
    nodeId: mac-mini
    displayName: Mac mini · 开发机

    # 管理 API 与独立页面默认只监听本机 127.0.0.1:3210。
    # DSH 设置面板也读这个 API，端口不要关。
    managementHost: 127.0.0.1
    managementPort: 3210
    requireControllerAuth: true

    workspaces:
      repo-foo: /absolute/path/to/repo-foo
    defaultWorkspace: repo-foo

    # 使用绝对路径，避免状态文件随启动目录变化。
    stateFile: /absolute/path/to/dsh-mqtt-state.json

    capabilities: [coding]
```

路径由 Node.js 解析。配置值中的 `~` 和环境变量不会被展开，请使用绝对路径；相对路径以启动 DSH 时所在的目录为基准。

先检查合成后的 profile，不启动插件：

```sh
npx @deepseek-ai/dsh --profile web --dump-config
```

然后从需要的工作目录启动 DSH：

```sh
export DEEPSEEK_API_KEY='...'
npx @deepseek-ai/dsh --profile web
```

### 打开 Worker 界面

Worker 界面有两种形态，背后是同一套面板和同一个 API，按部署情况挑一种即可。

**在 DSH 内。** 打开 DSH 设置，选择 **MQTT Worker**。这是常规入口：不用另开标签页，面板的语言和主题跟随 DSH。它读取 `managementPort` 上的管理 API，本机来源无需额外配置即可访问。如果管理服务不在 `http://127.0.0.1:3210`，在页面上设置 `DSH_MQTT_MANAGEMENT_URL` 指向它的 `/api` 根路径。

**独立页面。** 无头部署或远程 Worker 面前没有 DSH 页面时，插件也会在 Worker 本机提供一个自带页面：

```text
http://127.0.0.1:3210/
```

![Worker 界面，展示节点健康、控制端与最近任务](https://raw.githubusercontent.com/UllrAI/dsh-mqtt/main/docs/worker-ui-zh.png)

这里显示的 Broker、Agent、模型、工作区和任务容量均来自 Gateway 实时检查，不使用演示数据。两种形态都可以生成控制端邀请、确认授权、查看最近任务与最近使用时间并撤销控制端。更新通过 Server-Sent Events 推送，连接无法保持时自动退回轮询。设置 `managementPort: 0` 会同时关闭 API 与独立页面 —— DSH 面板届时也读不到任何数据。

面板支持中英文。在 DSH 内跟随 DSH 的语言设置；独立页面会读取浏览器语言，也可以在页头随时切换。

管理服务默认只绑定 loopback。若把 `managementHost` 设置为 `0.0.0.0` 或其他非本机地址，必须同时设置 `managementToken` 或 `managementTokenEnv`；界面会要求输入 token，并且只在当前标签页的 `sessionStorage` 中保存，API 调用则需发送 `Authorization: Bearer <token>`。跨域请求默认放行本机来源，这正是 DSH 面板所需；也可以设置 `managementCorsOrigin` 指定唯一的精确来源。不要把未认证的管理端口暴露到局域网或互联网。

### 添加控制端

1. 在 Worker 界面点击“添加控制端”，输入名称并生成十分钟有效的配置。
2. 把配置复制到控制端；配置只包含 Broker 地址、namespace、节点 ID、控制端 ID 和一次性 token，不包含 Worker 的 Broker 密码或模型凭据。
3. 控制端仍需配置独立的 Broker 凭据，并按下面的 ACL 仅访问目标节点。
4. 回到 Worker 界面确认授权。启用 `requireControllerAuth: true` 后，未授权、已过期或已撤销的 token 无法提交或控制任务。

程序化控制端可以直接使用包导出的 `MqttControllerClient`。它会自动在提交和控制消息中携带 `controller_id` 与 `token`，订阅节点状态、事件和结果，并提供 `waitForResult()`。

以下命令应立即收到 retained 在线状态：

```sh
mosquitto_sub -h 127.0.0.1 -q 1 -v \
  -t 'dsh/v1/ullrai/nodes/mac-mini/status'
```

### 提交任务

事件和结果不会 retain，因此应先订阅再提交：

```sh
export BASE='dsh/v1/ullrai/nodes/mac-mini'
export REQUEST_ID="request-$(date +%s)"

mosquitto_sub -h 127.0.0.1 -q 1 -v \
  -t "$BASE/requests/$REQUEST_ID/events" \
  -t "$BASE/requests/$REQUEST_ID/result"
```

在另一个终端中使用相同的 `BASE` 和 `REQUEST_ID`：

```sh
export NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mosquitto_pub -h 127.0.0.1 -q 1 \
  -t "$BASE/requests" \
  -m "{\"version\":1,\"id\":\"$REQUEST_ID\",\"type\":\"request.submit\",\"timestamp\":\"$NOW\",\"input\":\"运行测试并总结失败原因。\",\"workspace\":\"repo-foo\"}"
```

网关会依次发布 `request.accepted`、`request.session`、Agent/Session 事件以及一个最终 `request.result`：

```json
{
  "version": 1,
  "id": "request-1755417600",
  "type": "request.result",
  "timestamp": "2026-08-17T12:04:00.000Z",
  "status": "completed",
  "session_id": "mqtt-6a0fe184-bb2a-45d4-941b-e079923b93db",
  "summary": "所有测试均已通过。",
  "error": null
}
```

## Topic 结构

所有 Topic 都按协议版本、namespace 和节点隔离：

```text
dsh/v1/{namespace}/nodes/{nodeId}/requests
dsh/v1/{namespace}/nodes/{nodeId}/requests/{requestId}/control
dsh/v1/{namespace}/nodes/{nodeId}/requests/{requestId}/events
dsh/v1/{namespace}/nodes/{nodeId}/requests/{requestId}/result
dsh/v1/{namespace}/nodes/{nodeId}/status
```

当前传输设置如下：

| Topic | 方向 | QoS | Retained |
| --- | --- | ---: | ---: |
| `requests` | 客户端 → 网关 | 网关以 1 订阅；建议以 1 发布 | retained 消息会被拒绝 |
| `requests/{id}/control` | 客户端 → 网关 | 网关以 1 订阅；建议以 1 发布 | retained 消息会被拒绝 |
| `requests/{id}/events` | 网关 → 客户端 | 1 | 否 |
| `requests/{id}/result` | 网关 → 客户端 | 1 | 否 |
| `status` | 网关 → 客户端 | 1 | 是 |

网关绝不会执行 retained 命令。Retain 只用于节点 Presence。

`namespace`、`nodeId`、workspace 别名、请求 ID、命令 ID 和 Session ID 都必须可安全用于 Topic。请求、命令和 Session ID 应匹配：

```text
[A-Za-z0-9][A-Za-z0-9._:-]{0,127}
```

## 协议

消息使用 UTF-8 JSON。请求范围内的输入都包含以下信封：

```json
{
  "version": 1,
  "id": "request-01",
  "type": "request.submit",
  "timestamp": "2026-08-17T12:00:00Z"
}
```

`timestamp` 必须是语法和实际日期都有效的 RFC 3339 date-time。协议版本 1 会验证格式，但暂不限制时钟偏差或消息新鲜度。应使用不可猜测且永不复用的 ID，并通过 Broker 身份认证防止重放。

版本 1 会忽略未知字段；未知消息类型和非法字段不会执行，而是返回拒绝信息。

### 提交请求

```json
{
  "version": 1,
  "id": "request-01",
  "type": "request.submit",
  "timestamp": "2026-08-17T12:00:00Z",
  "input": "升级依赖并运行测试。",
  "workspace": "repo-foo",
  "metadata": {
    "source": "ci",
    "pull_request": 42
  }
}
```

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `version` | 是 | 必须为 `1`。 |
| `id` | 是 | 请求关联与去重键。 |
| `type` | 是 | 必须为 `request.submit`。 |
| `timestamp` | 是 | RFC 3339 date-time。 |
| `input` | 是 | 通过 `agent.followup()` 发送的非空指令。 |
| `workspace` | 新 Session 必填；配置 `defaultWorkspace` 后可省略 | 已配置的目录别名，不是任意路径。 |
| `session_id` | 否 | 续接一个被允许的 DSH Session。 |
| `metadata` | 否 | 有大小限制的任意 JSON object；会原样出现在 `request.accepted` 中，请勿放入秘密。 |

### 控制请求

只有关联请求仍处于活动状态时才接受控制消息。每条控制消息必须使用唯一 `command_id`，用于处理 QoS 1 重复投递。

调整当前回合方向：

```json
{
  "version": 1,
  "id": "request-01",
  "command_id": "command-01",
  "type": "request.steer",
  "timestamp": "2026-08-17T12:01:00Z",
  "input": "先修复集成测试。"
}
```

注入补充信息：

```json
{
  "version": 1,
  "id": "request-01",
  "command_id": "command-02",
  "type": "request.inject",
  "timestamp": "2026-08-17T12:01:10Z",
  "input": "预发布服务目前不可用。"
}
```

取消：

```json
{
  "version": 1,
  "id": "request-01",
  "command_id": "command-03",
  "type": "request.cancel",
  "timestamp": "2026-08-17T12:02:00Z",
  "reason": "user_cancelled"
}
```

控制消息发布到 `requests/{id}/control`。控制失败不会终止整个请求，而是产生 `request.control.failed` 或 `request.control.rejected`。排除原因后，应使用新的 `command_id` 重试。

### 事件

所有事件使用以下信封：

```json
{
  "version": 1,
  "id": "request-01",
  "type": "agent.output.delta",
  "timestamp": "2026-08-17T12:00:05.000Z",
  "sequence": 7,
  "data": { "text": "发现三个失败的测试……" }
}
```

网关自身产生的生命周期事件没有 `sequence`。规范化后的 DSH Session 事件会尽量保留 DSH sequence。客户端必须能够处理 sequence 缺失、消息重复和序号缺口。

默认 `eventExposure: safe` 时：

- 可见的 Assistant 文本会作为 `agent.output.delta` 和 `session.assistant/message` 发出；
- Tool call 只暴露标识符和工具名称，不包含参数；
- Tool result 只暴露标识符和失败状态，不包含结果正文；
- reasoning delta 会被省略；
- 未知 Session 事件的 payload 会替换成 `{ "redacted": true }`；
- 可见文本、usage 和运行错误字段仍属于业务数据，仍可能敏感。

`eventExposure: full` 会复制 DSH 原始事件数据，并给类型加上 `session.` 前缀。只应对可信订阅者启用；完整事件可能包含 Prompt、推理、工具参数、工具输出、路径和秘密。

### 结果与错误

每个已接受请求最终都会被保存为 `completed`、`failed` 或 `cancelled`。结果中的 `error` 为 `null`，或具有以下结构：

```json
{
  "code": "CAPACITY_EXCEEDED",
  "message": "gateway has reached its active request limit",
  "retryable": true
}
```

常见错误码包括 `RETAINED_COMMAND`、`REQUEST_ID_CONFLICT`、`CAPACITY_EXCEEDED`、`SESSION_NOT_OWNED`、`SESSION_BUSY`、`WORKSPACE_REQUIRED`、`WORKSPACE_NOT_ALLOWED`、`AGENT_START_FAILED`、`CONTROL_FAILED`、`GATEWAY_RESTARTED` 和 `GATEWAY_STOPPED`。

最终结果描述的是 Agent 请求状态，并不意味着工具调用或外部副作用具备事务语义。

## 续接 Session

新请求会创建一个随机的 `mqtt-{uuid}` DSH Session，并在结果中返回其 ID。续接时，使用新的请求 ID，并带上该 `session_id`：

```json
{
  "version": 1,
  "id": "request-02",
  "type": "request.submit",
  "timestamp": "2026-08-17T12:10:00Z",
  "input": "现在实现第一个修复。",
  "session_id": "mqtt-6a0fe184-bb2a-45d4-941b-e079923b93db"
}
```

默认只允许恢复已被本 Gateway 记录为创建或使用过的 Session。Session 归属记录与请求去重过期时间相互独立，会长期保留。

`allowExternalSessions: true` 允许任何拥有该节点发布权限的 Broker 客户端请求一个语法合法的 DSH Session ID。MQTT 应用消息不会向插件携带可信的发布者身份，因此 dsh-mqtt 无法在应用层按最终用户授权 Session。开启此配置会把信任边界扩大到所有可以向该节点 request Topic 发布消息的主体。应优先使用 node/namespace 隔离和 Broker ACL。

同一 Session 同时只能由一个活动 MQTT 请求控制。

## 节点 Presence

每次成功连接 Broker 后，网关会发布 retained 在线状态：

```json
{
  "version": 1,
  "type": "node.status",
  "timestamp": "2026-08-17T12:00:00.000Z",
  "node_id": "mac-mini",
  "display_name": "Mac mini · 开发机",
  "state": "ready",
  "online": true,
  "heartbeat_at": "2026-08-18T12:00:00.000Z",
  "expires_at": "2026-08-18T12:00:30.000Z",
  "active_requests": 0,
  "request_capacity": 16,
  "workspaces": [{ "alias": "repo-foo", "status": "ready" }],
  "controller_auth_required": true,
  "gateway_version": "0.1.5",
  "protocol_version": 1,
  "capabilities": ["coding"],
  "health": [
    { "name": "broker", "status": "ready" },
    { "name": "agent", "status": "ready" },
    { "name": "model", "status": "ready" },
    { "name": "workspace:repo-foo", "status": "ready" }
  ]
}
```

`state` 可能为 `starting`、`connecting`、`ready`、`busy`、`degraded`、`offline` 或 `stopped`。Controller 不应只看 retained `online: true`；当前时间超过 `expires_at` 时应将节点视为 stale，等待下一次心跳。状态只暴露工作区别名，不暴露真实路径。

网关会在同一 Topic 配置 retained 离线 Last Will，并在正常关闭时主动发布离线状态。Last Will 的时间戳在建立连接配置时生成，不是 Broker 检测到断线的时刻；需要精确离线时间时，应使用 Broker 接收时间。

## 投递、去重与恢复

MQTT QoS 1 是 at least once。dsh-mqtt 使用请求 payload 指纹和 `id`，以及控制 payload 指纹和 `command_id`，避免同一消息重复执行。相同 ID 搭配不同内容会被拒绝。

JSON 状态文件通过同目录临时文件和原子 rename 写入；支持 POSIX 权限的平台会将文件模式设为 `0600`。其中保存：

- 请求指纹和生命周期状态；
- 请求与 Session 的关联；
- 控制消息去重记录；
- 最终结果；
- Gateway 拥有的 Session ID。

启动时，前一个进程遗留的 accepted/active 请求会被标记为 `GATEWAY_RESTARTED` 失败，并在重连后发布结果。正常关闭时，活动请求会先取消，再保存为 `GATEWAY_STOPPED`。

最终请求及其控制记录在 `dedupTtlSeconds` 后过期，默认七天。Session 归属记录目前不会过期。不要在 TTL 后复用请求 ID：过期 ID 会被视为新请求，可能再次执行。

QoS 1 出站消息在 MQTT.js 接收到 outgoing store 后即返回，不会无限等待 Broker ACK。MQTT.js 默认 outgoing store 位于内存，因此：

- Broker 重连期间 Agent 可以继续推进；
- 只要进程未退出，重连后可以发送排队消息；
- 进程崩溃可能丢失尚未发出的事件；
- 最终结果仍保存在 JSON 状态中。在 TTL 到期前，用相同 ID 重发完全一致的原请求即可恢复；
- 事件不会重放，可能存在缺口。

要可靠接收结果，应使用持久客户端 Session，或先订阅再提交。如果错过结果，先订阅 result Topic，再用相同 ID 重发完全一致的原请求。网关会重新发布已保存的最终结果，不会再次调用 Agent。

## 配置参考

配置项按 DSH 设置表单的分组方式列出。解析后的配置对象仍是扁平结构，分组不影响下面的 YAML 写法。

#### Broker 连接

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `url` | `mqtt://127.0.0.1:1883` | `mqtt`、`mqtts`、`ws` 或 `wss` Broker URL。 |
| `protocolVersion` | `5` | MQTT 5 使用 `5`，MQTT 3.1.1 使用 `4`。 |
| `clientId` | `dsh-mqtt-{namespace}-{nodeId}` | 稳定的 MQTT client ID。 |
| `clean` | `false` | MQTT clean session/start。需要离线接收命令时保持 `false`。 |
| `keepaliveSeconds` | `30` | MQTT keepalive。 |
| `connectTimeoutMs` | `10000` | 首次连接超时。 |
| `reconnectPeriodMs` | `1000` | 重连间隔；`0` 表示不重连。 |
| `sessionExpirySeconds` | `86400` | MQTT 5 Session 过期时间；MQTT 3.1.1 下忽略。 |
| `username`、`password` | 未设置 | 直接配置 Broker 凭据。不建议在 profile 中保存 `password`。 |
| `usernameEnv`、`passwordEnv` | 未设置 | 保存 Broker 凭据的环境变量名；不能与对应直接值同时配置。 |

#### TLS

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `caFile` | 未设置 | TLS CA bundle 的绝对路径。 |
| `certFile`、`keyFile` | 未设置 | 双向 TLS 客户端证书与私钥路径。 |
| `rejectUnauthorized` | `true` | 验证 Broker TLS 证书；生产环境不要关闭。 |

#### 节点身份

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `namespace` | `local` | Topic namespace；1–64 个安全字符。 |
| `nodeId` | `dsh-node` | 节点 Topic segment；1–64 个安全字符。 |
| `displayName` | 节点 ID | 展示给控制端和 Worker 界面的名称。 |
| `capabilities` | `[]` | 在线 Presence 中发布的描述性能力列表。 |

#### Agent 与工作区

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `workspaces` | `{}` | 新 Session 可选择的“别名 → 目录”白名单。 |
| `defaultWorkspace` | 未设置 | 新请求未提供 `workspace` 时使用的别名。 |
| `allowExternalSessions` | `false` | 允许续接未被本网关记录的 Session；务必阅读上文安全说明。 |
| `provider`、`model`、`maxTokens` | 当前 DSH profile 选择 | 可选的 Agent 创建参数覆盖。`provider` 和 `model` 必须同时设置；否则网关会读取 `ctx.agentDefaultModel`。 |
| `eventExposure` | `safe` | `safe` 规范化事件，或 `full` 原始事件数据。 |
| `stateFile` | `.dsh-mqtt/state.json` | 持久化去重、结果和 Session 归属的 JSON 文件。 |

#### 限额

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `maxMessageBytes` | `65536` | MQTT 入站 payload 最大字节数。 |
| `maxMetadataBytes` | `8192` | `metadata` 序列化后的最大字节数，不得超过 `maxMessageBytes`。 |
| `maxInputChars` | `32768` | `input` 的最大 JavaScript 字符数。 |
| `maxActiveRequests` | `16` | accepted/active 请求总数上限。 |
| `dedupTtlSeconds` | `604800` | 最终请求和控制去重记录保留时间。 |
| `heartbeatSeconds` | `15` | 发布 retained 状态的间隔。连续两次心跳缺失后，控制端会判定节点已失联。 |

#### 管理界面

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `managementPort` | `3210` | 管理 API 与独立页面的端口。`0` 会同时关闭两者，DSH 面板届时也读不到数据。 |
| `managementHost` | `127.0.0.1` | 绑定地址。非 loopback 地址必须配置管理 token。 |
| `managementCorsOrigin` | 未设置 | 允许调用 API 的唯一精确来源。留空表示只放行本机来源，这正是 DSH 面板所需。 |
| `managementToken` | 未设置 | 调用 API 所需的 Bearer token。 |
| `managementTokenEnv` | 未设置 | 保存管理 token 的环境变量名；不能与 `managementToken` 同时配置。 |
| `requireControllerAuth` | `false` | 要求控制端先经邀请与授权，才能提交或控制任务。 |

### 凭据与 TLS

网关既支持直接填写 MQTT 用户名/密码，也支持从环境变量读取凭据。无人值守部署应优先使用环境变量，避免把密码保存在 DSH profile 中。

#### 非 TLS 用户名/密码连接

这种配置只适合 loopback、VPN 或其他可信私网。MQTT 用户名/密码认证本身不会加密凭据和 payload。

```yaml
- id: mqtt-gateway
  config:
    url: mqtt://broker.internal.example:1883
    namespace: ullrai
    nodeId: mac-mini
    username: dsh-mac-mini
    password: replace-with-broker-password
```

这里直接填写 `password` 只是为了展示完整配置，不要把真实密码提交到 profile。流量只要经过不可信网络，就应使用 `mqtts://` 或 `wss://`。

#### TLS 用户名/密码连接

连接云 Broker 时推荐使用这种配置：

```yaml
- id: mqtt-gateway
  config:
    url: mqtts://broker.example.com:8883
    namespace: ullrai
    nodeId: mac-mini
    usernameEnv: DSH_MQTT_USERNAME
    passwordEnv: DSH_MQTT_PASSWORD
    rejectUnauthorized: true
    stateFile: /var/lib/dsh-mqtt/state.json
    workspaces:
      repo-foo: /srv/repos/repo-foo
```

```sh
export DSH_MQTT_USERNAME='dsh-mac-mini'
export DSH_MQTT_PASSWORD='...'
npx @deepseek-ai/dsh --profile web
```

请使用 Broker 提供的准确 hostname 和端口。使用公共 CA 签发证书时通常不需要配置 `caFile`；默认会验证证书和 hostname。安全 WebSocket 端点使用服务商给出的 `wss://` URL 与路径，凭据字段保持相同。

#### 自定义 CA 与双向 TLS

如果 Broker 使用私有 CA，或要求客户端证书，请在 TLS 配置中加入相应文件：

```yaml
- id: mqtt-gateway
  config:
    url: mqtts://broker.internal.example:8883
    namespace: ullrai
    nodeId: mac-mini
    usernameEnv: DSH_MQTT_USERNAME
    passwordEnv: DSH_MQTT_PASSWORD
    caFile: /etc/dsh-mqtt/ca.pem
    certFile: /etc/dsh-mqtt/client.pem
    keyFile: /etc/dsh-mqtt/client-key.pem
    rejectUnauthorized: true
```

`caFile` 用于提供信任的 CA bundle；`certFile` 和 `keyFile` 用于启用双向 TLS，Broker 要求时必须配套设置。Broker 可以在用户名/密码之外额外要求 mTLS，也可以只使用 mTLS。生产环境不要设置 `rejectUnauthorized: false`。

## Broker ACL

Broker 是身份认证和授权边界。应分别为 Gateway 与客户端配置凭据，并只授予单一 namespace/node 所需的方向。

以下是 Mosquitto ACL 意图示例：

```text
user dsh-gateway-mac-mini
topic read  dsh/v1/ullrai/nodes/mac-mini/requests
topic read  dsh/v1/ullrai/nodes/mac-mini/requests/+/control
topic write dsh/v1/ullrai/nodes/mac-mini/requests/+/events
topic write dsh/v1/ullrai/nodes/mac-mini/requests/+/result
topic write dsh/v1/ullrai/nodes/mac-mini/status

user automation-client
topic write dsh/v1/ullrai/nodes/mac-mini/requests
topic write dsh/v1/ullrai/nodes/mac-mini/requests/+/control
topic read  dsh/v1/ullrai/nodes/mac-mini/requests/+/events
topic read  dsh/v1/ullrai/nodes/mac-mini/requests/+/result
topic read  dsh/v1/ullrai/nodes/mac-mini/status
```

同时应启用 TLS、关闭匿名访问、保护状态文件与 workspace 目录，并避免授予不受限制的 `dsh/#` 读写权限。任何能向节点发布请求的主体，都可能让 Agent 使用该 DSH 进程拥有的本地工具和凭据。

## 开发与验证

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm publint
pnpm check
```

`pnpm check` 会依次执行 lint、TypeScript 类型检查、覆盖率测试、构建和包导出验证。集成测试会启动真实的进程内 Aedes MQTT Broker，验证订阅、发布、QoS 1 确认时机与 Last Will 行为。

检查最终发布包内容：

```sh
pnpm pack
```

### 发布自动化

发布由 Git tag 驱动。先更新 `package.json` 和 `CHANGELOG.md`，提交后推送与版本一致的正式 tag：

```sh
git tag v0.1.5
git push origin v0.1.5
```

`Release` 工作流会校验 tag 是否与 `package.json` 一致，使用锁文件安装依赖，运行完整的 `pnpm check`，发布 npm 包，并创建带自动生成说明的 GitHub Release；若重试时该版本已经存在于 npm，则会跳过重复发布。发布走 [trusted publishing](https://docs.npmjs.com/trusted-publishers/)：任务临时申请一个 OIDC token 换取发布权限，因此不存在需要定期轮换的长期密钥，每次发布还会附带 provenance 签名。这需要事先在 npmjs.com 上为本包配置 trusted publisher，指向本仓库的 `release.yml`。在单独定义预发布策略前，工作流会拒绝预发布 tag。只有版本号、变更日志和发布内容都准备好后，才应创建 tag。

公共模块会导出 Cordis 插件以及 `MqttAgentGateway`、`RequestStore` 和 `TopicLayout`。`dsh-mqtt/protocol` 会导出协议类型、解析器、指纹和信封构造函数。

## 当前限制

- 当前 DSH 兼容性固定在仍快速变化的 `0.1.0-rc.8` API。
- DSH Host 启动插件时不会等待 Broker。如果 Broker 不可用或 CONNACK 延迟，插件仍会完成加载，MQTT.js 会按 `reconnectPeriodMs` 持续重试；建立连接后才会处理请求并发布 Presence。
- 已实现的是节点寻址协议；shared subscription Worker Pool 和 workload class Topic 尚未实现。
- 不支持任意 `reply_to`，响应 Topic 由请求 ID 推导。
- 尚不支持通过 MQTT 响应远程审批或用户问题。请使用能够处理这些交互的 DSH 界面，或合理配置无人值守 Worker。
- JSON 状态库只适用于单个网关进程，不是多进程共享存储。
- Result 和 event 不 retain，event 也不能持久重放。
- Session 归属记录暂时不会自动清理。
- `safe` 事件模式是保守投影，不是数据防泄漏系统。
- 去重只能防止 TTL 范围内重复调用 Gateway，不能保证工具或外部副作用 exactly once。
- MQTT 消息过期、死信队列、优先级、调度和任务依赖属于 Broker 或工作流系统职责，不在本插件内实现。

## 许可证

[MIT](LICENSE) © 2026 UllrAI
