# WebLens Windows-native production

This deployment preserves local Docker Compose but runs production as four
Windows services. Neon, ClickHouse Cloud, and Cloudflare R2 remain external.

The release layout is `C:\WebLens\releases\<commit>`, with `C:\WebLens\current`
pointing to the active release. Secrets live only in
`C:\ProgramData\WebLens\weblens.env`; grant read access only to the four service
virtual accounts, Administrators, and SYSTEM.
When Neon supplies a pooled `DB_URL`, configure `SPRING_FLYWAY_URL` with the
matching direct (non-`-pooler`) JDBC endpoint and set `SPRING_FLYWAY_USER` and
`SPRING_FLYWAY_PASSWORD` to the database credentials. Flyway's PostgreSQL
advisory lock needs one database session; the runtime datasource can remain pooled.
The Capture Worker uses pinned Camoufox by default; its Windows binary is
checksum-verified and included in each release. Chromium is retained and can
be selected explicitly with `CAPTURE_BROWSER_ENGINE=playwright`.

Run `bootstrap.ps1` once after the first release junction exists. It registers
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
