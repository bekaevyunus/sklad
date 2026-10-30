#!/usr/bin/env bash
# Сброс пароля владельца «Склада». Запуск на сервере: bash /opt/sklad/reset-password.sh
set -euo pipefail
cd "$(dirname "$0")"
read -rp "Имя владельца [admin]: " NAME </dev/tty; NAME="${NAME:-admin}"
read -rsp "Новый пароль (минимум 4 символа): " PASS </dev/tty; echo
[ "${#PASS}" -ge 4 ] || { echo "Слишком короткий пароль."; exit 1; }
docker compose exec -T app node --disable-warning=ExperimentalWarning -e '
const c = require("node:crypto"), { DatabaseSync } = require("node:sqlite");
const d = new DatabaseSync("/data/sklad.db");
const [name, pass] = process.argv.slice(1);
const u = d.prepare("SELECT id, name FROM users").all().find((x) => x.name.toLowerCase() === name.toLowerCase());
if (!u) { console.log("Пользователь «" + name + "» не найден. Есть: " + d.prepare("SELECT name FROM users").all().map((x) => x.name).join(", ")); process.exit(1); }
const s = c.randomBytes(16).toString("hex");
d.prepare("UPDATE users SET pass_hash=?, salt=?, role=?, active=1 WHERE id=?").run(c.scryptSync(pass, s, 64).toString("hex"), s, "admin", u.id);
d.prepare("DELETE FROM sessions WHERE user_id=?").run(u.id);
console.log("Готово: пароль для «" + u.name + "» изменён.");
' "$NAME" "$PASS"
