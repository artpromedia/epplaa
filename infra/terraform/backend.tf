# Remote state lives on Hetzner Object Storage (S3-compatible). Each
# environment overrides `key` via `terraform init -backend-config=…`.
#
# The bucket is bootstrapped out-of-band by `scripts/bootstrap-tf-backend.sh`
# (run once per account) using the root Hetzner API token. Subsequent
# applies use the scoped token from `HCLOUD_TOKEN`.
#
# State locking is via DynamoDB-style conditional writes on Hetzner Object
# Storage's S3 API. Test before relying on it for prod — fall back to a
# `terraform.lock` file in the bucket if locking is unreliable.

terraform {
  backend "s3" {
    # Concrete values supplied by `-backend-config` from
    # environments/<env>/backend.hcl. Keeping them out of the repo
    # avoids leaking the bucket name into public clones.
    region                      = "auto"
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    use_path_style              = true
  }
}
