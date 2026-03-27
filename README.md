# OBSYDO VPN Telegram Shop Bot

Готовый Telegram-бот-магазин для продажи VPN OBSYDO на базе Remnawave с оплатой через Telegram Stars (`XTR`).

## Что реализовано

- Витрина тарифов в боте (`/plans`, кнопки покупки)
- Оплата Telegram Stars через `sendInvoice` (`currency: XTR`)
- Автоматическая выдача/продление доступа через Remnawave API
- Хранение товаров, заказов, статусов платежей в SQLite
- Админка в Telegram (`/admin`, управление товарами, история заказов)
- Пробный период 1 час (`/trial` или кнопка в меню)
- Уведомления о завершении подписки за 24 часа и за 1 час
- Базовый тариф проекта: 200 ⭐ / 30 дней / 300 GB
- Чистый UX: основные экраны обновляются через `editMessageText`, служебные ответы автоудаляются
- Анти-фрод: проверки валюты/суммы/статуса заказа, защита от дубликатов и алерты админу
- Расширенная админка: inline-панель + команды (`/stats`, `/orders`, `/finduser`, `/grantdays`, `/enable`, `/disable`, `/reset`, `/revoke`, `/delete`, `/broadcast`)
- Inline редактирование тарифов (цена/срок/трафик/ON-OFF) + команды `/plansadmin`, `/setprice`, `/editplan`
- Reconciliation: сверка оплаченных заказов с Remnawave по расписанию и автоисправление локального рассинхрона
- Ежедневная сводка админу в 23:00 (МСК): заказы, доход, конверсия, trial, активные подписки, надежность

## Техническая база

- Node.js + TypeScript + Telegraf
- SQLite (`better-sqlite3`)
- Интеграция с Remnawave API:
  - `POST /api/auth/login`
  - `GET /api/users/by-telegram-id/{telegramId}`
  - `POST /api/users`
  - `PATCH /api/users/{uuid}`

Если панель настроена на доступ только через API-token, задайте `REMNAWAVE_API_TOKEN` в `.env` (бот автоматически использует его вместо JWT-логина).

## Быстрый старт (Docker)

1. Клонировать репозиторий:

```bash
git clone <YOUR_GIT_URL> obsydo-vpn && cd obsydo-vpn
```

2. Создать `.env` и заполнить секреты:

```bash
cp .env.example .env
```

3. Запуск одной командой:

```bash
sh deploy.sh
```

Альтернатива через npm:

```bash
npm run docker:up
```

Логи:

```bash
npm run docker:logs
```

Проверка состояния контейнера:

```bash
docker compose ps
```

Healthcheck выполняется автоматически (`node dist/healthcheck.js`) и проверяет валидность `BOT_TOKEN` и доступность SQLite.

## Reconciliation

- Фоновая сверка запускается каждые `RECONCILE_INTERVAL_MINUTES` минут.
- Проверяются оплаченные заказы (`PAID`) и сравниваются с фактическими данными Remnawave.
- При расхождении бот автоматически обновляет локальные поля заказа (`uuid`, `shortUuid`, `subscriptionUrl`, `expiresAt`).
- Если есть проблемы/исправления, админу отправляется отчет.
- Ручной запуск: команда `/reconcile`.

## Daily Summary (23:00 МСК)

- Автоотправка админу каждый день в 23:00 по Москве.
- Сводка включает: новые/оплаченные заказы, доход в Stars, конверсию, trial, активные подписки, reconcile-статус, топ продаж и блок рисков.
- Ручной запуск для проверки: `/dailyreport`.

## Надежность БД и сохранность заказов

- SQLite настроен в режиме повышенной надежности: `WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000`.
- На уровне БД добавлено уникальное ограничение для `payment_charge_id` (исключает дубль-списания/дубль-зачисления).
- Фоновый backup запускается автоматически:
  - интервал: `DB_BACKUP_INTERVAL_MINUTES` (по умолчанию 15 минут),
  - директория: `DB_BACKUP_DIR` (по умолчанию `./backups`),
  - хранение: `DB_BACKUP_RETENTION_DAYS` (по умолчанию 14 дней).
- В `docker-compose` подключен персистентный том `./backups:/app/backups`.

## Важно по Stars

- Для Telegram Stars используется валюта `XTR`.
- Бот отправляет инвойс через `provider_token: ""` и `currency: "XTR"`.
- Цена в товарах хранится в Stars.

## Рекомендации для продакшна

- Хранить `.env` в секрете, не коммитить.
- Ограничить доступ к серверу по firewall.
- Использовать Docker restart policy (`unless-stopped` уже настроен).
- Добавить резервное копирование `shop.db`.
- Включить централизованные логи и алерты.

## Документация Remnawave

- [Remnawave API](https://docs.rw/api/)
