# WebLens Windows-native production

This deployment preserves local Docker Compose but runs production as five
Windows services. PostgreSQL runs on the VPS; ClickHouse Cloud and Cloudflare
R2 remain external.

The release layout is `C:\WebLens\releases\<commit>`, with `C:\WebLens\current`
pointing to the active release. Secrets live only in
`C:\ProgramData\WebLens\weblens.env`; grant read access only to the service
virtual accounts, Administrators, and SYSTEM. `WebLensPostgres` is a dedicated
PostgreSQL 17 service listening on `127.0.0.1:5433`. The backend, crawler, and
capture worker use separate databases and login roles, and each Windows service
depends on `WebLensPostgres` for reboot ordering. Keep the database port bound to
loopback; do not open it in the VPS firewall.

Production database URLs must use `127.0.0.1:5433` with TLS disabled because the
traffic never leaves the host. Keep a bounded connect timeout on every client;
the backend also uses a socket timeout and TCP keepalive. Logical backups belong
under `C:\ProgramData\WebLens\backups` with access limited to Administrators and
SYSTEM. Before a PostgreSQL major upgrade, take and validate a custom-format dump
of all three databases.
The Capture Worker uses pinned Camoufox by default; its Windows binary is
checksum-verified and included in each release. Chromium is retained and can
be selected explicitly with `CAPTURE_BROWSER_ENGINE=playwright`.

Headless Camoufox disables the Gamepad API on Windows. On the production Server
2019 host, calling `navigator.getGamepads()` from a service reproducibly terminated
both Chromium and Camoufox with exit code `0xe0464645`; the same Camoufox fixture
survived with `dom.gamepad.enabled=false`. Mouse, keyboard, screenshots and proxy
guards remain enabled. Keep production on `CAPTURE_BROWSER_ENGINE=camoufox` with
this fix: the Chromium override does not receive the Firefox preference and is
not a remedy for this service-host crash. The Windows release smoke test probes
gamepad access and verifies that the browser still accepts login input.

Install and start `WebLensPostgres` before running `bootstrap.ps1`. Run
`bootstrap.ps1` once after the first release junction exists. It registers
`WebLensDeployPoll`, which checks the public GitHub deployment release every five
minutes, verifies its SHA-256, and calls `deploy.ps1`. The script runs only the
crawler PostgreSQL migration, health-checks all services, and returns to the
previous junction on failure. `/release.json` reports the active commit for CI.
The deploy script also stops any orphaned WebLens Backend Java process before
starting the replacement, so an old process cannot keep port 8080 occupied.

Caddy serves `jobnext.top` and `www.jobnext.top` on port 443 with a publicly
trusted certificate. Direct IP and loopback access keep an internal certificate
for deployment health checks. Port 80 remains owned by the existing application,
so WebLens does not install HTTP-to-HTTPS redirects.
