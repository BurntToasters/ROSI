#!/bin/bash
export TMPDIR="$XDG_RUNTIME_DIR/app/$FLATPAK_ID"
export ELECTRON_IS_DEV=0
cd /app/rosi
exec zypak-wrapper /app/rosi/node_modules/electron/dist/electron . "$@"
