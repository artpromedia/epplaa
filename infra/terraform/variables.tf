variable "environment" {
  description = "Deployment environment: staging | prod | dr."
  type        = string
  validation {
    condition     = contains(["staging", "prod", "dr"], var.environment)
    error_message = "environment must be staging, prod, or dr."
  }
}

variable "hcloud_location" {
  description = "Hetzner Cloud location. fsn1 (Falkenstein) is primary; hel1 (Helsinki) is DR; nbg1 (Nuremberg) is alternate."
  type        = string
  default     = "fsn1"
}

variable "cloudflare_account_id" {
  description = "Cloudflare account that owns the zone, tunnel, and DNS records."
  type        = string
}

variable "cloudflare_zone" {
  description = "Apex domain (e.g. epplaa.com)."
  type        = string
}

variable "cluster_name" {
  description = "k3s cluster name. Becomes the prefix for hcloud server names and Cloudflare DNS labels."
  type        = string
}

variable "control_plane_count" {
  description = "Number of k3s control-plane nodes. Must be odd (3 minimum for embedded etcd HA)."
  type        = number
  default     = 3
  validation {
    condition     = var.control_plane_count % 2 == 1 && var.control_plane_count >= 3
    error_message = "control_plane_count must be an odd number >= 3."
  }
}

variable "worker_count" {
  description = "Number of k3s worker nodes."
  type        = number
  default     = 3
}

variable "control_plane_server_type" {
  description = "Hetzner server type for control-plane nodes."
  type        = string
  default     = "cx22"
}

variable "worker_server_type" {
  description = "Hetzner server type for worker nodes."
  type        = string
  default     = "cx32"
}

variable "ssh_public_keys" {
  description = "List of SSH public keys to install on every node for break-glass access."
  type        = list(string)
}
