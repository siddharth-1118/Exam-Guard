#!/usr/bin/env bash
set -euo pipefail

# ExamGuard Production Deployment Script (Bash)
# Validates environment, executes Prisma migrations, starts container stack,
# waits for service health, and executes production smoke tests.
# Never prints secrets, passwords, or tokens in logs.

echo "=== ExamGuard Production Deployment Automation ==="
node scripts/deploy-production.mjs
