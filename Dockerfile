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

# Боевой контур: production-режим, вход только по подписанной куки-сессии (email+пароль, Google),
# заголовки идентификации не принимаются. Встроенный исполнитель оркестраций в том же процессе (INLINE_WORKER=1).
# SECRETS_KEY и APP_URL заданы в окружении Unyly и переопределяют значения ниже.
# SEED_DEMO=1 засевает демо-данные для первых клиентов и тестов (вход: демо-пользователь, пароль orbita2026).
# Для постоянного хранения задайте DATABASE_URL (Postgres); иначе данные в PGlite эфемерны и пересоздаются при деплое.
# Оплата подписок включается заданием STRIPE_SECRET_KEY и STRIPE_WEBHOOK_SECRET (без них касса отключена, платформа работает).
ENV NODE_ENV=production \
    AUTH_MODE=session \
    SEED_DEMO=1 \
    INLINE_WORKER=1 \
    WORKER_INTERVAL_MS=10000 \
    PGLITE_DIR=/app/data/pglite \
    HOST=0.0.0.0 \
    PORT=3000

EXPOSE 3000
CMD ["node", "--import", "tsx", "src/server/main.ts"]
