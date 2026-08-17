#!/bin/sh
# chishiki v2 启动器
cd "$(dirname "$0")"
exec python3 bin/app.py "$@"
