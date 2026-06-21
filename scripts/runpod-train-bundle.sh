#!/usr/bin/env bash
set -euo pipefail

BUNDLE="${1:-}"
WORKDIR="${2:-/workspace/worldsketch-train}"
OUTDIR="${3:-/output}"

if [[ -z "$BUNDLE" ]]; then
	for candidate in bundle.zip training_bundle.zip worldsketch-training-bundle.zip *.zip; do
		if [[ -f "$candidate" ]]; then
			BUNDLE="$candidate"
			break
		fi
	done
fi

if [[ -z "$BUNDLE" || ! -f "$BUNDLE" ]]; then
	echo "Missing training bundle zip."
	echo "Usage: $0 [bundle.zip] [workdir] [outdir]"
	exit 1
fi

mkdir -p "$OUTDIR"
rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"

BUNDLE="$(cd "$(dirname "$BUNDLE")" && pwd)/$(basename "$BUNDLE")"
unzip -q "$BUNDLE" -d "$WORKDIR"

cd "$WORKDIR"
chmod +x run_train.sh
./run_train.sh

cp job/world.splat "$OUTDIR/world.splat"

echo
echo "Done: $OUTDIR/world.splat"
