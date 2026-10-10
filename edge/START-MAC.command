#!/bin/bash
# DDX Vision Edge — запуск в один клик (macOS).
# Первый запуск: правый клик по файлу → «Открыть» → «Открыть».
cd "$(dirname "$0")" || exit 1
pause() { read -r -p "Нажмите Enter, чтобы закрыть окно… " _ </dev/tty 2>/dev/null || true; }
echo "=== DDX Vision Edge ==="

if ! command -v python3 >/dev/null 2>&1; then
  echo "Не найден Python 3. Установите его с python.org и запустите файл снова."
  pause; exit 1
fi

if [ ! -d .venv ]; then
  echo "1/3 Готовлю окружение (один раз)…"
  python3 -m venv .venv || { echo "Не удалось создать окружение. Если Mac предложил установить «средства командной строки» — согласитесь, подождите и запустите файл снова."; pause; exit 1; }
fi
# shellcheck disable=SC1091
source .venv/bin/activate

if [ ! -f .venv/.ddx-installed ]; then
  echo "2/3 Устанавливаю нужное (один раз, 1–3 минуты)…"
  pip install --quiet -r requirements.txt || { echo "Не удалось установить. Проверьте интернет и запустите снова."; pause; exit 1; }
  touch .venv/.ddx-installed
fi

echo "3/3 Проверяю модель людей (скачивается один раз, 20 МБ)…"
python3 ddx_edge.py --download-model || { echo "Не удалось скачать модель. Проверьте интернет."; pause; exit 1; }

echo
echo "Запускаю. Если Mac спросит доступ к камере или входящие подключения — нажмите «Разрешить»."
echo "Safari откроется сам через несколько секунд."
echo "Остановить: клавиша q в окне с видео или Ctrl+C здесь."
echo
( sleep 8; if command -v open >/dev/null 2>&1; then
    open -a Safari "http://localhost:8787/#live" 2>/dev/null || open "http://localhost:8787/#live"
    # если создан администратор — открываем и админ-приложение (видео, вход по логину и паролю)
    if [ -f admins.json ]; then sleep 2; open -a Safari "http://localhost:8788/" 2>/dev/null || open "http://localhost:8788/"; fi
  fi ) &
if [ ! -f admins.json ]; then echo "Админ-приложение (видео) выключено: создайте администратора файлом ADD-ADMIN-MAC.command"; fi

# по умолчанию: окно с рамками вокруг людей (--preview). Для проверки без окна: DDX_EDGE_ARGS=" " ./START-MAC.command
python3 ddx_edge.py ${DDX_EDGE_ARGS---preview}
echo
echo "Остановлено."
pause
