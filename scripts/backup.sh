#!/usr/bin/env bash
# Логическая копия PostgreSQL в формате custom. Основная защита в production: PITR управляемой базы;
# этот скрипт нужен для переносимых копий и учений. Использование: DATABASE_URL=... scripts/backup.sh /backups
set -euo pipefail
DIR="${1:-./backups}"
mkdir -p "$DIR"
FILE="$DIR/agency-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --no-owner --file="$FILE" "$DATABASE_URL"
sha256sum "$FILE" > "$FILE.sha256"
echo "$FILE"
