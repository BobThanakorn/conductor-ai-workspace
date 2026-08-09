#!/bin/sh
set -eu

load_secret() {
  variable="$1"
  file="$2"
  if [ -f "$file" ]; then
    value="$(cat "$file")"
    if [ -n "$value" ]; then
      export "$variable=$value"
    fi
  fi
}

load_secret AZURE_AI_FOUNDRY_API_KEY /run/secrets/azure-api-key
load_secret OPENAI_API_KEY /run/secrets/openai-api-key

exec "$@"
