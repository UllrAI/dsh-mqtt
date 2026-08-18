# Changelog

All notable changes to this project are documented in this file.

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
