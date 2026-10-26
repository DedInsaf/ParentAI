"""Transactional account mail over authenticated TLS; never log reset links."""
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
import os
import smtplib
import ssl


class AccountMailer:
    def __init__(self):
        self.host = os.getenv('ADYM_SMTP_HOST', '')
        self.port = int(os.getenv('ADYM_SMTP_PORT', '465'))
        self.username = os.getenv('ADYM_SMTP_USER', '')
        self.password = os.getenv('ADYM_SMTP_PASSWORD', '')
        self.sender = os.getenv('ADYM_SMTP_FROM', self.username)

    @property
    def configured(self):
        return bool(self.host and self.username and self.password and self.sender)

    def send_reset(self, recipient, link):
        self._send(recipient, 'Адым — восстановление пароля',
                   'Здравствуйте!\n\nЧтобы задать новый пароль в Адым, перейдите по ссылке:\n'
                   f'{link}\n\nСсылка действует 30 минут и используется один раз. '
                   'После смены пароля все сеансы входа будут завершены.\n\n'
                   'Если вы не запрашивали восстановление, просто проигнорируйте письмо. '
                   'Ваш пароль не изменится. Никому не пересылайте эту ссылку.\n\n'
                   'Поддержка: support@adym.ru\n')

    def send_verification(self, recipient, link):
        self._send(recipient, 'Адым — подтвердите почту',
                   'Здравствуйте!\n\nЧтобы завершить регистрацию в Адым, перейдите по ссылке:\n'
                   f'{link}\n\nНа открывшейся странице введите пароль, который вы указали при регистрации. '
                   'Ссылка действует 24 часа и используется один раз.\n\n'
                   'Если вы не регистрировались, ничего не подтверждайте и не пересылайте ссылку. '
                   'Без подтверждения доступ к приложению закрыт.\n\nПоддержка: support@adym.ru\n')

    def _send(self, recipient, subject, body):
        message = EmailMessage()
        message['Subject'] = subject
        message['From'] = f'Адым <{self.sender}>'
        message['To'] = recipient
        message['Date'] = formatdate(localtime=False)
        message['Message-ID'] = make_msgid(domain=self.sender.split('@')[-1])
        message.set_content(body)
        context = ssl.create_default_context()
        if self.port == 465:
            connection = smtplib.SMTP_SSL(self.host, self.port, timeout=15, context=context)
        else:
            connection = smtplib.SMTP(self.host, self.port, timeout=15)
        with connection:
            if self.port != 465:
                connection.starttls(context=context)
            connection.login(self.username, self.password)
            connection.send_message(message)
