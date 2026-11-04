#!/usr/bin/env bash
set -eu
export LC_ALL=C

version=$1
prerelease=$2
number='(0|[1-9][0-9]*)'
identifier="($number|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
pattern="^$number\\.$number\\.$number(-$identifier(\\.$identifier)*)?$"
if [[ ! $version =~ $pattern || ${#version} -gt 128 ]]; then
  echo 'Use a Docker-compatible version such as 1.2.3 or 1.2.3-rc.1 (no v prefix or +metadata).' >&2
  exit 1
fi
case "$prerelease" in
  true) ;;
  false)
    if [[ $version == *-* ]]; then
      echo 'A version with a prerelease suffix requires the prerelease checkbox.' >&2
      exit 1
    fi ;;
  *) echo 'prerelease must be true or false.' >&2; exit 1 ;;
esac
