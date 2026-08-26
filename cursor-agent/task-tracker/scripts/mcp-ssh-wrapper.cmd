@echo off
REM MCP SSH wrapper for task-tracker on RPi
REM Qwen Code calls this script, which pipes stdin/stdout through SSH
ssh pi@192.168.88.153 "node /home/pi/task-tracker/mcp-server.js"
