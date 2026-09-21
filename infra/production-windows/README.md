# WebLens Windows-native production

This deployment preserves local Docker Compose but runs production as four
Windows services. Neon, ClickHouse Cloud, and Cloudflare R2 remain external.

The release layout is `C:\WebLens\releases\<commit>`, with `C:\WebLens\current`
pointing to the active release. Secrets live only in
`C:\ProgramData\WebLens\weblens.env`; grant read access only to the four service
virtual accounts, Administrators, and SYSTEM.

Run `bootstrap.ps1` once after the first release junction exists. Deploy later
ZIPs with `deploy.ps1 -ReleaseZip <path> -Commit <sha>`. The script verifies all
checksums, runs only the crawler PostgreSQL migration, health-checks all services,
and returns to the previous junction on failure.

Caddy listens on 443 with an internal certificate because the VPS has no WebLens
domain and port 80 belongs to another application. Replace the IP site address
with a domain and remove `tls internal` when public DNS is ready.
