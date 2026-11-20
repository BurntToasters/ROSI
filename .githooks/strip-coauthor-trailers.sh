#!/bin/sh
# Shared by commit-msg and prepare-commit-msg. Strips Co-authored-by trailers
# that include an email so GitHub does not add extra contributors. Prefix the
# email with `!` to keep a human co-author (`<!you@example.com>`).
# Bypass with: git commit --no-verify

set -e

msgfile=$1
if [ -z "$msgfile" ] || [ ! -f "$msgfile" ]; then
  exit 0
fi

hook_dir=$(dirname "$0")
repo_root=$(cd "$hook_dir/.." && pwd)
script="$repo_root/scripts/strip-coauthor-trailers.js"

if command -v cygpath >/dev/null 2>&1; then
  script=$(cygpath -w "$script")
  msgfile=$(cygpath -w "$msgfile")
fi

# Call node directly. Routing through cmd.exe would re-parse the message file
# path (spaces, &, ^, quotes).
run_node() {
  if command -v node >/dev/null 2>&1; then
    node "$@"
  elif command -v node.exe >/dev/null 2>&1; then
    node.exe "$@"
  else
    return 127
  fi
}

if ! run_node "$script" --in-place "$msgfile"; then
  echo "commit-msg: could not strip Co-authored-by email trailers (node missing or script failed)" >&2
  exit 1
fi
