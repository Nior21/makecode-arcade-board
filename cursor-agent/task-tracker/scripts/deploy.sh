#!/bin/bash
# deploy.sh — Push-based deploy for task-tracker
# Usage: bash scripts/deploy.sh
set -e

cd "$(dirname "$0")/.."

echo "=== Deploy start ==="

# Check for changes
if [ -z "$(git status --porcelain)" ]; then
  echo "No changes to deploy"
  echo "=== Deploy skipped ==="
  exit 0
fi

echo "Changes detected:"
git status --porcelain | while IFS= read -r line; do echo "  $line"; done

# Commit
git add -A
git commit -m "auto-deploy $(date +%Y-%m-%d_%H:%M:%S)"

# Push
git push rpi master --force

echo "=== Deploy done ==="
