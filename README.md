# AICDK

A self-service redemption portal built with Go / Gin, React, TypeScript, and Vite. The production frontend is bundled into a single Go binary using `embed.FS`; no Node.js runtime, external database, or separate static file server is required.

Built for CDK Partner API v1.0.1. All business API requests pass through the Go backend. The browser never receives upstream passwords or calls upstream services directly.

Gin handles routing and HTTP middleware; the existing `http.Server` retains request timeouts and graceful shutdown. The server defaults to Gin's release mode unless `GIN_MODE` is set. Automatic route redirects are disabled, and API errors remain JSON rather than falling back to the React app.

## Features

- Single-code redemption: validate the code, preflight the account, explicitly confirm, submit, and track the result.
- Batch redemption: parse CSV / XLSX locally, preserve original row numbers, preflight and confirm each row, then submit sequentially. Up to 100 rows per batch, with no silent removal of empty rows and no automatic resubmission.
- Single and batch code lookup, progress recovery using the original code, and ChatGPT billing / subscription lookup.
- Prefix-based routing across upstream systems: longest case-insensitive match, separate credentials, and optional prefix stripping. Redemption tokens remain bound to their original system.
- English (`en`) and Simplified Chinese (`zh-CN`): automatic initial selection from the browser's preferred language, with a persistent manual switch that preserves forms and navigation.
- Configurable client-IP handling: a master switch, individual header switches, trusted proxy CIDRs, and header priority.

The built-in `partner-v1` adapter supports multiple systems **implementing the same protocol**. A different protocol requires an implementation of `internal/partner.Adapter` and configuration dispatch; changing only the URL is not sufficient. There is no admin dashboard, code issuance or sales, balance management, refund processing, or undocumented pricing API.

## Quick Start: GHCR Image

The publication workflow targets `ghcr.io/akinokaede/aicdk`, with `linux/amd64` and `linux/arm64` variants. Images become available after the first successful publishing run in `AkinoKaede/aicdk`.

From a checkout of this repository:

```sh
cp .env.example .env
# Edit .env and set CDK_PARTNER_PASSWORD.
# For production, also set PUBLIC_ORIGIN=https://your-domain.example.
docker compose -f compose.ghcr.yaml pull
docker compose -f compose.ghcr.yaml up -d
```

Open `http://127.0.0.1:8080`. The published port binds to host loopback by default. Put an HTTPS reverse proxy in front of the application for public access. `deploy/nginx.conf.example` can be included in an existing TLS server block.

```sh
docker compose -f compose.ghcr.yaml logs -f --tail=100
docker compose -f compose.ghcr.yaml exec cdk /app/cdk healthcheck
```

`compose.ghcr.yaml` has no build configuration and defaults to `ghcr.io/akinokaede/aicdk:latest`. To use a published release, set `CDK_IMAGE` in `.env`, for example:

```dotenv
CDK_IMAGE=ghcr.io/akinokaede/aicdk:1.0.0
```

Only use a version that has actually been published. For reproducible deployments, set `CDK_IMAGE` to the full `ghcr.io/akinokaede/aicdk@sha256:...` reference shown in the publishing run's summary. `latest` follows the default branch, not the most recent release tag.

To update, run `pull` and `up -d` again. Keep the same Compose project name and directory so the existing data volume is reused. Never use `down -v` as part of an update.

For a private GHCR package, authenticate before pulling:

```sh
# GHCR_TOKEN must be a personal access token (classic) with read:packages.
# GHCR_USER must be the username that owns the token.
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
```

New GHCR packages are private by default. After the first publish, set the package visibility to public if anonymous pulls are intended. Repository visibility alone does not make the package public.

### Build Locally Instead

```sh
cp .env.example .env
# Set the runtime password and production origin in .env.
docker compose up -d --build
```

`compose.yaml` builds the local image; `compose.ghcr.yaml` pulls the published image. Use either as the base Compose file, not both together. Both use the same service and named-volume keys.

### Runtime and Data

- Multi-stage image: Node 24 builds the UI, Go 1.27 builds a static binary, and `scratch` provides the final runtime.
- Build stages run on the builder's native platform; Go cross-compiles the final binary for each target architecture without requiring QEMU.
- Runs as non-root UID/GID `65532`. Both Compose files use a read-only root filesystem and drop all Linux capabilities.
- The `cdk-data:/data` volume stores the cookie-signing key, hashed routing records, preflight proofs, and replay-protection records.
- **Do not delete the data volume.** Doing so loses stable device sessions and duplicate-submission protection. For backups, stop the instance and copy `/data/cdk.db`; preserve ownership and permissions on restore.
- bbolt is a **single-instance** storage model. Do not run multiple instances against the same database file. Multi-replica deployments require shared transactional storage.
- `/healthz` checks local liveness only. It does not verify upstream availability or credentials.
- Shutdown waits up to 165 seconds for in-flight requests. Compose allows a 170-second stop grace period.
- Without Docker, run `make build` and deploy `bin/cdk` with its runtime environment configuration.

