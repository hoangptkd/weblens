# WebLens production on one VPS

This directory is the production baseline accepted in ADR-008. It targets an
Ubuntu Linux amd64 VPS with Docker Engine and the Compose plugin. It does not add
Kafka, Redis, or Kubernetes.

## 1. Prepare DNS and the VPS

Point the public domain's `A`/`AAAA` record at the VPS. Install Docker from the
official Docker Engine repository, create a dedicated deployment user, and let
that user own `/opt/weblens`:

```bash
sudo install -d -m 0750 -o deploy -g deploy /opt/weblens
sudo usermod -aG docker deploy
```

Allow only the SSH port plus TCP `80`, TCP `443`, and UDP `443` through the VPS
firewall. Do not open datastore or internal application ports.

Copy `.env.example` to `/opt/weblens/.env`, replace every placeholder, then set
mode `0600`. Generate URL-safe database passwords and service tokens with
`openssl rand -hex 32`; generate the JWT key with `openssl rand -base64 32`.

## 2. Prepare Cloudflare R2

Production stores Capture Worker artifacts in a private R2 Standard bucket;
MinIO remains local-development infrastructure only.

1. In Cloudflare, open **Storage & databases → R2** and create the private bucket
   named by `S3_CAPTURE_BUCKET`. Keep public access and `r2.dev` disabled.
2. Create an R2 API token with **Object Read & Write**, restricted to that bucket.
3. Put the S3 endpoint, Access Key ID and Secret Access Key in `/opt/weblens/.env`
   as `S3_ENDPOINT`, `S3_ACCESS_KEY` and `S3_SECRET_KEY`; use `S3_REGION=auto`.
4. Add an object lifecycle rule for prefix `site-clone-staging/` that deletes
   objects after one day. Published artifact retention remains controlled by the
   WebLens database-backed garbage collector.

The bucket must exist before deployment. Never commit or add R2 credentials to
GitHub Actions; only the Capture Worker on the VPS needs them.

## 3. Configure GitHub

Create a GitHub environment named `production`. Restrict it to `main`; add a
required reviewer if the repository plan supports it.

Add environment variable:

- `WEBLENS_PUBLIC_URL`: for example `https://weblens.example.com`

Add environment secrets:

- `VPS_HOST`, `VPS_PORT`, `VPS_USER`
- `VPS_SSH_PRIVATE_KEY`: private key dedicated to deployment
- `VPS_HOST_KEY`: the verified full `known_hosts` line for the VPS
- `GHCR_USERNAME`
- `GHCR_READ_TOKEN`: fine-grained/read-only package credential for the VPS

The workflow publishes with GitHub's short-lived `GITHUB_TOKEN`; no registry
write token is stored on the VPS.

## 4. First deployment

Push the reviewed changes to `main`. `.github/workflows/ci-deploy.yml` runs all
checks, publishes the four images, copies the production Compose files, and runs
`/opt/weblens/deploy.sh`. Caddy requests the TLS certificate after DNS resolves.

Inspect the result without printing secrets:

```bash
cd /opt/weblens
docker compose --env-file .env --env-file .release.env -f compose.yml ps
docker compose --env-file .env --env-file .release.env -f compose.yml logs --tail=100
```

## Operations and limits

- A failed deployment automatically restores `.release.env.previous`.
- Database migrations are forward-only; every migration must stay compatible
  with the previous image release.
- Named volumes are not backups. Configure encrypted off-host backups for all
  three PostgreSQL databases and ClickHouse, then test restoration before storing
  production data. R2 is off-host object storage but retention deletion is not a
  backup; use versioning or a separate backup policy if recovery from deletion is
  required later.
- The current workflow builds `linux/amd64`. Add a reviewed multi-architecture
  build only if the selected VPS is ARM64.
- Tune scan and capture concurrency only after measuring CPU, memory, disk IOPS,
  database connections, queue age, and crawl latency on the actual VPS.
