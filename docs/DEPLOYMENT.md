# Развёртывание Адым на VDS

Основное приложение размещается на `app.adym.ru`; текущий лендинг остаётся на `adym.ru`. Так общий хостинг REG.RU не должен запускать Python, Whisper и базу данных.

## Минимальный сервер для закрытой беты

- Ubuntu 24.04, 2 vCPU, 4 GB RAM, 100 GB SSD;
- файл подкачки 4 GB обязателен для локального Whisper;
- входящий доступ только к 22, 80 и 443; порт 8767 наружу не открывать;
- отдельная A-запись `app.adym.ru` на IP VDS.

## Установка

1. Создайте системного пользователя `adym` и каталог `/opt/adym`, клонируйте туда репозиторий.
2. Установите Python 3.11+, `python3-venv`, `ffmpeg` и Caddy.
3. Создайте окружение и зависимости:

   ```bash
   python3 -m venv /opt/adym/.venv
   /opt/adym/.venv/bin/pip install --upgrade pip
   /opt/adym/.venv/bin/pip install -r /opt/adym/requirements.txt
   /opt/adym/.venv/bin/python /opt/adym/download_assets.py
   ```

   Выполняйте команды от пользователя `adym`, чтобы файлы не принадлежали `root`.

4. Скопируйте `parentai.env.example` в `/opt/adym/parentai.env`. Обязательно задайте `PARENTAI_PUBLIC_ORIGIN=https://app.adym.ru`, `PARENTAI_INVITE_CODE`, лимиты бюджета и ключи Яндекса. Platega оставьте пустой до получения рабочих реквизитов.
5. Скопируйте `deploy/adym.service` в `/etc/systemd/system/adym.service`, а `deploy/Caddyfile.example` в `/etc/caddy/Caddyfile`.
6. Выполните `systemctl daemon-reload`, `systemctl enable --now adym caddy`.
7. Проверьте `https://app.adym.ru/api/health`, затем камеру и микрофон в обычном окне Chrome/Edge. Ожидаемый ответ health: `{"ok":true,"service":"adym"}`.

## Настройки закрытой беты

```dotenv
PARENTAI_BIND=127.0.0.1
PARENTAI_PUBLIC_ORIGIN=https://app.adym.ru
PARENTAI_INVITE_CODE=замените-на-длинный-случайный-код
PARENTAI_GLOBAL_DAILY_BUDGET_RUBLES=300
PARENTAI_GLOBAL_MONTHLY_BUDGET_RUBLES=3000
PARENTAI_ENABLE_XTTS=0
PARENTAI_STT_ENGINE=local
```

XTTS-v2 нельзя включать в платной бете без подходящей коммерческой лицензии. При выключенном XTTS ответы озвучиваются обычным голосом SpeechKit, а записанный голос родителя используется для заранее сохранённых напоминаний.

## Резервные копии

Команда делает согласованные копии SQLite и сохраняет отдельные профили семей:

```bash
/opt/adym/.venv/bin/python /opt/adym/scripts/backup.py --data /opt/adym/data --destination /var/backups/adym --keep 14
```

Запускайте её ежедневно через systemd timer или cron и храните вторую зашифрованную копию вне VDS. Перед обновлением также делайте ручную копию. Папку `data/` с компьютера разработчика на сервер не переносить: в ней тестовые аккаунты, голос и аватар.

## Обновление

После backup: `git pull --ff-only`, установка зависимостей и `systemctl restart adym`. Проверить `systemctl status adym`, health endpoint и вход тестового аккаунта. Настоящие платежи подключать только после проверки callback Platega по HTTPS и резервного восстановления.
