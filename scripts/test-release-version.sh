#!/usr/bin/env bash
set -eu

check() { bash "$(dirname "$0")/check-release-version.sh" "$@"; }
reject() {
  if check "$@" 2>/dev/null; then
    echo "unexpectedly accepted: $*" >&2
    exit 1
  fi
}
check 1.2.3 false
check 1.2.3 true
check 1.2.3-rc.1 true
reject 1.2.3-rc.1 false
reject 1.2.3 anything
for invalid in '' latest v1.2.3 1.2 01.2.3 1.2.3- 1.2.3-rc.01 1.2.3+build 1.2.3/rc "$(printf '1.0.0-rc%0121d' 1)"; do
  reject "$invalid" true
done
