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

if [ -n "${MEETING_MIRROR_RELAY:-}" ]; then
	echo "MEETING_MIRROR_RELAY is already set: ${MEETING_MIRROR_RELAY}"
else
	if [ -t 0 ]; then
		printf "Relay URL for your team (empty to skip, local mode only): "
		read -r relay_url
		if [ -n "${relay_url}" ]; then
			if ! grep -q "MEETING_MIRROR_RELAY" "${HOME}/.bashrc" 2>/dev/null; then
				printf 'export MEETING_MIRROR_RELAY="%s"\n' "${relay_url}" >> "${HOME}/.bashrc"
				echo "Added export to ~/.bashrc. Start a new shell or: export MEETING_MIRROR_RELAY=${relay_url}"
			fi
		fi
	fi
fi
echo "Start (or restart) pi; a session will print the Meeting Mirror page URL."
