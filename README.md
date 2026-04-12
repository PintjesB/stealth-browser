# stealth-browser

Reusable Patchright-based stealth browser service with a small HTTP API.

## Endpoints

- `GET /health`
- `POST /scrape`
- `POST /context/clear`

## Security defaults

- Rootless runtime image
- Distroless runtime image
- Chromium sandbox enabled by default
- Publish only from `main` and `v*` tags
- Secret scanning and image scanning in CI

## Environment

- `HOST` default: `0.0.0.0`
- `PORT` default: `7332`
- `CONTEXTS_DIR` default: `$HOME/.stealth-browser/browser-contexts`
- `BROWSER_CHANNEL` default: `chrome`
- `BROWSER_LOCALE` default: `en-US`
- `BROWSER_TIMEZONE` default: `UTC`
- `PATCHRIGHT_NO_SANDBOX` default: disabled
- `CONTEXT_IDLE_TTL_MS` default: `600000`
- `CONTEXT_SWEEP_INTERVAL_MS` default: `60000`
- `BROWSER_WARMUP_ON_START` default: disabled

## Local use

```bash
npm ci
npm run install-browser
./.github/scripts/install_git_hooks.sh
./.github/scripts/run_local_gate.sh
node stealth-server.js
```

Health check:

```bash
curl http://127.0.0.1:7332/health
```

## Container

Build:

```bash
docker build -t stealth-browser:test .
```

Run:

```bash
docker run --rm -p 7332:7332 -e BROWSER_WARMUP_ON_START=1 stealth-browser:test
```

## Verification

```bash
python3 .github/scripts/scan_secrets.py --tree --history
node --check stealth-server.js
npm audit --package-lock-only --omit=dev --audit-level=high
```

## Notes

- `POST /scrape` accepts `url`, optional `actions`, optional `timeout`, and optional `full_html`.
- `POST /context/clear` accepts `domain`.
- Prefer digest-pinned image references in downstream deployments.
- The local git hooks run a fast secret scan on `pre-commit` and the local gate on `pre-push`.
