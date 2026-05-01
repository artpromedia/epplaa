output "control_plane_public_ips" {
  value = hcloud_server.control_plane[*].ipv4_address
}

output "worker_public_ips" {
  value = hcloud_server.worker[*].ipv4_address
}

output "control_plane_lb_ip" {
  value = hcloud_load_balancer.control_plane.ipv4
}

output "ingress_load_balancer_ip" {
  value = hcloud_load_balancer.ingress.ipv4
}

output "private_network_id" {
  value = hcloud_network.cluster.id
}

output "k3s_token" {
  value     = random_password.k3s_token.result
  sensitive = true
}

output "kubeconfig_path" {
  description = "Hint file path showing the manual scp command to retrieve kubeconfig from the first control-plane node."
  value       = local_file.kubeconfig_fetch_hint.filename
}
