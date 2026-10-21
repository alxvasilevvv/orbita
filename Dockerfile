# Полноценный запуск платформы Orbita на Unyly: Node-сервер (API + статика UI) и
# встроенный исполнитель всех оркестраций (публикация, b2b, автопилот, биллинг,
# лиды, X-взаимодействия, авторазрешение исходов) в одном процессе.
FROM node:22-slim
WORKDIR /app

# Зависимости (tsx и esbuild лежат в dependencies, поэтому --omit=dev их сохраняет).
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Исходники и сборка клиентского бандла.
COPY . .
RUN npm run build:ui

# Демо-режим рабочей платформы: демо-вход, засеянные данные, встроенный исполнитель.
# Для боевого контура: NODE_ENV=production, AUTH_MODE=header, SECRETS_KEY и DATABASE_URL (Postgres),
# отдельный процесс исполнителя src/worker/main.ts.
ENV NODE_ENV=development \
    AUTH_MODE=dev \
    SEED_DEMO=1 \
    INLINE_WORKER=1 \
    WORKER_INTERVAL_MS=10000 \
    PGLITE_DIR=/app/data/pglite \
    HOST=0.0.0.0 \
    PORT=3000

EXPOSE 3000
CMD ["node", "--import", "tsx", "src/server/main.ts"]
