#!/bin/bash
# Создать администратора точки (для админ-приложения с видео).
# Правый клик по файлу → «Открыть» → «Открыть». Перед этим один раз запустите START-MAC.command.
cd "$(dirname "$0")" || exit 1
pause() { read -r -p "Нажмите Enter, чтобы закрыть окно… " _ </dev/tty 2>/dev/null || true; }
echo "=== Создание администратора точки ==="
if [ ! -d .venv ]; then
  echo "Сначала один раз запустите START-MAC.command: он всё установит."
  pause; exit 1
fi
# shellcheck disable=SC1091
source .venv/bin/activate
read -r -p "Логин (латиница, цифры, точка, дефис, например ivanov): " LOGIN
python3 ddx_edge.py --add-admin "$LOGIN"
echo
echo "Теперь запустите (или перезапустите) START-MAC.command."
echo "Админ-приложение с видео откроется само: http://localhost:8788/"
pause
