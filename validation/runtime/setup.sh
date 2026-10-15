#!/usr/bin/env bash
# Official registry only; locked Linux x64 OMP/Bun installation in this folder.
set -euo pipefail
cd "$(dirname "$0")"
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { echo 'This cloud validation package targets Linux x86_64.' >&2; exit 1; }
command -v node >/dev/null
command -v npm >/dev/null
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<6))process.exit(1)'
mkdir -p home work agent logs
: > home/npm-user.conf
: > home/npm-global.conf
# Never inherit npm auth, provider credentials, user config, or proxy settings.
env -i PATH="$PATH" HOME="$PWD/home" NPM_CONFIG_USERCONFIG="$PWD/home/npm-user.conf" NPM_CONFIG_GLOBALCONFIG="$PWD/home/npm-global.conf" NPM_CONFIG_CACHE="${OMP_VALIDATION_NPM_CACHE:-$PWD/home/.npm}" npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org "$@"
node -e 'const fs=require("fs");for(const [name,v] of Object.entries({"@oh-my-pi/pi-coding-agent":"18.10.4","@oven/bun-linux-x64":"1.4.3","@slack/socket-mode":"2.0.7","@slack/web-api":"7.13.0"})){if(JSON.parse(fs.readFileSync(`node_modules/${name}/package.json`)).version!==v)throw Error(name+" version mismatch")}'
./node_modules/@oven/bun-linux-x64/bin/bun --version
printf 'Ready. Run ./run.sh (offline synthetic tests; no Slack or model credentials).\n'
