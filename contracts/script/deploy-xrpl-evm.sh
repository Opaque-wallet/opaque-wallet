#!/usr/bin/env bash
# Deploys the PQ wallet layer + RelayDirectory to the XRPL EVM sidechain MAINNET
# (no pools): Arc's contracts, unchanged, for dapps that need FORS accounts the
# chain itself checks.
#
# Forge asks for the private key at a hidden prompt; it is never written to
# disk. XRP pays the gas, and the factory's 1 XRP stake in EntryPoint v0.7.
#   ./script/deploy-xrpl-evm.sh 0xYourDeployerAddress
#
# Then copy the printed addresses into deployments/xrpl-evm-mainnet.json.
set -euo pipefail
cd "$(dirname "$0")/.."
SENDER="${1:?usage: $0 <deployer address>}"
unset PRIVATE_KEY ETH_PRIVATE_KEY
DEPLOYMENTS=xrpl-evm-mainnet.json forge script script/DeployPQStack.s.sol \
  --rpc-url https://rpc.xrplevm.org --sender "$SENDER" --interactives 1 --broadcast --slow
