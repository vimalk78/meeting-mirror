#!/usr/bin/env bash
# Install meeting-mirror as a pi and/or oh-my-pi (omp) extension: symlink
# the repository into each agent's extensions directory.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_EXT_DIR="${HOME}/.pi/agent/extensions"
OMP_EXT_DIR="${HOME}/.omp/agent/extensions"

want_pi=0
want_omp=0
if [ $# -eq 0 ]; then
	# default: pi always, omp when its config directory exists
	want_pi=1
	if [ -d "${HOME}/.omp" ]; then want_omp=1; fi
else
	for arg in "$@"; do
		case "${arg}" in
			pi) want_pi=1 ;;
			omp) want_omp=1 ;;
			*)
				echo "Usage: install.sh [pi] [omp]" >&2
				exit 1
				;;
		esac
	done
fi

install_one() {
	local ext_dir="$1"
	local target="${ext_dir}/meeting-mirror"
	mkdir -p "${ext_dir}"
	if [ -e "${target}" ] && [ ! -L "${target}" ]; then
		echo "Refusing to overwrite existing ${target} (not a symlink). Remove it first." >&2
		return 1
	fi
	ln -sfn "${REPO_DIR}" "${target}"
	echo "Installed: ${target} -> ${REPO_DIR}"
}

if [ "${want_pi}" -eq 1 ]; then install_one "${PI_EXT_DIR}"; fi
if [ "${want_omp}" -eq 1 ]; then install_one "${OMP_EXT_DIR}"; fi

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
echo "Start (or restart) your agent; a new session is private until you run /mirror share."
