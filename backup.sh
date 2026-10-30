#!/usr/bin/env bash
# Согласованная копия базы (безопасно, даже когда приложение работает)
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p backups
rm -f data/backup-tmp.db
docker compose exec -T app node --disable-warning=ExperimentalWarning -e \
  "new (require('node:sqlite').DatabaseSync)('/data/sklad.db').exec(\"VACUUM INTO '/data/backup-tmp.db'\")"
mv data/backup-tmp.db "backups/sklad-$(date +%F_%H%M).db"
find backups -name 'sklad-*.db' -mtime +30 -delete
echo "Копия сохранена в $(pwd)/backups"
