#!/bin/zsh
cd "$(dirname "$0")" || exit 1
if [[ ! -x .venv/bin/python ]]; then
  print 'Создайте окружение по инструкции README.md.'
  read '?Нажмите Enter для выхода.'
  exit 1
fi
exec .venv/bin/python run_app.py
