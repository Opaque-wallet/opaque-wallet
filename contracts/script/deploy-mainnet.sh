#!/usr/bin/env bash
# Deploys the PQ wallet layer + RelayDirectory to Arc MAINNET (no pools).
# Forge asks for the private key at a hidden prompt; it is never written to disk.
#   ./script/deploy-mainnet.sh 0xYourDeployerAddress
set -euo pipefail
cd "$(dirname "$0")/.."
SENDER="${1:?usage: $0 <deployer address>}"
unset PRIVATE_KEY ETH_PRIVATE_KEY
DEPLOYMENTS=arc-mainnet.json forge script script/DeployPQStack.s.sol \
  --rpc-url arc_mainnet --sender "$SENDER" --interactives 1 --broadcast --slow
