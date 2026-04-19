#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_FILE="${ROOT_DIR}/secrets.enc.yaml"
ENV_DIR="${ROOT_DIR}/.cache/zmail"
ENV_FILE="${ENV_DIR}/server.env"

mkdir -p "${ENV_DIR}"

if ! command -v sops >/dev/null 2>&1; then
	echo "sops is required to decrypt ${SECRETS_FILE}" >&2
	exit 1
fi

if ! sops decrypt --output-type dotenv --output "${ENV_FILE}" "${SECRETS_FILE}" >/dev/null; then
	echo "Failed to decrypt server bootstrap env from ${SECRETS_FILE}" >&2
	exit 1
fi

if [ "$#" -eq 0 ]; then
	echo "${ENV_FILE}"
	exit 0
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

exec "$@"
