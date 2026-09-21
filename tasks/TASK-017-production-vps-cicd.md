# Task: Production VPS deployment and CI/CD

## Goal

Deploy WebLens reproducibly to one VPS and redeploy automatically after a
successful push to `main`.

## Why

The repository had a local infrastructure Compose file but no immutable images,
TLS entry point, deployment gate, rollback, or production pipeline.

## Requirements

- Verify backend, crawler, capture worker, and frontend before publishing.
- Publish commit-addressed images to GHCR.
- Expose only HTTP/HTTPS publicly and use automatic TLS.
- Keep datastores and internal service endpoints off public host ports.
- Serialize deployments and restore the previous image set on failed healthchecks.
- Keep secrets outside Git and do not add speculative Kafka or Redis services.

## API contract

No public API contract changes. Browser traffic continues to use same-origin
`/api`; Caddy forwards that path to the Control Plane.

## Data changes

No schema change. Existing service-owned migrations still apply. The crawler uses
a one-shot migration command before its runtime starts.

## Edge cases

- Concurrent pushes to `main`.
- An image cannot be pulled.
- A service fails its startup healthcheck.
- The previous release exists but a forward migration is not backward compatible.
- DNS or ACME validation is unavailable during first deployment.

## Security considerations

- Pin GitHub Actions to immutable commit SHAs.
- Use a read-only GHCR token on the VPS and a dedicated SSH deployment key.
- Verify and pin the VPS SSH host key.
- Store production secrets only in `/opt/weblens/.env` with mode `0600`.
- Do not publish database, ClickHouse, crawler, worker, or backend ports. Production
  object storage is the private cloud bucket approved in ADR-009.

## Concurrency / consistency considerations

GitHub environment concurrency and a VPS file lock allow one deployment at a
time. Durable databases live in named volumes and are not recreated with images.
Database migrations must use expand/contract rules because image rollback does
not roll back data.

## Implementation plan

1. Add production Dockerfiles and healthchecks.
2. Add the production Compose topology and immutable release file.
3. Add CI verification, GHCR publishing, SSH deployment, and rollback.
4. Document initial VPS and GitHub environment configuration.
5. Build images and validate Compose configuration locally.

## Tests

- Existing module test/build commands.
- `docker compose config` with non-secret test values.
- Build all four production images.
- Validate shell scripts and UTF-8 encoding.

## Definition of Done

A push to `main` that passes all checks publishes four images and activates their
shared commit SHA on a configured VPS. Failed healthchecks leave the previous
release active.

## What I should understand before accepting this implementation

This is a production-oriented single-node baseline, not high availability.
Off-host backups, restore testing, monitoring, and measured capacity remain
operator responsibilities.
