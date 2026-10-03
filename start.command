#!/bin/bash
# Запуск Agency LinkedIn OS на Mac двойным щелчком: установка зависимостей, сборка интерфейса, сервер на http://localhost:3000
cd "$(dirname "$0")"
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
if ! command -v node >/dev/null; then echo "Нужен Node.js 22+: https://nodejs.org"; read -r; exit 1; fi
[ -d node_modules ] || npm install --no-audit --no-fund || { echo "npm install не удался"; read -r; exit 1; }
(sleep 6; open "http://localhost:3000") &
npm run dev