Passwords are read only from runtime environment variables. Never put them in `VITE_*` variables, Docker build arguments, image layers, or configuration JSON. `.env`, `config.json`, and the data directory are excluded from version control; examples contain no real credentials.

## GitHub Actions and GHCR Publishing

`.github/workflows/ci.yml` tests the application before publishing. The test job runs on branch pushes, `v*` tag pushes, pull requests, and manual dispatches. It runs frontend tests and the Vite production build, Go race tests and vet, and a container health smoke test. The smoke test uses a random dummy password, an unreachable loopback upstream, and no external network.

To download a standalone build, open **Actions > Test, build and publish**, select the run for your commit, and download `aicdk-linux-<commit-sha>` under **Artifacts**. Unzip it, run `sha256sum -c SHA256SUMS`, then extract the `aicdk-linux-amd64.tar.gz` or `aicdk-linux-arm64.tar.gz` archive for your server. Each contains the executable `cdk` with the frontend embedded; supply the same runtime environment variables as for Docker.

Publishing requires the test job to succeed. The image name is derived from the lowercase repository name, so `AkinoKaede/aicdk` produces `ghcr.io/akinokaede/aicdk`; forks publish under their own repository names.

| Event | Published tags |
| --- | --- |
| Push to the repository's default branch | `latest`, `sha-<full-commit-sha>` |
| Push a semantic version tag such as `v1.0.0` | `1.0.0`, `sha-<full-commit-sha>` |
| Push a prerelease tag such as `v1.1.0-rc.1` | `1.1.0-rc.1`, `sha-<full-commit-sha>`; never `latest` |
| Manual run on the default branch or a `v*` tag | Same policy as the corresponding ref |
| Pull request or another branch | Tests and downloadable binaries; no registry login or image publishing |

The workflow uses the built-in `GITHUB_TOKEN` with `packages: write` only in the publishing job. No custom registry secret or upstream password is needed in GitHub Actions. Ensure repository / organization policies permit package publishing; if the GHCR package already exists, grant this repository Actions access to it.

Published images include both supported architectures, OCI metadata, BuildKit provenance, and an SBOM. The run summary records image tags and the manifest digest. Build layers are cached with the GitHub Actions cache backend. Actions are pinned to full commit SHAs, with weekly Dependabot checks for updates.

After the repository and workflow have been pushed to GitHub, publishing a version can be triggered with:

```sh
git tag v1.0.0
git push origin v1.0.0
```

Choose a new version for each release; do not move existing release tags. For a manual default-branch build, select **Actions > Test, build and publish > Run workflow**. Publishing a release tag does not move `latest`.

## Multiple Systems and Prefix Routing

```sh
cp config.multi.example.json config.json
# Set the real HTTPS origin, prefixes, and password_env for each system.
# Set CDK_PARTNER_PASSWORD and SECONDARY_PARTNER_PASSWORD in .env.
docker compose -f compose.ghcr.yaml -f compose.multi.yaml up -d
```

For a local image build, replace `compose.ghcr.yaml` with `compose.yaml` and add `--build`.

`base_url` must be an HTTPS **origin**, such as `https://cdk.bar`, without `/api/partner/v1`. The adapter appends fixed API paths; it is not an open proxy accepting user-provided URLs.

| Field | Purpose |
| --- | --- |
| `id` | Stable system identifier: lowercase letters, digits, `-`, and `_` only |
| `name` | Operator-defined display name; not automatically translated |
| `adapter` | Currently `partner-v1` |
| `base_url` | HTTPS upstream origin |
| `password_env` | Name of the environment variable containing this system's password |
| `prefixes` | Case-insensitive prefix list; longest match wins; duplicates are rejected |
| `strip_prefix` | `false` preserves the full code; `true` removes the matched prefix |
| `default_system` | Top-level fallback when no prefix matches; an empty string rejects unmatched codes |

For example, `ALT-ABC123` matching `ALT-` with `strip_prefix=true` sends `ABC123` upstream. Only strip **routing prefixes added when distributing codes**. Preserve a prefix that is part of the original code.

