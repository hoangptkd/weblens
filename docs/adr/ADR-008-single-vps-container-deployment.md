# Single-VPS container deployment and CI/CD

Status: Accepted
Date: 2026-09-20

## Context

WebLens has four deployable artifacts and five stateful stores but no repeatable
production deployment. Building source directly on a server would make releases
non-reproducible and complicate rollback. The current product stage does not
justify Kubernetes, Kafka, Redis, or a multi-node control plane.

## Options considered

1. Build and run source directly on the VPS.
2. Publish immutable containers and deploy them with Docker Compose on one VPS.
3. Introduce Kubernetes and managed messaging before measured demand exists.

## Decision

GitHub Actions verifies all modules, builds four Linux/amd64 images, and publishes
them to GHCR with the Git commit SHA as the only release tag. A protected
`production` GitHub environment deploys one release at a time over SSH.

The VPS runs Docker Compose. Caddy is the only public entry point and terminates
TLS. Application and datastore ports stay on private Docker networks. PostgreSQL,
ClickHouse, MinIO, and Caddy state use named volumes. The crawler runs migrations
as a one-shot job before its runtime container starts. A failed healthcheck
restores the previous image set.

ADR-009 supersedes the MinIO-specific production decision: production artifacts
now use managed S3-compatible object storage, while MinIO remains local-only.

## Consequences

- Releases are reproducible and traceable to one commit.
- The deployment has a short restart window and is not highly available.
- Automatic image rollback cannot undo a forward database migration; migrations
  must remain backward compatible with the previous application release.
- The VPS remains a single failure domain. Encrypted off-host backups and restore
  drills are operational prerequisites, not provided by local Docker volumes.
- Runtime capacity values are conservative defaults and must be benchmarked on
  the selected VPS before publishing an SLO.

## When to revisit

Revisit when measured load requires horizontal scaling, when recovery objectives
cannot be met by a single VPS, or when the approved roadmap introduces Kafka,
Redis, managed databases, or Kubernetes through a separate ADR.
