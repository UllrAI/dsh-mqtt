# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- The standalone page has a language switch in its header and remembers the choice, matching what the DSH shell already does for the settings panel.
- Screenshots of the Worker UI in both READMEs.

## 0.1.3 - 2026-08-21

### Added

- The Worker UI now registers as a **MQTT Worker** section inside DSH settings, built on `ctx.slots` and the shipped UI primitives, so it follows the shell's language and theme and no longer requires a second browser tab.
- Server-Sent Events on `GET /api/stream` push status, event, and result changes as they happen. Clients fall back to polling when the stream cannot be held open.
- A task history view listing recent requests with status and failure reason, backed by the existing `GET /api/requests` endpoint.
- Descriptions and form groups for every configuration field, so the DSH plugin configuration page renders labelled, grouped controls instead of bare field names.
- A `CI` workflow running `pnpm check` on pull requests and pushes.

### Changed

- The standalone management page was rebuilt on the same core and components as the DSH panel, replacing the handed-over React scaffold.
- Cross-origin requests from loopback origins are accepted by default, which is what the DSH panel needs. `managementCorsOrigin` still names a single exact origin when one is required.
- `gateway_version` is read from `package.json` instead of a hand-maintained constant.
- Targets DeepSeek Harness `0.1.0-rc.8`.

### Fixed

- Every pending controller can be approved or rejected, not only the first one in the list.
- A failing endpoint no longer blanks the whole panel; each section reports its own error and the rest keeps rendering.
- An unauthorized response stops the refresh loop and asks for a token instead of retrying indefinitely.
- Clipboard failures are reported instead of silently doing nothing, and an invitation whose broker details could not be read is withheld rather than copied half-written.
- Toast timers are cleared on unmount, and dialogs trap focus, close on Escape, and restore focus on close.

## 0.1.2 - 2026-08-18

### Fixed

- Rebuild the packaged management UI from the pinned, release-age-verified icon dependency so local and clean-environment bundles are reproducible.
- Allow the tag release workflow to resume safely when the matching npm version was already published before a retry.

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
