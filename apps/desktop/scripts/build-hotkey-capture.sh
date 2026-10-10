#!/usr/bin/env bash
# 编译热键 capture 原生助手（CGEvent tap），产物与随包二进制同形态：packaged 与 dev 走同一路径。
# 编译失败以非零退出；装配层把「bin 缺失」与「编译失败」同归为 capture 不可用，回退 globalShortcut，
# 因此本脚本失败不阻塞应用启动——只在重编译时才需要手动跑它。
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p bin
/usr/bin/swiftc -O native/hotkey-capture.swift -o bin/hotkey-capture
echo "built bin/hotkey-capture"
