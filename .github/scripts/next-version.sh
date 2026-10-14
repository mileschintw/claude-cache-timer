#!/usr/bin/env bash
# Prints the version a push releases, or nothing when it releases none.
#
# Usage: next-version.sh <current version> <git revision range>
#
# A commit asks for a release with a `Release: patch|minor|major` trailer.
# Several in one push release once, at the highest level asked for.
set -euo pipefail

version=$1
range=$2

level=0
while read -r value; do
  case "$value" in
    '') continue ;;
    patch) asked=1 ;;
    minor) asked=2 ;;
    major) asked=3 ;;
    *)
      echo "Unknown Release trailer value: $value (use patch, minor or major)" >&2
      exit 1
      ;;
  esac
  if [ "$asked" -gt "$level" ]; then level=$asked; fi
done < <(git log --format='%(trailers:key=Release,valueonly)' "$range" | tr -d '\r' | tr '[:upper:]' '[:lower:]' | tr -d '[:blank:]')

IFS=. read -r major minor patch <<<"$version"
case $level in
  0) exit 0 ;;
  1) patch=$((patch + 1)) ;;
  2) minor=$((minor + 1)) patch=0 ;;
  3) major=$((major + 1)) minor=0 patch=0 ;;
esac

echo "$major.$minor.$patch"
