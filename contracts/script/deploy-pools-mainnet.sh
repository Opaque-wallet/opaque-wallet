#!/usr/bin/env bash
# Deploys the seven RING_8 pools (+ verifiers) to Arc MAINNET and registers the
# mainnet attester's FORS key. The deployer key is asked for at a hidden prompt;
# the attester's key and commitments come from backend/mainnet.env.
#   ./script/deploy-pools-mainnet.sh 0xYourDeployerAddress
set -euo pipefail
cd "$(dirname "$0")/.."
SENDER="${1:?usage: $0 <deployer address>}"
unset PRIVATE_KEY ETH_PRIVATE_KEY
set -a; source ../backend/mainnet.env; set +a
DEPLOYMENTS=arc-mainnet.json DENOMINATIONS=1000000,2000000,5000000,10000000,20000000,50000000,100000000 \
  forge script script/DeployRingPool.s.sol \
  --rpc-url arc_mainnet --sender "$SENDER" --interactives 1 --broadcast --slow