With both `ALT-` and `ALT-GPT-` configured, `ALT-GPT-123` matches the longer `ALT-GPT-` prefix. An input containing only a prefix, with no remaining code, is rejected.

The backend groups mixed-prefix `lookup-batch` requests by system and merges responses back into the original row order by code identity, without assuming upstream ordering. Session-based billing queries have no code, so the UI provides a system selector. It accepts only preconfigured system IDs, never URLs.

Existing tokens are bound to the original system ID and origin. If that system's origin changes, subsequent token requests are rejected instead of exposing old credentials to a new destination. Change routing only when no redemptions are in progress, and retain old systems until their outstanding operations finish.

## Client-IP Header Controls

Forwarding headers are ignored by default; the application uses the IP from `RemoteAddr`. **All three conditions must hold** before a header is trusted:

1. `TRUST_PROXY_HEADERS=true`.
2. The individual header switch is enabled.
3. The immediate TCP peer belongs to `TRUSTED_PROXY_CIDRS`.

Gin's built-in proxy-header inference is disabled. Rate limiting uses the application's explicit client-IP policy below, not `gin.Context.ClientIP()`, so switching frameworks does not bypass these switches.

```dotenv
TRUST_PROXY_HEADERS=true
TRUST_X_FORWARDED_FOR=true
TRUST_X_REAL_IP=false
TRUST_CF_CONNECTING_IP=false
TRUST_TRUE_CLIENT_IP=false
CLIENT_IP_HEADERS=X-Forwarded-For,X-Real-IP,CF-Connecting-IP,True-Client-IP
TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128
```

| Switch | Default | Meaning |
| --- | --- | --- |
| `TRUST_PROXY_HEADERS` | `false` | Master switch |
| `TRUST_X_FORWARDED_FOR` | `true` | Allow X-Forwarded-For, subject to the master switch and trusted-peer check |
| `TRUST_X_REAL_IP` | `false` | Allow X-Real-IP |
| `TRUST_CF_CONNECTING_IP` | `false` | Allow CF-Connecting-IP |
| `TRUST_TRUE_CLIENT_IP` | `false` | Allow True-Client-IP |

`CLIENT_IP_HEADERS` sets the priority. Disabled headers and headers absent from this list are ignored. A malformed highest-priority available header causes a conservative fallback to the connection IP, rather than trying a lower-priority header. IPv4, IPv6, and IPv4-mapped IPv6 are supported.

`X-Forwarded-For` is traversed right to left, skipping configured trusted proxies and selecting the first untrusted address. It does not blindly use the leftmost entry. Single-value headers accept a plain IP only, not comma-separated lists.

### Nginx

- With a native deployment, the immediate peer is often `127.0.0.1` or `::1`.
- In Docker, it may be the Docker gateway or proxy container. Configure the **actual peer's precise CIDR**, not the loopback example by assumption.
- The proxy must overwrite client-supplied `X-Real-IP` and `X-Forwarded-For`. The example also clears Cloudflare-related headers.
- To use only `X-Real-IP`, set `TRUST_X_REAL_IP=true` and `TRUST_X_FORWARDED_FOR=false`.
- Never use `0.0.0.0/0` or `::/0` as a shortcut. Trusting every peer lets clients forge IPs and bypass per-IP limits.

### Cloudflare

If the application receives connections directly from Cloudflare, trust only Cloudflare's current official egress CIDRs, enable `CF-Connecting-IP`, and place it first in the header list. Restrict direct origin access at the network layer.

For Cloudflare -> Nginx -> application, the immediate peer is Nginx. Prefer validating the client IP in Nginx using trusted Cloudflare CIDRs, then overwriting `X-Real-IP` for the application. Do not blindly pass through spoofable Cloudflare headers just because Nginx is trusted. Operators must keep Cloudflare ranges current; the project does not ship a potentially stale list.

## Local Development

Requires Go 1.26+ and Node.js 24+. The project has been verified locally with Go 1.27 and Node.js 26; Docker and CI use Node.js 24.

```sh
cp .env.example .env
# Set runtime configuration intended for local testing.
set -a
. ./.env
set +a

# Terminal 1
go run ./cmd/server

# Terminal 2: load the environment in this shell too if needed.
cd web
npm ci
npm run dev
```

Vite serves on port 5173; use the exact URL printed in the terminal. `/api` and `/healthz` are proxied to `127.0.0.1:8080`. Leave `PUBLIC_ORIGIN` empty for local development, or set it to the actual Vite origin. In production, set the exact external HTTPS origin to enable Secure cookies, origin checks, and HSTS.

