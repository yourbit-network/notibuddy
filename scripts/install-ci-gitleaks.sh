#!/usr/bin/env bash
set -euo pipefail
# Official Linux x64 release, pinned independently of the downloaded archive.
version=8.30.1
checksum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
directory=$(mktemp -d)
trap 'rm -rf "$directory"' EXIT
curl --fail --location --retry 3 "https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_linux_x64.tar.gz" -o "$directory/gitleaks.tar.gz"
printf '%s  %s\n' "$checksum" "$directory/gitleaks.tar.gz" | sha256sum --check --strict
mkdir -p "$RUNNER_TEMP/notibuddy-tools"
tar -xzf "$directory/gitleaks.tar.gz" -C "$RUNNER_TEMP/notibuddy-tools" gitleaks
echo "$RUNNER_TEMP/notibuddy-tools" >> "$GITHUB_PATH"
