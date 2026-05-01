# Provider declarations shared by every environment.
#
# Versions are pinned to the major.minor that we test in CI. Patch
# versions float so security fixes flow without a PR.
#
# Hetzner has no African region; the Lagos edge tier is provisioned via
# a separate module that uses the same hcloud provider but a different
# `location` attribute (see modules/lagos-edge/ — added in Phase 5).

terraform {
  required_version = ">= 1.9.0"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.51"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.46"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.17"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.34"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}
