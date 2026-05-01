#!/usr/bin/env bash
# One-shot bootstrap for Terraform remote state on Hetzner Object Storage.
#
# Run this ONCE per Hetzner project, before the first `terraform init`. It
# creates the bucket that holds tfstate and prints the access keys you need
# in CI.
#
# Required env:
#   HCLOUD_TOKEN              project-scoped Hetzner Cloud API token
#   HCLOUD_OS_ACCESS_KEY      Object Storage access key (root credentials)
#   HCLOUD_OS_SECRET_KEY      Object Storage secret key
#   HCLOUD_OS_ENDPOINT        e.g. https://fsn1.your-objectstorage.com
#   BUCKET                    bucket name (default: epplaa-tfstate)

set -euo pipefail

BUCKET="${BUCKET:-epplaa-tfstate}"
ENDPOINT="${HCLOUD_OS_ENDPOINT:?must be set}"

if ! command -v aws >/dev/null; then
  echo "aws CLI required (Hetzner Object Storage uses S3 API)" >&2
  exit 1
fi

export AWS_ACCESS_KEY_ID="${HCLOUD_OS_ACCESS_KEY:?}"
export AWS_SECRET_ACCESS_KEY="${HCLOUD_OS_SECRET_KEY:?}"

aws --endpoint-url "${ENDPOINT}" s3api create-bucket --bucket "${BUCKET}" || true
aws --endpoint-url "${ENDPOINT}" s3api put-bucket-versioning \
  --bucket "${BUCKET}" \
  --versioning-configuration Status=Enabled

echo "Bucket ${BUCKET} ready at ${ENDPOINT}"
echo "Add to CI secrets:"
echo "  AWS_ACCESS_KEY_ID=${HCLOUD_OS_ACCESS_KEY}"
echo "  AWS_SECRET_ACCESS_KEY=<rotated>"
