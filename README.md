# dsh-mqtt

> MQTT protocol driver and agent worker gateway for DSH.

`dsh-mqtt` turns a DSH instance into an MQTT-addressable agent worker. Software that can connect to an MQTT broker can submit work, stream execution events, steer or cancel a running agent, and receive a correlated final result—without exposing the DSH host through a public HTTP server.

This project is currently in the **design stage**. No working plugin has been released yet. This README defines the intended product boundary and the initial protocol so development can start from a shared contract.

## What this project is

`dsh-mqtt` is a long-running DSH host plugin, not merely an `mqtt_publish` or `mqtt_subscribe` model tool.

It acts as an external protocol driver:

```text
Application / CI / SaaS / another agent
                   │
             MQTT request
                   │
                   ▼
              MQTT broker
                   │
                   ▼
            dsh-mqtt gateway
                   │
          create or resume session
                   │
        followup / steer / inject / cancel
                   │
                   ▼
               DSH agent
                   │
       session events and final result
                   │
                   ▼
              MQTT broker
                   │
                   ▼
                 Client
```

The gateway owns the long-lived MQTT subscription and maps incoming messages to DSH's agent lifecycle. Agent output is observed through DSH session events and published back to MQTT. A model invocation never blocks while waiting inside an MQTT subscribe tool.

## Why MQTT

MQTT is useful here because it provides a lightweight, bidirectional, asynchronous transport between software and agent workers.

- **Works behind NAT and firewalls.** A DSH host only needs an outbound connection to the broker.
- **Bidirectional over one connection.** Commands flow to the worker while events and results flow back.
- **Offline-friendly delivery.** Persistent sessions and QoS 1 can preserve commands while a worker temporarily reconnects, subject to broker configuration and message expiry.
- **Routing and fan-out.** Topics can address a node, a group of workers, a project, or a workload class.
- **Presence.** Retained status messages and MQTT Last Will provide online/offline discovery without a separate heartbeat service.

MQTT is not intended to replace a normal synchronous HTTP or RPC API. If a caller only needs to send one request and wait on the same connection for one response, HTTP is usually simpler.

## Primary use cases

### Remote agents behind NAT

A cloud service, phone, or CI job can invoke DSH on a workstation or private server without opening an inbound port, configuring a reverse proxy, or assigning a public IP.

This is useful when the worker needs resources that already exist on that machine:

- source repositories and local workspaces;
- development tools and IDE integrations;
- private credentials and enterprise network access;
- GPUs, browsers, or other machine-specific capabilities.

### Lightweight agent worker pools

Multiple DSH nodes can consume a workload through MQTT shared subscriptions:

```text
$share/coders/dsh/v1/acme/workloads/coding
```

This can support small worker fleets for coding, review, browser automation, document processing, media generation, or other agent workloads.

The project does **not** aim to turn MQTT into a full distributed job system. Workloads requiring visibility timeouts, priority queues, dependency graphs, advanced scheduling, dead-letter processing, or strong exactly-once semantics should use a purpose-built queue or workflow engine.

### Asynchronous automation hooks

CI systems and SaaS products can publish work in response to events such as a pull request, monitoring alert, support request, or database change. Producers do not need to know the agent's IP address or whether it is connected at the moment the event occurs.

### Simple agent-to-agent events

Agents may publish and consume coarse-grained events such as `research.completed` or `review.failed`. This is appropriate for loose coordination, not for encoding a complex workflow whose state exists only across MQTT topics.

## Product boundary

### MVP

The first usable version should provide:

- MQTT connection management with TLS support and reconnect handling;
- node-scoped inbound requests;
- DSH session creation or resumption;
- `followup`, `steer`, `inject`, and `cancel` control;
- DSH session-event streaming to MQTT;
- correlated request, event, and result messages;
- persistent `request_id` deduplication for QoS 1 delivery;
- retained node presence using MQTT Last Will;
- an ACL-friendly, versioned topic convention;
- configuration for allowed workspaces and protocol limits.

No web UI is required for the MVP.

### Non-goals

The following are explicitly outside the initial scope:

- replacing DSH's HTTP, ACP, or other synchronous interfaces;
- implementing a general-purpose MQTT client tool for the model;
- implementing a durable workflow engine or enterprise job scheduler;
- hiding broker authentication, authorization, or operational concerns;
- granting unrestricted remote filesystem or workspace access;
- depending on DSH web UI internals.

## Proposed topic convention

All protocol topics are scoped by protocol version, namespace, and node:

