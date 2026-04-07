#!/bin/sh
set -e

REPO="jkxiongxin/openlink"
BIN="openlink"
INSTALL_DIR="/usr/local/bin"

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "不支持的架构: $ARCH"; exit 1 ;;
esac

VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)
if [ -z "$VERSION" ]; then
  echo "获取版本失败"; exit 1
fi

FILE="${BIN}-${OS}-${ARCH}.zip"
EXTRACTED_BIN="${BIN}-${OS}-${ARCH}"
URL="https://github.com/${REPO}/releases/download/${VERSION}/${FILE}"

echo "正在安装 openlink ${VERSION} (${OS}/${ARCH})..."
TMP=$(mktemp -d)
ARCHIVE="$TMP/$FILE"
curl -fsSL "$URL" -o "$ARCHIVE"
unzip -q "$ARCHIVE" -d "$TMP"

if [ ! -w "$INSTALL_DIR" ]; then
  INSTALL_DIR="${HOME}/.local/bin"
  mkdir -p "$INSTALL_DIR"
fi

if [ -w "$INSTALL_DIR" ]; then
  mv "$TMP/$EXTRACTED_BIN" "$INSTALL_DIR/$BIN"
else
  sudo mv "$TMP/$EXTRACTED_BIN" "$INSTALL_DIR/$BIN"
fi
rm -rf "$TMP"

echo "安装完成: $INSTALL_DIR/$BIN"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "提示：请将 $INSTALL_DIR 加入 PATH 后再直接运行 '$BIN'" ;;
esac
echo "运行 'openlink' 启动服务"
