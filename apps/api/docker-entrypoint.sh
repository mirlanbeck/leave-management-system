#!/bin/sh
# Миграции и идемпотентный seed при каждом старте, затем основной процесс.
set -eu

npx prisma migrate deploy
npx prisma db seed

exec "$@"
