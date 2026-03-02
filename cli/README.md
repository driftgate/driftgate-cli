# DriftGate CLI

Canonical V4 CLI for DriftGate session and execution workflows.

## Install

```bash
npm i -g @driftgate/cli
```

## Alternatives

```bash
brew tap driftgate/tap && brew install driftgate
docker run --rm ghcr.io/driftgate/cli:0.1.0 --help
```

## Core Commands

```bash
driftgate session start --agent refund-agent
driftgate session execute <sessionId> --input '{"orderId":"123"}'
driftgate execute --agent refund-agent --input '{"orderId":"123"}'
driftgate execution status <executionId>
driftgate execution events <executionId>
driftgate execution wait <executionId> --timeout-ms 15000
```