```text
dsh/v1/{namespace}/nodes/{node_id}/requests
dsh/v1/{namespace}/nodes/{node_id}/requests/{request_id}/control
dsh/v1/{namespace}/nodes/{node_id}/requests/{request_id}/events
dsh/v1/{namespace}/nodes/{node_id}/requests/{request_id}/result
dsh/v1/{namespace}/nodes/{node_id}/status
```

Example:

```text
dsh/v1/ullrai/nodes/mac-mini/requests
dsh/v1/ullrai/nodes/mac-mini/requests/01JABC123/control
dsh/v1/ullrai/nodes/mac-mini/requests/01JABC123/events
dsh/v1/ullrai/nodes/mac-mini/requests/01JABC123/result
dsh/v1/ullrai/nodes/mac-mini/status
```

The namespace is part of the security boundary. Deployments should use a tenant, team, or user identifier instead of sharing a global `dsh/#` hierarchy.

### Retain and QoS rules

| Topic | Direction | Recommended QoS | Retained |
| --- | --- | ---: | ---: |
| `requests` | client → gateway | 1 | **No** |
| `requests/{id}/control` | client → gateway | 1 | **No** |
| `requests/{id}/events` | gateway → client | 0 or 1 by event class | No |
| `requests/{id}/result` | gateway → client | 1 | No |
| `status` | gateway → client | 1 | **Yes** |

Commands must never be retained. Replaying a retained request after reconnect could repeat a destructive operation. Retained messages are reserved for presence and, in a later version, capability metadata.

Fine-grained streaming deltas may use QoS 0 to reduce overhead. State transitions, errors, and final results should use QoS 1. Clients must still tolerate duplicates and gaps according to the selected event class.

## Protocol envelope

Every request-scoped protocol message uses UTF-8 JSON and includes a small common envelope:

```json
{
  "version": 1,
  "id": "01JABC123",
  "type": "request.submit",
  "timestamp": "2026-08-17T12:00:00Z"
}
```

- `version` is the integer protocol version.
- `id` is the request identifier and correlation key.
- `type` identifies the message schema.
- `timestamp` is an RFC 3339 UTC timestamp.

Unknown fields should be ignored within the same protocol version. Unknown message types or unsupported versions should produce a structured error result rather than being executed.

## Submit a request

Publish a non-retained message to the node's `requests` topic:

```json
{
  "version": 1,
  "id": "01JABC123",
  "type": "request.submit",
  "timestamp": "2026-08-17T12:00:00Z",
  "input": "Run the tests and fix the failures.",
  "workspace": "repo-foo",
  "session_id": null,
  "metadata": {
    "source": "github-actions",
    "pull_request": 42
  }
}
```

Field behavior:

- `input` is the instruction delivered to the agent.
- `workspace` is a configured workspace alias, not an arbitrary filesystem path. The gateway resolves aliases through a local allowlist.
- `session_id` is optional. When absent, the gateway creates a session. When present, the gateway resumes an authorized session and sends a follow-up.
- `metadata` is opaque correlation data with configured size limits. It must not alter authorization decisions.

The default response topics are derived from the request ID. A future optional `reply_to` feature may support client-owned topic roots, but it must be restricted by configuration and ACLs so a publisher cannot make the gateway write to arbitrary broker topics.

## Control a running request

Publish control messages to `requests/{request_id}/control`.

### Steer

```json
{
  "version": 1,
  "id": "01JABC123",
  "command_id": "01JCTRL001",
  "type": "request.steer",
  "timestamp": "2026-08-17T12:01:00Z",
  "input": "Focus on the failing integration tests first."
}
```

### Inject

```json
{
  "version": 1,
  "id": "01JABC123",
  "command_id": "01JCTRL002",
  "type": "request.inject",
  "timestamp": "2026-08-17T12:01:10Z",
  "input": "The staging API is currently unavailable."
}
```

### Cancel

```json
{
  "version": 1,
  "id": "01JABC123",
  "command_id": "01JCTRL003",
  "type": "request.cancel",
  "timestamp": "2026-08-17T12:02:00Z",
  "reason": "user_cancelled"
}
```

`command_id` uniquely identifies a control operation so duplicate QoS 1 deliveries can be ignored without suppressing later controls for the same request. Control messages are accepted only while the correlated request/session is active and only from a principal authorized for that node and request.

## Stream events

The gateway translates relevant DSH session events into stable protocol events. It should not expose private host objects or make consumers depend directly on DSH's internal event representation.

Example assistant delta:

```json
{
  "version": 1,
  "id": "01JABC123",
  "type": "agent.output.delta",
  "timestamp": "2026-08-17T12:00:05Z",
  "sequence": 7,
  "data": {
    "text": "I found three failing tests..."
  }
}
```

Expected event classes include:

