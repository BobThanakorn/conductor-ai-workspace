#!/bin/sh
set -eu

load_secret() {
  variable="$1"
  file="$2"
  if [ -f "$file" ]; then
    value="$(cat "$file")"
    export "$variable=$value"
  fi
}

load_secret AZURE_AI_FOUNDRY_API_KEY /run/secrets/azure-api-key
load_secret OPENAI_API_KEY /run/secrets/openai-api-key
load_secret GITHUB_TOKEN /run/secrets/github-token
load_secret GITLAB_TOKEN /run/secrets/gitlab-token

exec "$@"
