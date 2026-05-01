# Production environment.
#
# Apply requires manual approval (see .github/workflows/terraform.yml).

terraform {
  required_version = ">= 1.9.0"
}

module "stack" {
  source = "../.."

  environment               = "prod"
  hcloud_location           = "fsn1"
  cluster_name              = "epplaa-prod"
  control_plane_count       = 3
  worker_count              = 5
  control_plane_server_type = "cx32"
  worker_server_type        = "cx42"

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
