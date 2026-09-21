# Windows-native VPS deployment with managed data stores

Status: Accepted
Date: 2026-09-22
Supersedes: the production runtime and self-hosted PostgreSQL decisions in ADR-004 and ADR-008

## Context

The selected Windows Server 2019 VPS cannot run WSL2 or nested virtualization,
already serves another application on port 80, and has limited memory and disk.
WebLens must preserve its three approved application deployables while keeping
Docker Compose available for local development.

## Decision

Production runs native Windows processes managed as Windows services:

- Java 21 Spring Boot Control Plane on `127.0.0.1:8080`;
- Go Crawler on `127.0.0.1:8081`;
- Node.js/Playwright Capture Worker on `127.0.0.1:8082`;
- Caddy on public port 443, serving the static frontend and proxying `/api`.

Neon hosts the three service-owned PostgreSQL databases, ClickHouse Cloud hosts
the two analytical databases, and Cloudflare R2 stores large artifacts. Local
Docker Compose remains unchanged and continues to provide PostgreSQL,
ClickHouse, and MinIO for development.

GitHub Actions builds a commit-addressed Windows ZIP. The VPS expands it under
`C:\WebLens\releases`, switches a `current` junction, runs PostgreSQL migrations,
starts services, and rolls the junction back on failed health checks. Only the
current and previous releases are retained. Cloud DDL is not run by restricted
runtime accounts.

Until a public domain is supplied, Caddy uses its internal CA on port 443 and
does not redirect port 80. This avoids disrupting the existing application.

## Consequences

- Docker is not required on the production VPS.
- Runtime credentials stay in an ACL-protected file outside releases and Git.
- One Capture Worker and one site-clone worker protect the 7 GB VPS from
  Chromium memory pressure.
- The deployment is single-node and has restart downtime; release rollback does
  not reverse database migrations.
- A trusted public certificate requires a domain and a later Caddy configuration
  update.

## When to revisit

Revisit after a domain is available, measured load requires more workers, or a
Linux/container host becomes available. Kafka, Redis, and Kubernetes still
require separate evidence and an ADR.
