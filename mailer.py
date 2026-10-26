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
        message = EmailMessage()
        message['Subject'] = 'Адым — восстановление пароля'
        message['From'] = f'Адым <{self.sender}>'
        message['To'] = recipient
        message['Date'] = formatdate(localtime=False)
        message['Message-ID'] = make_msgid(domain=self.sender.split('@')[-1])
        message.set_content('Здравствуйте!\n\nЧтобы задать новый пароль в Адым, перейдите по ссылке:\n'
                            f'{link}\n\nСсылка действует 30 минут и используется один раз. '
                            'После смены пароля все сеансы входа будут завершены.\n\n'
                            'Если вы не запрашивали восстановление, просто проигнорируйте письмо. '
                            'Ваш пароль не изменится. Никому не пересылайте эту ссылку.\n\n'
                            'Поддержка: support@adym.ru\n')
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
