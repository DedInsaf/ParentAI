# Развёртывание Адым на VDS

Основное приложение работает на `app.adym.ru`; лендинг остаётся на `adym.ru` на REG.RU. Python, Whisper, базы пользователей и приватные профили находятся только на VDS.

## Что потребуется

- Ubuntu 24.04, 2 vCPU, 4 ГБ RAM и от 40 ГБ SSD для закрытой беты;
- swap 4 ГБ: локальному Whisper иногда не хватает одной оперативной памяти;
- A-запись `app.adym.ru` на публичный IPv4 VDS;
- входящие порты 22, 80 и 443. Внутренний порт 8768 наружу не открывать;
- рабочие `YANDEX_API_KEY` и `YANDEX_FOLDER_ID`. Platega можно добавить позже.

На 2 vCPU ответы Whisper и YandexGPT подходят для небольшой закрытой беты, но одновременные голосовые вопросы будут ждать CPU. XTTS на этом сервере и в коммерческой бете не включать.

## 1. Подготовка Ubuntu

Выполните от пользователя с `sudo`:

```bash
sudo apt update
sudo apt install -y git python3-venv python3-pip ffmpeg curl gnupg debian-keyring debian-archive-keyring apt-transport-https
sudo useradd --system --home-dir /opt/adym --shell /usr/sbin/nologin adym
sudo install -d -o adym -g adym -m 750 /opt/adym
sudo -u adym git clone https://github.com/DedInsaf/ParentAI.git /opt/adym
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Если `/swapfile` уже существует, четыре команды его создания пропустите и проверьте `swapon --show`.

Установите стабильный Caddy из официального репозитория:

```bash
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

Если используется UFW:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

## 2. Установка приложения и моделей

Все следующие команды загрузки выполняются от `adym`, чтобы файлы не принадлежали `root`:

```bash
sudo -u adym python3 -m venv /opt/adym/.venv
sudo -u adym /opt/adym/.venv/bin/pip install --upgrade pip
sudo -u adym /opt/adym/.venv/bin/pip install -r /opt/adym/requirements.txt
sudo -u adym /opt/adym/.venv/bin/python /opt/adym/download_assets.py
sudo -u adym /opt/adym/.venv/bin/python /opt/adym/setup_speech.py
```

`setup_speech.py` загружает около 1 ГБ весов Whisper в `data/models`. Без этого локальное распознавание не будет готово, а приложение начнёт зависеть от резервного SpeechKit.

## 3. Секретные настройки

```bash
sudo -u adym cp /opt/adym/parentai.env.example /opt/adym/parentai.env
sudo chmod 600 /opt/adym/parentai.env
sudo -u adym nano /opt/adym/parentai.env
```

Минимальная конфигурация закрытой беты:

```dotenv
PARENTAI_BIND=127.0.0.1
PARENTAI_PUBLIC_ORIGIN=https://app.adym.ru
PARENTAI_INVITE_CODE=длинный-случайный-код-не-короче-16-символов
PARENTAI_GLOBAL_DAILY_BUDGET_RUBLES=300
PARENTAI_GLOBAL_MONTHLY_BUDGET_RUBLES=3000
PARENTAI_TUTOR_MODEL=yandexgpt-5.1
PARENTAI_STT_ENGINE=local
PARENTAI_STT_MODEL=openai/whisper-small
PARENTAI_ENABLE_XTTS=0
YANDEX_API_KEY=ваш-ключ
YANDEX_FOLDER_ID=ваш-id-каталога
YANDEX_TTS_API_KEY=
YANDEX_SPEECHKIT_API_KEY=
PLATEGA_MERCHANT_ID=
PLATEGA_SECRET=
```

Ключ SpeechKit можно оставить пустым, если основной ключ Яндекса имеет разрешения TTS/STT. Реквизиты Platega задаются только парой и только после выдачи рабочего магазина. Проверка не выводит значения секретов:

```bash
sudo -u adym /opt/adym/.venv/bin/python /opt/adym/scripts/preflight.py --production
```

## 4. Автозапуск, HTTPS и резервные копии

```bash
sudo install -m 644 /opt/adym/deploy/adym.service /etc/systemd/system/adym.service
sudo install -m 644 /opt/adym/deploy/adym-backup.service /etc/systemd/system/adym-backup.service
sudo install -m 644 /opt/adym/deploy/adym-backup.timer /etc/systemd/system/adym-backup.timer
sudo install -m 644 /opt/adym/deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo install -d -o adym -g adym -m 700 /var/backups/adym
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl daemon-reload
sudo systemctl enable --now adym adym-backup.timer
sudo systemctl reload caddy
```

Caddy автоматически получает и обновляет доверенный TLS-сертификат, когда A-запись уже указывает на VDS и порты 80/443 доступны. Камера и микрофон в браузере требуют такого HTTPS.

Создайте администратора без продуктовых лимитов и сохраните показанный пароль в менеджере паролей:

```bash
cd /opt/adym
sudo -u adym .venv/bin/python manage_users.py create-admin --login admin --email ВАША_ПОЧТА --generate-password
```

## 5. Проверка перед приглашением людей

```bash
systemctl status adym caddy adym-backup.timer --no-pager
curl https://app.adym.ru/api/health
cd /opt/adym
sudo -u adym .venv/bin/python scripts/smoke_test.py https://app.adym.ru
sudo systemctl start adym-backup.service
sudo -u adym test -n "$(find /var/backups/adym -name 'adym-*.tar.gz' -print -quit)"
```

Ожидаемый health: `{"ok":true,"service":"adym"}`. Затем в обычном окне актуального Chrome или Edge проверьте: регистрацию по коду, вход, создание аватара, разрешения камеры/микрофона, текстовый и голосовой вопрос, завершение занятия и вход администратора.

Логи при ошибке:

```bash
journalctl -u adym -n 200 --no-pager
journalctl -u caddy -n 200 --no-pager
```

## Резервные копии

Таймер ежедневно делает согласованные копии SQLite и семейных профилей в `/var/backups/adym`, оставляя 14 архивов. Это защищает от ошибки обновления, но не от потери VDS: настройте вторую зашифрованную копию у другого провайдера. Папку `data/` с компьютера разработчика на сервер не переносите — в ней тестовые аккаунты, голос и аватар.

Раз в месяц проверяйте восстановление архива на отдельной временной машине. Наличие архива ещё не гарантирует, что процесс восстановления отработан.

## Безопасное обновление

```bash
sudo systemctl start adym-backup.service
cd /opt/adym
sudo -u adym git pull --ff-only
sudo -u adym .venv/bin/pip install -r requirements.txt
sudo -u adym .venv/bin/python download_assets.py
sudo -u adym .venv/bin/python setup_speech.py
sudo -u adym .venv/bin/python scripts/preflight.py --production
sudo systemctl restart adym
sudo -u adym .venv/bin/python scripts/smoke_test.py https://app.adym.ru
```

Для включения реальной оплаты добавьте реквизиты Platega, прогоните preflight с `--require-payments`, перезапустите приложение и укажите callback `https://app.adym.ru/api/webhooks/platega` в личном кабинете Platega.