```sh
make build
./bin/cdk

# Run checks independently.
go test -race ./...
go vet ./...
cd web && npm test && npm run build
```

## Redemption Safety Boundaries

- Upstream HTTP Basic passwords are used only in the Go process. Frontend API requests are restricted to same-origin paths.
- A signed `HttpOnly`, `SameSite=Strict` device cookie maintains a stable `X-Redemption-Device` throughout the flow. Persisting the signing key preserves this identity across restarts.
- Session bootstrap issues a device-bound CSRF token. All business POST requests validate the cookie, CSRF token, and Origin / Fetch Metadata.
- Request bodies are limited to 256 KiB and Session credentials to 128 KiB. Strict field allowlists prevent forwarding arbitrary fields. Upstream responses are limited to 2 MiB; redirects, including authentication redirects, are rejected.
- Preflight stops on blocking conditions, subscription-recovery requirements, missing email, or a missing preflight token for non-Grok products. The backend records hashed preflight proofs, so bypassing the UI cannot skip preflight.
- Grok submissions use the original SSO credential; other products use the current preflight token. Proofs bind the current device, redemption token, and credential.
- Before submission, the browser persists a unique `client_request_id`, SHA-256 hashes of the code / redemption token, original row number, and masked information. Raw bearer credentials are not persisted. Submission is blocked if storage is unavailable.
- Before calling the upstream, Go transactionally persists and fsyncs HMAC identifiers for the device, code, token, and request ID. A repeated code for the same device, token, or request ID is not forwarded again.
- This is **conservative single-attempt protection**, not a guarantee of exactly-once payment across upstream systems. A crash after the durable record may occur before dispatch, but the attempt remains locked and must be checked against the original operation. Explicit failures are not automatically unlocked or replayed. The code issuer must verify upstream state before arranging another attempt; this version has no automatic unlock endpoint.
- HTTP 200 / 202 does not mean fulfillment is complete. Only `completed` indicates success. `declined`, `failed_precharge`, `cancelled`, and `failed` are terminal failure states; unknown states remain under observation.
- Lost connections, timeouts, 5xx responses, and `uncertain` never trigger automatic resubmission. Result polling starts at 3-second intervals, backs off on errors, waits 60 seconds on 429, and pauses while the page is hidden. Repeated failures or roughly 200 automatic queries pause polling until manually resumed.
- Request bodies, Sessions, codes, tokens, and authorization headers are not logged. The database stores only necessary hashes and routing metadata. Free-form upstream response text remains untrusted provider-supplied data.
- Gin's default access logger and recovery request dumps are not enabled. Panic recovery logs only the registered route, returns the existing JSON error envelope, and marks interrupted redemption submissions as uncertain without replaying them.
- The UI and database do not persist Sessions, but **credentials are transmitted to the selected upstream**. Upstream retention policies are controlled by that provider.
- Local limits: 300 requests/minute per resolved client IP, 120 requests/minute per device, 30 submissions/minute per device, and at most 64 concurrent business requests. These do not replace a public-facing WAF, edge rate limits, or bot protection.

## Localization

English resources live in `web/src/locales/en.ts`; Chinese source strings are stable translation keys. On first visit, `web/src/i18n.ts` chooses from the browser's preferred language: `zh-*` maps to `zh-CN`, and other languages map to `en`. Manual preference is stored as `cdk-language`.

Dates and numbers use the UI locale. Product names, operator-defined system names, account emails, and codes are not translated. Free-form upstream text that cannot be translated reliably is preserved, with its origin identified in English error messages to avoid misrepresenting business states. Switching languages does not reset page components or submit an operation again.

## Project Structure

```text
.github/workflows/   Tests, container smoke checks, and GHCR publishing
.github/dependabot.yml  Pinned GitHub Actions update checks
cmd/server/          Startup, graceful shutdown, and container health checks
internal/config/     Environment, system configuration, and prefix routing
internal/partner/    Upstream adapters, timeouts, and error normalization
internal/store/      bbolt, signing keys, routing, and submission protection
internal/server/     Gin routes/middleware, API validation, CSRF, IPs, and assets
web/src/             React pages, i18n, imports, submission logic, and tests
web/assets.go        Embedded frontend using embed.FS
deploy/              Nginx configuration example
compose.yaml         Local Docker image build and deployment
compose.ghcr.yaml    Prebuilt GHCR image deployment
compose.multi.yaml   Multi-system configuration overlay
```

Tests use local mocks / `httptest` and never submit real redemptions.
