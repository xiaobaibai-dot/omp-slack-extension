#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p home work agent logs
env -i PATH="$PATH" HOME="$PWD/home" node ./prepare-candidate.mjs
exec env -i PATH="$PATH" HOME="$PWD/home" XDG_CONFIG_HOME="$PWD/home/.config" XDG_CACHE_HOME="$PWD/home/.cache" XDG_DATA_HOME="$PWD/home/.local/share" "$PWD/node_modules/@oven/bun-linux-x64/bin/bun" test runtime.test.ts --timeout 20000
