#!/bin/bash
# ExamGuard Database Backup Script (C48)
# Usage: ./scripts/db-backup.sh [backup_dir]
# Requires: pg_dump, DATABASE_URL environment variable

set -euo pipefail

BACKUP_DIR="${1:-./backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/examguard_${TIMESTAMP}.sql.gz"
CHECKSUM_FILE="${BACKUP_FILE}.sha256"

# Validate DATABASE_URL is set
if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL environment variable is not set"
  exit 1
fi

# Create backup directory
mkdir -p "${BACKUP_DIR}"

echo "Starting backup: ${BACKUP_FILE}"

# Perform backup (exclude passwords from process arguments)
pg_dump "${DATABASE_URL}" | gzip > "${BACKUP_FILE}"

# Generate checksum
sha256sum "${BACKUP_FILE}" > "${CHECKSUM_FILE}"

# Report results
BACKUP_SIZE=$(stat -f%z "${BACKUP_FILE}" 2>/dev/null || stat --format=%s "${BACKUP_FILE}" 2>/dev/null)
echo "Backup complete:"
echo "  File: ${BACKUP_FILE}"
echo "  Size: ${BACKUP_SIZE} bytes"
echo "  Checksum: $(cat "${CHECKSUM_FILE}")"
