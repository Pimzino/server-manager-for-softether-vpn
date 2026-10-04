# Operating SoftEther Manager (legacy web edition)

> This page is about the **legacy web edition** (`apps/server` + `apps/web`), which is kept in the repository for
> reference only. The current product is the desktop app in `apps/desktop`: see the root `README.md` and
> `docs/desktop-packaging.md`.

## Install (Linux, systemd)

```bash
sudo useradd --system --home /var/lib/softether-manager --shell /usr/sbin/nologin semanager
sudo mkdir -p /opt/softether-manager /var/lib/softether-manager /etc/softether-manager
sudo chown semanager: /var/lib/softether-manager
# copy the repository to /opt/softether-manager, then:
cd /opt/softether-manager && pnpm install --frozen-lockfile && pnpm run build
sudo apt install wixl msitools          # MSI builder (Debian/Ubuntu)
sudo cp deploy/env.example /etc/softether-manager/env && sudo chmod 600 /etc/softether-manager/env
sudo cp deploy/softether-manager.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now softether-manager
journalctl -u softether-manager -f      # first start: note the setup token (also in /var/lib/softether-manager/setup-token.txt)
```

Docker: `docker build -t softether-manager .` then
`docker run -d -p 8443:8443 -v sem-data:/data -e SEM_MASTER_KEY=$(openssl rand -hex 32) softether-manager`.

Then open the UI and complete **first-run setup** with that token to create the first administrator.
Setup closes permanently afterwards. No administrator is ever created automatically. Break-glass recovery of an **existing** admin from a shell:
`sudo -u semanager env $(cat /etc/softether-manager/env | xargs) node /opt/softether-manager/apps/server/src/cli.ts reset-admin <username>`.

## TLS

* By default the UI is served over HTTPS with a generated self-signed certificate (`data/ui-cert.pem`).
  For production, set `SEM_TLS_CERT` and `SEM_TLS_KEY` to your certificate chain and key.
* Behind a reverse proxy (nginx, Traefik, an F5/ALB), set `SEM_HTTP=1` and set `SEM_TRUST_PROXY` to the proxies'
  addresses/CIDRs (`1` = a proxy on the same host), and terminate TLS at the proxy. Only listed proxies'
  `X-Forwarded-For` is honoured, so clients cannot spoof their IP past the rate limiter. Session cookies stay `Secure`.

## Data and backups of the manager itself

Everything lives in `SEM_DATA_DIR`:

| Path | Content |
|---|---|
| `sem.db` (+ `-wal`, `-shm`) | SQLite: users, grants, server inventory, audit log, SoftEther config backups, profiles, build metadata |
| `master.key` | AES-256-GCM key sealing stored secrets (absent when `SEM_MASTER_KEY` is used) |
| `files/packages/<id>/` | extracted client payloads |
| `files/installers/` | built MSI files |
| `ui-cert.pem`, `ui-key.pem` | generated UI certificate |

Back up the directory with the service stopped, or run `sqlite3 sem.db ".backup sem-backup.db"` online.
**The master key is required to decrypt stored SoftEther credentials.** Keep it (or `SEM_MASTER_KEY`)
in your secrets manager, separate from database backups.

## SoftEther servers

* The JSON-RPC API must be enabled (`DisableJsonRpcWebApi false` in `vpn_server.config`, the default).
* Any listener port works. Prefer a management-only listener that your firewall allows only from the manager host.
* Use server-admin mode for full control, or hub-admin mode (hub name plus hub password) for delegated hubs.
* Certificate pinning: when a server certificate is replaced (for example by *Certificate & TLS → Regenerate*), the
  manager offers to re-pin. Otherwise use *Servers → Edit → Re-pin certificate* after checking the
  fingerprint out of band.
* SoftEther's brute-force protection may briefly block the manager's IP after repeated wrong passwords.

## Monitoring

* `GET /healthz` is the liveness endpoint.
* `GET /metrics` returns Prometheus metrics (per-server up, latency, sessions, hubs, users, traffic,
  per-hub sessions and online state). Authenticate with an API token:

  ```yaml
  scrape_configs:
    - job_name: softether
      scheme: https
      tls_config: { insecure_skip_verify: true }   # or your CA
      authorization: { type: Bearer, credentials: "sem_..." }
      static_configs: [{ targets: ["manager.example.com:8443"] }]
  ```
* Alerts: *Settings → Alerts* posts JSON (`{text, event, server, error, at}`) to a webhook when a server
  becomes unreachable or recovers. The `text` field works directly with Slack and Teams incoming webhooks.
  Every transition is also audited (`server.down` / `server.up`).

## Access model

| Global role | Can |
|---|---|
| admin | everything, including users, settings, danger-class RPCs (config restore, certificates, server password, delete hub, reboot) and secrets |
| operator | all configuration changes that are not danger-class; build installers and profiles |
| viewer | read-only; never receives password hashes, PSKs or private keys |
| none | only what grants allow |

Grants add roles on one server or on one hub of a server. A user with global role `none` and an
`operator` grant on `server X / hub SALES` is a delegated hub administrator. They see only that hub.

## Audit

Every state-changing action is recorded: RPCs, sign-ins, user and grant changes, backups, profile downloads,
MSI builds and downloads, and server up/down. Denied attempts are recorded too, and secrets are redacted.
Retention is `SEM_AUDIT_RETENTION_DAYS` (default 365). You can export CSV from *Audit log*.

## Upgrading

Stop the service, replace the code, `pnpm install --frozen-lockfile && pnpm run build`, start. Database migrations run automatically
at startup.
