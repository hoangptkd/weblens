#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: deploy.sh <image-registry> <40-character-git-sha>" >&2
  exit 2
fi

registry=$1
tag=$2
case "$registry" in
  ghcr.io/*) ;;
  *) echo "image registry must be under ghcr.io" >&2; exit 2 ;;
esac
case "$tag" in
  *[!0-9a-f]*|'') echo "image tag must be a lowercase Git commit SHA" >&2; exit 2 ;;
esac
if [ "${#tag}" -ne 40 ]; then
  echo "image tag must contain exactly 40 characters" >&2
  exit 2
fi

cd "$(dirname "$0")"
test -f .env || { echo "/opt/weblens/.env is missing" >&2; exit 1; }

exec 9>.deploy.lock
flock -n 9 || { echo "another deployment is running" >&2; exit 1; }

umask 077
if [ -f .release.env ]; then
  cp .release.env .release.env.previous
fi
printf 'WEBLENS_IMAGE_REGISTRY=%s\nWEBLENS_IMAGE_TAG=%s\n' "$registry" "$tag" > .release.env.next
mv .release.env.next .release.env

compose() {
  docker compose --env-file .env --env-file .release.env -f compose.yml "$@"
}

rollback() {
  echo "deployment failed; restoring the previous release" >&2
  if [ -f .release.env.previous ]; then
    cp .release.env.previous .release.env
    compose up -d --remove-orphans --wait --wait-timeout 300 || true
  fi
  exit 1
}

compose config -q || rollback
compose pull || rollback
compose up -d --remove-orphans --wait --wait-timeout 300 || rollback
compose ps
