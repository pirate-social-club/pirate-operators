#!/bin/sh
# Runs inside the Kubo container before the daemon starts (/container-init.d).
# `daemon --offline` alone still fetches remote autoconf. Disable it and clear
# the `auto` placeholders it would fill (bootstrap peers, DNS resolvers,
# delegated routers and publishers), so the node makes no outbound requests.
set -e
ipfs config --json AutoConf.Enabled false
ipfs config --json Bootstrap '[]'
ipfs config --json DNS.Resolvers '{}'
ipfs config --json Routing.DelegatedRouters '[]'
ipfs config --json Ipns.DelegatedPublishers '[]'
# Host networking: bind the gateway and RPC API to loopback on fixed ports.
# The swarm does not listen in offline mode.
ipfs config Addresses.Gateway /ip4/127.0.0.1/tcp/18080
ipfs config Addresses.API /ip4/127.0.0.1/tcp/15001
