# Hetzner Object Storage (S3-compatible) backend config for staging.
# Bucket is bootstrapped by scripts/bootstrap-tf-backend.sh.

bucket   = "epplaa-tfstate"
key      = "staging/terraform.tfstate"
endpoints = {
  s3 = "https://fsn1.your-objectstorage.com"
}
