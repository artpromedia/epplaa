# Cloudflare DNS + Tunnel + WAF baseline.
#
# Public ingress strategy:
#   1. Cloudflare → Cloudflare Tunnel → cloudflared pod in cluster → Traefik
#      (NO public LB exposure of HTTP/HTTPS in steady state).
#   2. Hetzner ingress LB stays internal-only after the tunnel is healthy;
#      we leave a *break-glass* A record `bg.<env>.epplaa.com` pointing at
#      the LB so on-call can route around a tunnel outage.
#
# The tunnel itself is created here (so the credential is provisioned by
# Terraform and stored in Vault), but the cloudflared workload runs in
# the cluster (infra/helm/cloudflared/).

terraform {
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare" }
    random     = { source = "hashicorp/random" }
  }
}

data "cloudflare_zone" "apex" {
  name = var.zone
}

# ----- Tunnel ----------------------------------------------------------------

resource "random_id" "tunnel_secret" {
  byte_length = 32
}

resource "cloudflare_tunnel" "ingress" {
  account_id = var.account_id
  name       = "${var.cluster_name}-ingress"
  secret     = random_id.tunnel_secret.b64_std
}

# DNS records that route traffic through the tunnel. The hostname pattern
# follows the existing `check-production-hostname-pattern.yml` workflow
# convention (per-env subdomain).
locals {
  tunnel_hostnames = var.environment == "prod" ? [
    "api",
    "spa",
    "admin",
    "partner",
    "studio",
  ] : [
    "api.${var.environment}",
    "spa.${var.environment}",
    "admin.${var.environment}",
    "partner.${var.environment}",
    "studio.${var.environment}",
  ]
}

resource "cloudflare_record" "tunnel_targets" {
  for_each = toset(local.tunnel_hostnames)

  zone_id = data.cloudflare_zone.apex.id
  name    = each.value
  content = "${cloudflare_tunnel.ingress.id}.cfargotunnel.com"
  type    = "CNAME"
  proxied = true
  comment = "Cloudflare Tunnel → ${var.cluster_name}"
}

# Break-glass: direct A record at the Hetzner ingress LB. Proxied=false so
# `dig` resolves to the origin IP. Restricted by Cloudflare Access policy
# (configured separately) so anonymous traffic is still blocked.
resource "cloudflare_record" "break_glass" {
  zone_id = data.cloudflare_zone.apex.id
  name    = "bg.${var.environment}"
  content = var.ingress_ip
  type    = "A"
  proxied = false
  comment = "Break-glass — bypass Cloudflare Tunnel"
}

# Kube-API direct access (for `kubectl` from operators with mTLS).
resource "cloudflare_record" "kube_api" {
  count   = length(var.control_plane_ips)
  zone_id = data.cloudflare_zone.apex.id
  name    = "kube-api-${count.index + 1}.${var.environment}"
  content = var.control_plane_ips[count.index]
  type    = "A"
  proxied = false
  comment = "k3s control-plane direct (operator break-glass)"
}

# ----- WAF baseline ----------------------------------------------------------

resource "cloudflare_ruleset" "waf_baseline" {
  zone_id     = data.cloudflare_zone.apex.id
  name        = "${var.cluster_name}-waf-baseline"
  description = "Block obvious bot traffic and known-bad UA strings."
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules {
    action      = "block"
    expression  = "(http.user_agent contains \"sqlmap\") or (http.user_agent contains \"nikto\") or (http.user_agent contains \"nuclei\")"
    description = "Block well-known offensive scanners"
    enabled     = true
  }

  rules {
    action      = "managed_challenge"
    expression  = "(cf.threat_score gt 30)"
    description = "Challenge requests with elevated threat score"
    enabled     = true
  }
}

output "tunnel_id" {
  value = cloudflare_tunnel.ingress.id
}

output "tunnel_token" {
  value     = cloudflare_tunnel.ingress.tunnel_token
  sensitive = true
}