- request accepted and session assigned;
- agent status changes;
- assistant output and streaming deltas;
- tool start, progress, and completion summaries;
- approval requested or resolved;
- cancellation acknowledged;
- recoverable and terminal errors.

Secrets, raw credentials, and sensitive tool payloads must be redacted before publication. Remote approval decisions are not part of the initial protocol; approval events are observational until a separate authorization model is defined.

## Final result

Every accepted request reaches one terminal result: `completed`, `failed`, or `cancelled`.

```json
{
  "version": 1,
  "id": "01JABC123",
  "type": "request.result",
  "timestamp": "2026-08-17T12:04:00Z",
  "status": "completed",
  "session_id": "session_abc",
  "summary": "Updated the dependency and fixed the affected tests.",
  "error": null
}
```

A result indicates the terminal state of the agent request. It does not imply that external side effects are transactionally committed or exactly once.

## Request lifecycle

```text
request.submit
      │
      ├─ validate envelope, ACL context, size, and workspace alias
      │
      ├─ reserve request_id in persistent deduplication storage
      │
      ├─ create or resume an authorized DSH session
      │
      ├─ agent.followup(input)
      │
      ├─ session/event → normalized MQTT events
      │
      └─ completed / failed / cancelled → final MQTT result
```

`steer`, `inject`, and `cancel` are routed to the active agent associated with the request. The request-to-session association remains gateway-owned so callers do not need to understand the complete DSH session model.

## Delivery and idempotency

MQTT QoS 1 is **at least once**, not exactly once. The gateway must assume that submit and control messages can be delivered more than once.

The first release must therefore persist enough information to deduplicate requests across reconnects and process restarts:

- the request ID and normalized request identity;
- its accepted, active, or terminal state;
- the associated DSH session ID;
- the terminal result, when available;
- processed control `command_id` values for active requests;
- an expiry time for bounded storage.

On a duplicate `request.submit`:

- if the payload conflicts with the original request, reject it with an ID-conflict error;
- if the original request is active, do not invoke the agent again;
- if the original request is terminal, republish or otherwise make the stored result available according to the final protocol behavior.

Deduplication prevents repeated gateway invocation. It cannot guarantee exactly-once effects in tools or external systems used by the agent.

## Node presence

On a successful broker connection, the gateway publishes a retained online status:

```json
{
  "version": 1,
  "type": "node.status",
  "timestamp": "2026-08-17T12:00:00Z",
  "node_id": "mac-mini",
  "online": true,
  "gateway_version": "0.1.0",
  "capabilities": ["coding", "browser"]
}
```

Before connecting, it configures an MQTT Last Will on the same topic:

```json
{
  "version": 1,
  "type": "node.status",
  "timestamp": "2026-08-17T12:00:00Z",
  "node_id": "mac-mini",
  "online": false
}
```

The broker publishes the Last Will if the gateway disconnects unexpectedly. On graceful shutdown, the gateway should explicitly publish the offline status before disconnecting.

Timestamps in a preconfigured Last Will may describe when the connection was established rather than the exact disconnect time. Consumers must use broker receipt time or their own observation time when precise offline timing matters.

## Configuration sketch

The exact DSH plugin configuration shape will be finalized during implementation. The intended controls are:

```yaml
mqtt:
  url: mqtts://broker.example.com:8883
  client_id: dsh-mac-mini
  namespace: ullrai
  node_id: mac-mini

  auth:
    username_env: DSH_MQTT_USERNAME
    password_env: DSH_MQTT_PASSWORD

  session:
    clean: false
    expiry_seconds: 86400

  limits:
    max_message_bytes: 65536
    max_metadata_bytes: 8192
    dedup_ttl_seconds: 604800

  workspaces:
    repo-foo: /Users/example/code/foo
    docs: /Users/example/docs
```

Secrets should be read from environment variables or a host secret provider, not committed to configuration files.

## Security model

An MQTT request can cause an agent to use local tools, files, credentials, and network access. Treat the gateway as a remote execution boundary.

At minimum, production deployments should enforce:

1. **TLS:** use `mqtts://` and verify the broker certificate.
2. **Broker authentication:** assign a distinct identity to each gateway and client.
3. **Per-namespace and per-node ACLs:** clients may publish only to authorized request/control topics and subscribe only to authorized event/result topics.
4. **Direction-specific ACLs:** clients must not publish fake results or status; gateways must not accept commands from event topics.
5. **Workspace allowlists:** external requests select configured aliases instead of arbitrary paths.
6. **Session ownership:** resuming or controlling a session requires authorization beyond merely knowing its ID.
7. **Input and payload limits:** bound message size, metadata size, active requests, and event throughput.
8. **Secret redaction:** normalize and filter DSH events before sending them to the broker.
9. **Audit logging:** record accepted, rejected, controlled, and completed requests without logging secrets.
10. **Safe broker defaults:** disable anonymous access and broad wildcard grants such as unrestricted `dsh/#` read/write access.

