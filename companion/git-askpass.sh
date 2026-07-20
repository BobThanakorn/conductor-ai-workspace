#!/bin/sh
case "$1" in
  *Username*) printf '%s\n' "${GIT_HTTP_USERNAME:-x-access-token}" ;;
  *Password*) printf '%s\n' "${GITHUB_TOKEN:-${GITLAB_TOKEN:-}}" ;;
  *) printf '\n' ;;
esac
