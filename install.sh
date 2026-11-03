#!/usr/bin/env bash
# Install meeting-mirror as a pi extension (symlink into the user extensions dir).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${HOME}/.pi/agent/extensions/meeting-mirror"

mkdir -p "${HOME}/.pi/agent/extensions"

if [ -e "${TARGET_DIR}" ] && [ ! -L "${TARGET_DIR}" ]; then
	echo "Refusing to overwrite existing ${TARGET_DIR} (not a symlink). Remove it first." >&2
	exit 1
fi

ln -sfn "${REPO_DIR}" "${TARGET_DIR}"
echo "Installed: ${TARGET_DIR} -> ${REPO_DIR}"
echo "Start (or restart) pi; a session will print the Meeting Mirror page URL."
