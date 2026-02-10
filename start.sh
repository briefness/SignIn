#!/bin/bash
cd "$(dirname "$0")/web-server"
echo "正在启动签到服务..."
echo "请勿关闭此窗口！"
open http://localhost:3000
npm start
read -p "服务已停止。按任意键退出窗口..."
