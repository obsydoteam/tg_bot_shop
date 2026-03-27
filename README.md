# OBSYDO VPN Telegram Shop Bot

Продакшн-бот-магазин для продажи VPN через Telegram Stars (`XTR`) с интеграцией Remnawave, inline-админкой, выдачей/продлением подписок, ежедневными отчетами и фоновыми сверками.

---

## Возможности

- Продажа тарифов в Telegram через инвойсы `XTR`.
- Тарифная сетка: 1 месяц (база), 3 месяца (-5%), 6 месяцев (-10%).
- Автоматическая выдача доступа в Remnawave после оплаты.
- Продление подписки для существующих пользователей.
- Пробный период 1 час и 1 GB (одноразово).
- Месячный цикл трафика: лимит не суммируется при продлении, reset раз в 30 дней.
- Напоминания об окончании подписки за 24 часа и за 1 час.
- Reconciliation (сверка локальных данных и Remnawave).
- Ежедневная сводка админу в 23:00 МСК.
- Inline-first UX (минимум “мусора” в переписке).
- Расширенная админка: поиск, действия по пользователю, редактирование тарифов.
- Backup SQLite с ротацией.
- Docker healthcheck.

---

## Рекомендуемые характеристики VPS

- Минимум: `1 vCPU / 1 GB RAM / 20 GB SSD`
- Рекомендуемо: `2 vCPU / 2 GB RAM / 30-40 GB SSD`
- ОС: Ubuntu 24.04 LTS (полностью поддерживается)

---

## Архитектура

- Язык/Runtime: Node.js + TypeScript
- Фреймворк бота: Telegraf
- Хранилище: SQLite (`better-sqlite3`)
- Деплой: Docker + Docker Compose
- Внешние сервисы:
  - Telegram Bot API
  - Remnawave API

---

## 1) Подготовка репозитория (локально)

В корне проекта:

```bash
git init
git add .
git commit -m "Initial production-ready OBSYDO VPN bot"
git branch -M main
git remote add origin https://github.com/obsydoteam/tg_bot_shop.git
git push -u origin main
```

---

## 2) Полный деплой на Ubuntu 24.04 (с нуля)

### 2.1 Подключение к серверу

```bash
ssh root@<VPS_IP>
```

### 2.2 Обновление системы

```bash
apt update && apt upgrade -y
apt install -y git curl ca-certificates gnupg lsb-release nano ufw
```

### 2.3 Установка Docker + Compose plugin

```bash
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
docker --version
docker compose version
```

### 2.4 Базовый firewall

```bash
ufw allow OpenSSH
ufw --force enable
ufw status
```

### 2.5 Клонирование проекта

```bash
cd /opt
git clone https://github.com/obsydoteam/tg_bot_shop.git tg_bot_shop
cd tg_bot_shop
```

### 2.6 Настройка `.env`

```bash
cp .env.example .env
nano .env
```

Обязательно заполнить:

- `BOT_TOKEN`
- `REMNAWAVE_BASE_URL`
- `REMNAWAVE_API_TOKEN`
- `ADMIN_TELEGRAM_IDS`
- `SHOP_NAME`
- `SUPPORT_LINK`

### 2.7 Подготовить папку данных

```bash
mkdir -p data/backups
```

### 2.8 Запуск

```bash
sh deploy.sh
```

Альтернатива:

```bash
docker compose up -d --build
```

### 2.9 Проверка

```bash
docker compose ps
docker compose logs -f --tail=200
```

---

## 3) Обновление версии на сервере

```bash
cd /opt/tg_bot_shop
git pull
docker compose up -d --build
```

---

## 4) Основные команды эксплуатации

Запуск:

```bash
docker compose up -d --build
```

Остановка:

```bash
docker compose down
```

Перезапуск:

```bash
docker compose restart
```

Логи:

```bash
docker compose logs -f --tail=200
```

Статус:

```bash
docker compose ps
```

---

## 5) Переменные окружения (`.env`)

Смотрите `/.env.example`. Ключевые параметры:

- `BOT_TOKEN`
- `REMNAWAVE_BASE_URL`
- `REMNAWAVE_API_TOKEN` (рекомендуемый способ авторизации)
- `ADMIN_TELEGRAM_IDS`
- `DATABASE_PATH`
- `DATABASE_PATH=/app/data/shop.db`
- `DEFAULT_PLAN_PRICE_STARS=200`
- `DEFAULT_PLAN_DURATION_DAYS=30`
- `DEFAULT_TRAFFIC_GB=300`
- `TRIAL_DURATION_HOURS=1`
- `TRIAL_TRAFFIC_GB=1`
- `TIMEZONE=Europe/Moscow`
- `RECONCILE_INTERVAL_MINUTES`
- `RECONCILE_LIMIT`
- `DB_BACKUP_DIR=/app/data/backups`
- `DB_BACKUP_INTERVAL_MINUTES`
- `DB_BACKUP_RETENTION_DAYS`

---

## 6) Как работает админка

Основная точка входа: `/admin`

### Inline-функции

- Статистика
- Последние заказы
- Тарифы (inline-редактирование: цена/дни/трафик/ON-OFF)
- Инструкции
- Поиск пользователя по telegramId
- Рассылка
- Действия по пользователю: enable/disable/reset/revoke/delete/+30 дней

### Команды (fallback)

- `/stats`
- `/orders [N]`
- `/finduser <telegramId>`
- `/grantdays <telegramId> <days>`
- `/enable <telegramId>`
- `/disable <telegramId>`
- `/reset <telegramId>`
- `/revoke <telegramId>`
- `/delete <telegramId>`
- `/broadcast <text>`
- `/plansadmin`
- `/setprice <code> <stars>`
- `/editplan <code>|<title>|<description>|<stars>|<days>|<trafficGb>`
- `/reconcile`
- `/dailyreport`

Опасные действия защищены подтверждением `Да/Нет`.

---

## 7) Надежность и сохранность данных

- SQLite: `WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000`.
- Уникальность `payment_charge_id` на уровне БД.
- Фоновый backup БД с ротацией.
- Основные файлы данных лежат в `./data` на хосте (`shop.db` и `backups`).
- Reconciliation по расписанию + ручной запуск.
- Daily summary в 23:00 МСК.
- Healthcheck контейнера (`node dist/healthcheck.js`).

---

## 8) Безопасность (обязательно)

- Никогда не коммитьте `.env`.
- Не публикуйте вывод `docker compose config` (там видны секреты).
- Ротируйте `BOT_TOKEN` и `REMNAWAVE_API_TOKEN` при подозрении на утечку.
- Ограничьте доступ к серверу (firewall, SSH keys).

---

## 9) Troubleshooting

Если контейнер не стартует:

```bash
docker compose logs -f --tail=300
```

Если `unhealthy`:

```bash
docker compose ps
docker compose logs -f --tail=200
```

Проверьте:

- валидность `BOT_TOKEN`
- корректность `REMNAWAVE_BASE_URL`
- рабочий `REMNAWAVE_API_TOKEN`
- существование/доступность `PUBLIC` internal squad

Если ошибка `SQLITE_CANTOPEN`:

```bash
mkdir -p data/backups
chmod 775 data data/backups
docker compose down
docker compose up -d --build
```

---

## Документация

- [Remnawave API](https://docs.rw/api)
