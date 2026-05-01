# Root composition: wires modules together for a single environment.
# Per-environment differences (sizing, region, names) come from
# environments/<env>/terraform.tfvars + backend.hcl.

locals {
  common_labels = {
    environment = var.environment
    managed-by  = "terraform"
    project     = "epplaa"
  }
}

module "k3s" {
  source = "./modules/k3s-cluster"

  cluster_name              = var.cluster_name
  location                  = var.hcloud_location
  control_plane_count       = var.control_plane_count
  worker_count              = var.worker_count
  control_plane_server_type = var.control_plane_server_type
  worker_server_type        = var.worker_server_type
  ssh_public_keys           = var.ssh_public_keys
  labels                    = local.common_labels
}

module "cloudflare" {
  source = "./modules/cloudflare-zone"

  account_id        = var.cloudflare_account_id
  zone              = var.cloudflare_zone
  cluster_name      = var.cluster_name
  environment       = var.environment
  control_plane_ips = module.k3s.control_plane_public_ips
  ingress_ip        = module.k3s.ingress_load_balancer_ip
}

output "kubeconfig_path" {
  description = "Path to the kubeconfig written by the k3s module. Add to KUBECONFIG to reach the cluster."
  value       = module.k3s.kubeconfig_path
  sensitive   = true
}

output "control_plane_public_ips" {
  value = module.k3s.control_plane_public_ips
}

output "ingress_load_balancer_ip" {
  value = module.k3s.ingress_load_balancer_ip
}
