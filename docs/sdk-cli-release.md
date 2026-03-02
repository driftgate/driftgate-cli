# SDK/CLI Release Hardening

This repo validates SDK/CLI release readiness with deterministic bundle metadata and install smoke checks.

## Contracts

- `@driftgate/contracts`, `@driftgate/workflow-compiler`, `@driftgate/sdk`, and `@driftgate/cli` versions must stay aligned.
- `driftgate-sdk` (Python) must match the same lockstep release version.
- Internal dependencies must be pinned to the aligned version (no `workspace:*` links in release manifests).
- `ops/releases/SDK_CLI_CHANGELOG.md` must include an entry for the active aligned version.
- CLI canonical execution surface is V4-first:
  - `driftgate session start`
  - `driftgate session execute`
  - `driftgate execute`
  - `driftgate execution status|events|wait`

## Commands

- Validate version + changelog contract:
  - `pnpm run check:sdk-cli:release`
- Build publishable package artifacts:
  - `pnpm run build:sdk-cli:packages`
- Build release bundle metadata + package tarballs:
  - `pnpm run release:sdk-cli:bundle -- --out-dir tmp/sdk-cli-release/out`
- Run install-and-execute smoke against packaged artifacts:
  - `pnpm run release:sdk-cli:smoke -- --metadata tmp/sdk-cli-release/out/release-metadata.json`
- Generate public-release manifest:
  - `pnpm run release:public:prepare -- --out-dir tmp/public-release/out`
- Stage public-repo sync payload:
  - `pnpm run release:public:sync`
- Stage sdk-go mirror sync:
  - `pnpm run release:public:go-mirror`

## CI

- `verify-all` includes `sdk-cli-release-hardening` before headless parity checks.
- Manual workflow `sdk-cli-release.yml` builds and uploads bundle metadata artifacts.
- Manual workflows:
  - `public-sdk-cli-ga-release.yml` (end-to-end GA preparation).
  - `publish-npm-sdk-cli.yml` and `publish-python-sdk-public.yml`.
  - `sync-public-repos.yml` and `sync-go-sdk-mirror.yml`.