Example ACL intent for a client authorized to use one node:

```text
publish   dsh/v1/ullrai/nodes/mac-mini/requests
publish   dsh/v1/ullrai/nodes/mac-mini/requests/+/control
subscribe dsh/v1/ullrai/nodes/mac-mini/requests/+/events
subscribe dsh/v1/ullrai/nodes/mac-mini/requests/+/result
subscribe dsh/v1/ullrai/nodes/mac-mini/status
```

The gateway uses the inverse direction for those request and response topics. Exact ACL syntax depends on the broker.

## Shared subscriptions and worker pools

Shared subscriptions are a possible extension for workload-class topics:

```text
dsh/v1/{namespace}/workloads/{class}
```

Workers in a consumer group could subscribe through:

```text
$share/{group}/dsh/v1/{namespace}/workloads/{class}
```

This is intentionally separate from the node-addressed MVP. Before enabling worker pools, the protocol must define ownership, offline delivery, rejection, retry, expiry, and what happens when a worker accepts a job and then disappears. MQTT delivery alone does not solve those job semantics.

## Minimal client flow

A client needs only one publish and two subscriptions for a basic request/reply flow:

```text
1. Generate a unique request ID.
2. Subscribe to requests/{id}/events and requests/{id}/result.
3. Publish request.submit to the node's requests topic with retain=false.
4. Consume zero or more events.
5. Stop when the terminal result arrives.
```

Illustrative command-line interaction:

```bash
REQUEST_ID=01JABC123
BASE=dsh/v1/ullrai/nodes/mac-mini

mosquitto_sub \
  -h broker.example.com \
  -t "$BASE/requests/$REQUEST_ID/events" \
  -t "$BASE/requests/$REQUEST_ID/result"

mosquitto_pub \
  -h broker.example.com \
  -q 1 \
  -t "$BASE/requests" \
  -m '{"version":1,"id":"01JABC123","type":"request.submit","timestamp":"2026-08-17T12:00:00Z","input":"Run the tests and fix the failures.","workspace":"repo-foo"}'
```

Authentication and TLS flags are omitted from the example for readability and are required in real deployments.

## DSH integration strategy

The implementation should stay thin and use DSH's public host/plugin abstractions:

- maintain the MQTT connection in the host plugin lifecycle;
- resolve, create, or resume agents through `ctx.agents`;
- map inbound input to `followup`, `steer`, `inject`, or `cancel`;
- observe `session/event` for assistant output, tool activity, status, and errors;
- translate DSH events into a small, versioned MQTT schema;
- avoid dependencies on web UI internals.

DSH is currently a developer-preview project and may introduce breaking changes. Keeping the adapter narrow around agent and session primitives reduces the integration surface that must change with DSH.

## Planned development phases

### Phase 1: protocol and single-node gateway

- finalize message schemas and error codes;
- connect and reconnect to one broker;
- implement node-addressed submit and result;
- bridge session events;
- add steer, inject, and cancel;
- add persistent request deduplication;
- add presence and Last Will;
- test ACL, retained-message, duplicate-delivery, and reconnect behavior.

### Phase 2: operational hardening

- metrics and structured audit logs;
- backpressure and concurrency limits;
- event redaction policies;
- broker interoperability tests;
- compatibility tests across supported DSH versions;
- reference clients and deployment examples.

### Phase 3: optional worker pools

- shared workload topics;
- worker capability advertisement;
- acceptance, expiry, retry, and orphaned-job semantics;
- comparison and interoperability guidance for external queue systems.

## Open design questions

The implementation will need explicit decisions on:

- the minimum supported DSH version and stable plugin APIs;
- the embedded or external persistence mechanism for deduplication;
- event taxonomy and which event classes use QoS 0 versus QoS 1;
- result recovery after a client reconnects without using retained results;
- maximum session lifetime and request-to-session ownership rules;
- whether constrained client-specific `reply_to` topics are needed;
- how approval responses should be authenticated if added later;
- broker support and the MQTT protocol version baseline (3.1.1 versus 5.0).

## Project status

The repository currently documents the proposal only. Interfaces, examples, and schemas may change until the first tagged release.

The next milestone is to validate the DSH plugin lifecycle and session event APIs, turn the protocol examples into machine-checkable schemas, and implement the smallest end-to-end request → agent → result path.
