#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
destination="$project_root/analytics/adym-admin.sqlite3"
temporary="$destination.download"
server="${ADYM_SERVER:-root@185.198.152.118}"

mkdir -p "$project_root/analytics"
trap 'rm -f "$temporary"' EXIT HUP INT TERM
scp -q "$server:/opt/adym/data/admin-export.sqlite3" "$temporary"
chmod 600 "$temporary"
mv -f "$temporary" "$destination"
trap - EXIT HUP INT TERM
printf 'База обновлена: %s\n' "$destination"
