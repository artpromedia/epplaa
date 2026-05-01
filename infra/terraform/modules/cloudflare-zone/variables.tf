variable "account_id" {
  type = string
}

variable "zone" {
  description = "Apex domain. Zone must already exist in Cloudflare; this module reads it via data source."
  type        = string
}

variable "cluster_name" {
  type = string
}

variable "environment" {
  type = string
}

variable "control_plane_ips" {
  description = "Control-plane public IPv4s. Used for break-glass A records (kube-api.<env>.epplaa.com)."
  type        = list(string)
}

variable "ingress_ip" {
  description = "Ingress load-balancer IPv4. Used as the *temporary* origin until Cloudflare Tunnel is up."
  type        = string
}
