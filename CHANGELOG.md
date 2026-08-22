# Changelog

All notable changes to this project are documented in this file.

## 0.1.6 - 2026-08-22

### Added

- The management API refuses a request that arrived under a hostname it does not answer to. Without a token the API trusts the loopback interface, and a page whose own domain resolves to `127.0.0.1` is same-origin with it after the rebind; the `Host` header is the one part of that setup the attacker cannot forge, so a non-loopback one now answers 421. Deployments that set a management token are unaffected.
- The web UI trades its token for a stream ticket instead of settling for polling. A token-protected gateway had the ticket endpoint available and never used it, so its panel refreshed every fifteen seconds; the stream now redials with a fresh ticket when it drops, because a spent one would be replayed forever by the browser's own retry.
- The token prompt says whether the token it has was refused or was never supplied — two situations that had one message between them.
- Closing the invitation dialog on a config nobody copied asks first. The token is shown exactly once, so a stray Escape used to cost a controller that had to be issued again.

### Changed

- A controller's last-use timestamp is recorded at a resolution of a minute. Authenticating is a read in every practical sense, yet it rewrote and fsynced the whole state file once per MQTT message; a mutation that changes nothing now skips the disk entirely.
- Controllers are listed newest invite first. Ordering by last update meant a working controller climbed the list on every message and shuffled the rows under the operator's cursor.
- Buttons show progress on the control that was pressed, rather than greying out every button on the page.
- Workspace readiness reads for the count at hand: "no workspaces configured" instead of "0 of 0 workspaces ready", and a singular line for a single workspace.
- `session_id` together with `workspace` is rejected instead of silently ignoring the alias. A resumed session keeps the directory it was created with, so accepting both reported work as having run somewhere it never did.

### Fixed

- The request ledger is capped at 5 000 records. Deduplication TTL alone did not bound it — a busy worker accumulated a week of terminal records, each one rewritten on every mutation — so the least recently updated terminal records are now evicted once the cap is reached.
- Closing the state store is final. A late mutation could rewrite a file the gateway had already stopped reconciling with the broker.
- Shutdown waits for the per-session queues to drain before closing the transport, so the last events of a cancelled request still reach the broker.
- Label/value grids are marked up as description lists. `<dt>` and `<dd>` outside a `<dl>` are invalid, and a screen reader had no pairing to announce.
- Truncated titles and field values carry the full text as a tooltip, instead of ending at an ellipsis with no way to read the rest.
- The unreachable `starting` node state is gone from the protocol, both READMEs, and the UI. It could never appear on the wire, and a controller matching on it was writing dead code.

## 0.1.5 - 2026-08-21

### Added

- The task history can stop a running task. Cancellation goes through the same queue as an MQTT `request.cancel`, so an operator and a controller cannot race, and a controller watching the request sees an operator's cancel exactly as it would see its own.
- `GET /api/stream` accepts a single-use ticket from `POST /api/stream/tickets`. `EventSource` cannot send an `Authorization` header, so a token-protected gateway previously fell back to polling; the ticket expires in 15 seconds and is spent on first use, while the bearer token stays in a header for clients that can send one.
- A failure reason on the history row itself, rather than only inside the task dialog.
- The task dialog reports how long a request ran, which workspace it used, and which controller submitted it.
- Approve is available in the invitation dialog, so issuing an invite and granting it are one step for the operator doing both.
- The node's Last Will payload now carries the same field set as a live status, so a controller can decode both with one parser.

### Changed

- Pushed updates are applied where they land instead of triggering a reload. Every output chunk used to cost four requests; a status now applies verbatim and a result folds into its row, leaving reloads for what an update cannot answer on its own.
- Pending controllers are named above their rows. The section count covers approved controllers only, so the rows above it read as a contradiction.
- Gateway work is serialized per session instead of on one global queue. QoS 1 publishes are awaits, so a slow acknowledgement for one session was holding up every other session's events.
- `requireControllerAuth` left off means broker credentials alone are enough to run agent work on a node. The default is unchanged, but the gateway now warns at startup, and the schema, the connection dialog, and both READMEs say so plainly.
- `maxInputChars` above `maxMessageBytes` is rejected at startup. A character costs at least a byte and the size check runs first, so such a configuration described a limit that could never apply.
- `GET /api/requests` returns rows projected for the UI. The stored record also holds the request fingerprint and the control-dedup table, neither of which a client needs.
- `?limit` on `GET /api/requests` is clamped to the server's page size instead of being honoured as given.
- Health rows are labelled and translated in the UI instead of showing protocol identifiers, and the workspace count reads ready-over-total so "2" cannot be mistaken for "all of them".
- Unexpected server errors answer a generic message and log the detail, instead of returning text that could describe the filesystem or the broker.
- The state file is flushed before its rename and written compactly.

### Fixed

- A broker error after a successful connect no longer takes the host down. `mqtt.js` reconnects on its own, but an unhandled `error` event threw; `MqttControllerClient` now keeps a permanent listener and exposes `onError`.
- A request whose agent session went idle without ever running is no longer reported as completed — a resumed session is idle by definition. One that failed before running is still finalized, so it cannot hold a capacity slot indefinitely.
- A turn-end kind the gateway does not know falls back to `TURN_FAILED` instead of inventing an error code no controller can handle.
- A control command that was rejected or failed to deliver releases its command id, so the controller can retry it instead of finding the id permanently consumed.
- The controller client's cache of unclaimed results is bounded, and the session ledger is capped and evicts least-recently-seen.
- Revoked controllers past their expiry are pruned from the state file.
- A management client that stops reading the SSE stream no longer grows the server's write buffer without bound.

## 0.1.4 - 2026-08-21

### Changed

- Releases publish through npm trusted publishing (OIDC) instead of a stored `NPM_TOKEN`. npm caps write tokens at 90 days, so the old arrangement needed rotating every quarter; a short-lived, job-scoped credential removes the secret entirely and signs each release with a provenance attestation.

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
