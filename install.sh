#!/usr/bin/env bash
# Установка «Склада» на VPS (Ubuntu/Debian) одной командой:
#   bash <(curl -fsSL https://raw.githubusercontent.com/bekaevyunus/sklad/main/install.sh)
# Повторный запуск обновляет приложение, данные сохраняются.
set -euo pipefail

REPO="https://github.com/bekaevyunus/sklad.git"
DIR="/opt/sklad"

say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mОшибка: %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "запустите под root (или через sudo)."

say "Устанавливаю Docker и git (если их ещё нет)"
if ! command -v git >/dev/null; then apt-get update -qq && apt-get install -y -qq git curl >/dev/null; fi
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh >/dev/null; fi
docker compose version >/dev/null 2>&1 || die "не удалось установить docker compose."

say "Скачиваю приложение в $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone -q "$REPO" "$DIR" || die "не удалось скачать $REPO. Репозиторий должен быть публичным (или настройте доступ)."
fi
cd "$DIR"

if [ ! -f .env ]; then
  IP="$(curl -fsS4 --max-time 8 https://api.ipify.org || curl -fsS4 --max-time 8 https://ifconfig.me || true)"
  DEFAULT_DOMAIN=""
  [ -n "$IP" ] && DEFAULT_DOMAIN="${IP//./-}.sslip.io"

  echo
  echo "Адрес сайта. Если своего домена нет — нажмите Enter, будет: ${DEFAULT_DOMAIN:-(не удалось определить IP)}"
  read -rp "Домен: " DOMAIN </dev/tty
  DOMAIN="${DOMAIN:-$DEFAULT_DOMAIN}"
  [ -n "$DOMAIN" ] || die "не указан домен."

  read -rp "Имя владельца для входа [admin]: " ADMIN_NAME </dev/tty
  ADMIN_NAME="${ADMIN_NAME:-admin}"
  while true; do
    read -rsp "Пароль владельца (минимум 4 символа): " ADMIN_PASSWORD </dev/tty; echo
    [ "${#ADMIN_PASSWORD}" -ge 4 ] && break
    echo "Слишком короткий, попробуйте ещё раз."
  done

  umask 077
  cat > .env <<EOF
DOMAIN=$DOMAIN
ADMIN_NAME=$ADMIN_NAME
ADMIN_PASSWORD=$ADMIN_PASSWORD
EOF
fi

# Открываем порты, если включён брандмауэр ufw
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi

# Ежедневная резервная копия базы в 03:30, хранится 30 дней
chmod +x "$DIR/backup.sh"
echo "30 3 * * * root $DIR/backup.sh >/dev/null 2>&1" > /etc/cron.d/sklad-backup

say "Собираю и запускаю (первый раз 1–3 минуты)"
docker compose up -d --build

DOMAIN="$(grep '^DOMAIN=' .env | cut -d= -f2-)"
say "Готово!"
echo "Откройте: https://$DOMAIN"
echo "Сертификат https выпускается автоматически, первые 1–2 минуты сайт может не открываться — подождите."
echo
echo "Полезное:"
echo "  обновить приложение:  bash $DIR/install.sh"
echo "  посмотреть журнал:    cd $DIR && docker compose logs -f --tail 50"
echo "  копия базы сейчас:    $DIR/backup.sh   (и автоматически каждую ночь в $DIR/backups)"
