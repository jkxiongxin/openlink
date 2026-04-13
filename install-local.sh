#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BIN_NAME="openlink"

WITH_EXTENSION=0
for arg in "$@"; do
  case "$arg" in
    --with-extension)
      WITH_EXTENSION=1
      ;;
    -h|--help)
      cat <<'EOF'
Usage: ./install-local.sh [--with-extension]

Build and install the local OpenLink server from cmd/server/main.go.

Environment:
  OPENLINK_INSTALL_PATH=/custom/path/openlink  Override install target.

Options:
  --with-extension  Also rebuild extension/dist.
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

if [ -n "${OPENLINK_INSTALL_PATH:-}" ]; then
  INSTALL_PATH=$OPENLINK_INSTALL_PATH
elif command -v "$BIN_NAME" >/dev/null 2>&1; then
  INSTALL_PATH=$(command -v "$BIN_NAME")
else
  INSTALL_PATH="$HOME/.local/bin/$BIN_NAME"
fi

INSTALL_DIR=$(dirname -- "$INSTALL_PATH")
mkdir -p "$INSTALL_DIR"

TMP_DIR=$(mktemp -d)
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

echo "Building OpenLink server from $ROOT_DIR/cmd/server/main.go"
(cd "$ROOT_DIR" && go build -trimpath -o "$TMP_DIR/$BIN_NAME" ./cmd/server)

if [ -w "$INSTALL_DIR" ]; then
  install -m 0755 "$TMP_DIR/$BIN_NAME" "$INSTALL_PATH"
else
  echo "Install directory is not writable, using sudo: $INSTALL_DIR"
  sudo install -m 0755 "$TMP_DIR/$BIN_NAME" "$INSTALL_PATH"
fi

echo "Installed: $INSTALL_PATH"
HELP_FIRST_LINE=$("$INSTALL_PATH" -h 2>&1 | head -n 1)
echo "Verified server binary: $HELP_FIRST_LINE"

if [ "$WITH_EXTENSION" -eq 1 ]; then
  echo "Building extension/dist"
  (cd "$ROOT_DIR/extension" && npm run build)
  echo "Built: $ROOT_DIR/extension/dist"
fi

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "Note: $INSTALL_DIR is not in PATH." ;;
esac
