#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "mac-keychain-ssh.sh: skipping (not macOS)."
  exit 0
fi

KEYCHAIN_PATH="${KEYCHAIN_PATH:-$HOME/Library/Keychains/login.keychain-db}"
DOTENV_FILE="${DOTENV_FILE:-.env}"

if [[ -z "${KEYCHAIN_PASSWORD:-}" && -n "${SSH_USER_PWD:-}" ]]; then
  KEYCHAIN_PASSWORD="${SSH_USER_PWD}"
fi

if [[ -z "${KEYCHAIN_PASSWORD:-}" && -f "$DOTENV_FILE" ]]; then
  DOTENV_SSH_USER_PWD="$(awk -F= '
    /^[[:space:]]*SSH_USER_PWD[[:space:]]*=/ {
      val=substr($0, index($0, "=") + 1)
      sub(/\r$/, "", val)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", val)
      if ((val ~ /^".*"$/) || (val ~ /^'\''.*'\''$/)) {
        val=substr(val, 2, length(val)-2)
      }
      print val
    }
  ' "$DOTENV_FILE" | tail -n 1)"
  if [[ -n "$DOTENV_SSH_USER_PWD" ]]; then
    KEYCHAIN_PASSWORD="$DOTENV_SSH_USER_PWD"
  fi
fi

if [[ -z "${KEYCHAIN_PASSWORD:-}" ]]; then
  if [[ -t 0 ]]; then
    read -r -s -p "Login keychain password: " KEYCHAIN_PASSWORD
    echo
  else
    echo "KEYCHAIN_PASSWORD or SSH_USER_PWD is required in non-interactive shells."
    exit 1
  fi
fi

echo "Preparing keychain for non-GUI codesign..."
case $KEYCHAIN_PASSWORD in
  *[[:space:]\'\"\\$\`]*)
    echo "KEYCHAIN_PASSWORD must not contain whitespace, quotes, backslashes, or expansion characters."
    exit 1
    ;;
esac
# Password goes on security's stdin, not argv (ps). Prefer KEYCHAIN_PATH to a
# dedicated signing keychain; partition-list still applies to that file.
security -i <<EOF
unlock-keychain -p $KEYCHAIN_PASSWORD $KEYCHAIN_PATH
set-keychain-settings -lut 21600 $KEYCHAIN_PATH
list-keychains -d user -s $KEYCHAIN_PATH
default-keychain -d user -s $KEYCHAIN_PATH
set-key-partition-list -S apple-tool:,apple:,codesign: -s -k $KEYCHAIN_PASSWORD $KEYCHAIN_PATH
EOF

echo "Keychain ready for SSH signing."
