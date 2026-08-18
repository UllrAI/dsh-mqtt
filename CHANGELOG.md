# Changelog

All notable changes to this project are documented in this file.

## Unreleased

## 0.1.1 - 2026-08-18

### Added

- Live Worker status with heartbeat expiry, health checks, capacity, and explicit starting, connecting, ready, busy, degraded, offline, and stopped states.
- A packaged Worker management UI for live status, safe configuration summaries, controller invitations, approvals, and revocation.
- Persistent controller authorization with expiring invitations, scoped tokens, SHA-256 token hashes at rest, and optional enforcement for submit and control messages.
- `MqttControllerClient` for authenticated submissions, controls, events, status updates, and terminal results.

### Changed

- Keep DSH Host startup independent from the broker's initial CONNACK; unavailable brokers now reconnect in the background instead of preventing the plugin tree from loading.
- Report broker subscription or ACL initialization failures as degraded instead of incorrectly reporting the Worker as ready.

### Fixed

- Allow the protected management UI shell to load before API authentication, then accept the management token from a session-only browser form.
- Return client-error status codes for malformed management requests and clean up the Gateway if the management listener cannot start.

### Security

- Disable cross-origin management API access by default; deployments must opt in with `managementCorsOrigin`.
- Require a management token for non-loopback listeners and never embed that token into the packaged UI.

## 0.1.0 - 2026-08-18

First public release of `dsh-mqtt`, an MQTT protocol driver and agent worker gateway for DeepSeek Harness.

### Added

- MQTT 3.1.1 and MQTT 5 connectivity over TCP, TLS, WebSocket, and secure WebSocket.
- Username/password authentication, environment-backed secrets, custom CAs, and mutual TLS.
- Request/reply topics for submit, event streaming, terminal results, steer, inject, and cancel.
- DSH Session creation and continuation with profile-model inheritance.
- Retained node presence and MQTT Last Will support.
- QoS 1 request/control deduplication, durable terminal results, and restart recovery.
- Workspace aliases, active-request limits, safe event projection, and ACL-oriented topic layouts.
- English and Chinese setup, protocol, security, and operations documentation.

### Security

- Retained command messages are rejected.
- External Session continuation is disabled by default.
- TLS certificate verification is enabled by default.
- Client certificates and private keys must be configured together and only with secure URLs.

### Compatibility

- Targets DeepSeek Harness `0.1.0-rc.7`.
- Requires Node.js `^22.19.0` or `>=24.0.0`.
