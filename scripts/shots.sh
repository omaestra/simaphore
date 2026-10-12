#!/bin/bash
# Redraws docs/images/*.svg from the demo scenes. Needs node and typescript (npx fetches it).
set -e
cd "$(dirname "$0")/.."
TSC=${TSC:-"npx -y -p typescript tsc"}
rm -rf .shots-build
$TSC -p scripts/tsconfig.json
node .shots-build/scripts/shots.js docs/images
rm -rf .shots-build
