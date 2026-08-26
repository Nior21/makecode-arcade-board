#!/bin/bash
# Post-receive hook for task-tracker — с подробным логгированием
set -e

TARGET=/home/pi/task-tracker
GIT_DIR=/home/pi/task-tracker.git
LOG=/tmp/task-tracker-deploy.log

exec >> "$LOG" 2>&1
echo "=== Deploy started: $(date) ==="

while read oldrev newrev refname; do
  echo "Ref: $refname  Old: $oldrev  New: $newrev"
  if [ "$refname" = "refs/heads/master" ]; then
    SHORT=$(git --git-dir="$GIT_DIR" rev-parse --short "$newrev")
    echo "Deploying $SHORT to $TARGET..."

    echo "Files before:"
    ls -la "$TARGET" 2>&1 | head -5

    echo "Removing old files..."
    find "$TARGET" -mindepth 1 -maxdepth 1 \
      ! -name 'node_modules' \
      ! -name 'logs' \
      ! -name '.git' \
      -exec rm -rf {} + 2>&1
    echo "Remove exit code: $?"

    echo "Extracting archive..."
    git --git-dir="$GIT_DIR" archive "$newrev" | tar xvf - -C "$TARGET" 2>&1
    echo "Extract exit code: $?"

    echo "Files after:"
    ls -la "$TARGET" 2>&1 | head -10

    chown -R pi:pi "$TARGET"
    echo "Permissions fixed"

    echo "Restarting service..."
    sudo systemctl restart task-tracker 2>&1
    echo "Restart exit code: $?"

    sleep 1
    if sudo systemctl is-active --quiet task-tracker; then
      echo "SUCCESS: task-tracker is active"
    else
      echo "FAIL: task-tracker is not active"
      sudo systemctl status task-tracker --no-pager | head -20
      exit 1
    fi
  fi
done

echo "=== Deploy finished: $(date) ==="
