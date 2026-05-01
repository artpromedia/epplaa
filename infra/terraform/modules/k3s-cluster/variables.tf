variable "cluster_name" {
  type = string
}

variable "location" {
  description = "Hetzner location code (fsn1, hel1, nbg1, ash, hil)."
  type        = string
}

variable "control_plane_count" {
  type    = number
  default = 3
}

variable "worker_count" {
  type    = number
  default = 3
}

variable "control_plane_server_type" {
  type    = string
  default = "cx22"
}

variable "worker_server_type" {
  type    = string
  default = "cx32"
}

variable "image" {
  description = "Hetzner OS image name. Ubuntu 24.04 ships with cloud-init out of the box."
  type        = string
  default     = "ubuntu-24.04"
}

variable "ssh_public_keys" {
  type = list(string)
}

variable "network_zone" {
  description = "Hetzner private network zone (eu-central, us-east, us-west)."
  type        = string
  default     = "eu-central"
}

variable "private_network_cidr" {
  type    = string
  default = "10.42.0.0/16"
}

variable "labels" {
  type    = map(string)
  default = {}
}
