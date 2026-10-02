#!/usr/bin/env bash
# Учения по восстановлению: копия → временная база → миграции → проверки → отчёт.
# Использование: DATABASE_URL=<рабочая> DRILL_URL=<пустая временная база> scripts/restore-drill.sh backups/agency-....dump
set -euo pipefail
FILE="$1"
sha256sum -c "$FILE.sha256"
START=$(date +%s)
pg_restore --no-owner --clean --if-exists --dbname="$DRILL_URL" "$FILE"
DATABASE_URL="$DRILL_URL" npx tsx src/db/migrate-cli.ts
for T in clients managed_accounts content_items publication_jobs external_publications audit_events; do
  A=$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM $T")
  B=$(psql "$DRILL_URL" -tAc "SELECT count(*) FROM $T")
  echo "$T: рабочая=$A восстановленная=$B"
done
psql "$DRILL_URL" -tAc "SELECT count(*) FROM pg_policies WHERE policyname = 'tenant_isolation'" | xargs -I{} echo "Политик изоляции: {}"
echo "Время восстановления: $(( $(date +%s) - START )) с (цель RTO ≤ 4 ч)"
