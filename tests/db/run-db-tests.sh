#!/usr/bin/env bash
# =============================================================================
# run-db-tests.sh
# 以全新的 PostgreSQL 18 容器套用 migrations/ 全部檔案，並執行不變條件測試。
#
# 用法（Git Bash / Linux / macOS）：
#   bash tests/db/run-db-tests.sh          # 測完移除容器
#   bash tests/db/run-db-tests.sh --keep   # 保留容器供檢查
#
# 進入保留的容器：
#   docker exec -it iac-migration-test psql -U postgres -d iac
#
# 容器不對外開埠，不會與本機其他 PostgreSQL（例如 5432）衝突。
# 任一 migration 失敗或任一測試未通過時，以非零狀態結束。
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
export MSYS_NO_PATHCONV=1          # Git Bash：避免容器內路徑被改寫成 C:/...

C=iac-migration-test
IMAGE=postgres:18-alpine
KEEP="${1:-}"

echo "=== 1/3 建立全新容器（$IMAGE）==="
docker rm -f "$C" >/dev/null 2>&1 || true
docker run -d --name "$C" -e POSTGRES_PASSWORD=devonly -e POSTGRES_DB=iac "$IMAGE" >/dev/null
# 以 TCP 探測：映像初始化階段的暫時伺服器只聽 unix socket，
# TCP 有回應代表正式伺服器已啟動。
docker exec "$C" sh -c 'until pg_isready -h 127.0.0.1 -q; do sleep 0.3; done'
docker exec "$C" psql -U postgres -d iac -Atc "select version()" | cut -c1-40
docker exec "$C" mkdir -p /migrations
docker cp ./migrations/. "$C:/migrations/" >/dev/null

echo "=== 2/3 依序套用 migrations ==="
docker exec -i "$C" sh <<'EOF'
export PGCLIENTENCODING=UTF8
cd /migrations
n=0
for f in $(ls *.sql | sort); do
  if [ "$f" = "0011_db_roles.sql" ]; then
    out=$(psql -U postgres -d iac -v ON_ERROR_STOP=1 -q \
          -v api_pw="'dev_api'" -v coach_pw="'dev_coach'" \
          -v worker_pw="'dev_worker'" -v ro_pw="'dev_ro'" -f "$f" 2>&1)
  else
    out=$(psql -U postgres -d iac -v ON_ERROR_STOP=1 -q -f "$f" 2>&1)
  fi
  if [ $? -ne 0 ]; then
    echo "FAIL  $f"
    echo "$out" | grep -v '^NOTICE' | tail -8
    exit 1
  fi
  echo "OK    $f"
  n=$((n+1))
done
echo "$n migrations applied"
EOF

echo "=== 3/3 不變條件測試 ==="
out=$(docker exec -i -e PGCLIENTENCODING=UTF8 "$C" \
        psql -U postgres -d iac -v ON_ERROR_STOP=1 -q < tests/db/invariant_tests.sql 2>&1)
# 去除每個 SELECT pg_temp.t(...) 產生的單列輸出，只留報表
echo "$out" | grep -v -E '^ t $|^---$|^ $|^\(1 row\)$|^$'

failed=$(echo "$out" | awk '/ passed \| failed \| total/{getline; getline; gsub(/ /,""); split($0,a,"|"); print a[2]}')

if [ "$KEEP" != "--keep" ]; then
  docker rm -f "$C" >/dev/null
  echo "(容器已移除；加 --keep 可保留)"
else
  echo "(容器保留：docker exec -it $C psql -U postgres -d iac)"
fi

if [ -z "$failed" ] || [ "$failed" != "0" ]; then
  echo "RESULT: FAILED (${failed:-unknown} failing)"
  exit 1
fi
echo "RESULT: ALL PASSED"
