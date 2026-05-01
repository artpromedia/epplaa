# Staging environment.
#
# Initialise with:
#   terraform -chdir=infra/terraform/environments/staging init \
#     -backend-config=backend.hcl
# Plan/apply:
#   terraform -chdir=infra/terraform/environments/staging plan -var-file=staging.tfvars
#   terraform -chdir=infra/terraform/environments/staging apply -var-file=staging.tfvars
#
# Required env vars at apply time:
#   HCLOUD_TOKEN              (Hetzner Cloud API token, project-scoped)
#   CLOUDFLARE_API_TOKEN      (zone:edit + dns:edit + tunnel:edit)
#   AWS_ACCESS_KEY_ID         (Hetzner Object Storage S3 access key)
#   AWS_SECRET_ACCESS_KEY     (Hetzner Object Storage S3 secret key)

terraform {
  required_version = ">= 1.9.0"
}

module "stack" {
  source = "../.."

  environment           = "staging"
  hcloud_location       = "fsn1"
  cluster_name          = "epplaa-staging"
  control_plane_count   = 3
  worker_count          = 3
  control_plane_server_type = "cx22"
  worker_server_type    = "cx32"

  cloudflare_account_id = var.cloudflare_account_id
  cloudflare_zone       = var.cloudflare_zone
  ssh_public_keys       = var.ssh_public_keys
}

variable "cloudflare_account_id" { type = string }
variable "cloudflare_zone" { type = string }
variable "ssh_public_keys" { type = list(string) }

output "ingress_load_balancer_ip" {
  value = module.stack.ingress_load_balancer_ip
}

output "control_plane_public_ips" {
  value = module.stack.control_plane_public_ips
}
