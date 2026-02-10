#!/bin/bash
cd "$(dirname "$0")/web-server"

echo "正在打包可执行文件..."

# 打包 Mac 和 Windows 版本
./node_modules/.bin/pkg . --targets node18-macos-x64,node18-win-x64 --output web-server

echo "正在整理发布文件..."
cd ..

# 准备 Mac 版文件夹
mkdir -p dist/Mac版/public
cp web-server/web-server-macos dist/Mac版/启动签到
cp -r web-server/public/* dist/Mac版/public/
chmod +x dist/Mac版/启动签到

# 准备 Windows 版文件夹
mkdir -p dist/Windows版/public
cp web-server/web-server-win.exe dist/Windows版/启动签到.exe
cp -r web-server/public/* dist/Windows版/public/

echo "打包完成！请查看 dist 文件夹。"
echo "您可以直接把 dist/Windows版 文件夹拷贝到没有 Node.js 的电脑上运行。"
