# Cloud object storage for production artifacts

Status: Accepted
Date: 2026-09-21

## Context

ADR-008 placed MinIO on the same VPS as WebLens. Site-clone archives, page
bundles, screenshots and captured resource bodies can dominate disk and download
bandwidth. Keeping these objects on the application VPS makes its disk a capacity
limit and keeps artifact downloads in the same failure domain.

The Capture Worker already uses the S3 API and stores only object metadata and
integrity hashes in PostgreSQL. Moving production objects does not change service
ownership, database schema or the public API.

## Decision

Production uses one private Cloudflare R2 Standard bucket through its
S3-compatible endpoint. The Capture Worker receives a bucket-scoped Object Read
& Write credential through VPS secrets. The bucket is created out of band and is
not public.

MinIO remains the local-development and integration-test implementation. The
production Compose topology no longer runs MinIO or stores an object-storage
volume on the VPS. A lifecycle rule deletes the `site-clone-staging/` prefix
after one day; the existing database-backed garbage collector remains responsible
for published artifact retention.

## Consequences

- Clone and capture artifact bytes no longer consume VPS disk or MinIO memory.
- The existing AWS S3 SDK, object keys, SHA-256 verification and cleanup flow are
  reused; no new dependency or database migration is introduced.
- Capture and artifact download availability now depends on Cloudflare R2 and VPS
  outbound HTTPS.
- R2 usage above its included allowance is billable. Operators must monitor
  stored GB-month and Class A/B operations.
- The current Control Plane still proxies downloads. R2 removes storage load from
  the VPS, but download bytes still cross the backend until a separately reviewed
  presigned-download design is justified by measurement.

## Security and operations

- Disable public bucket access and `r2.dev`.
- Restrict the token to the single WebLens bucket and rotate it independently.
- Store credentials only in `/opt/weblens/.env` with mode `0600`.
- Do not log credentials, signed headers or object bodies.
- Treat lifecycle deletion as irreversible; it is retention, not backup.

## When to revisit

Revisit when artifact downloads become a measured backend bottleneck, the R2
free allowance is insufficient, regional/data-residency requirements change, or
separate buckets are required for materially different retention policies.
