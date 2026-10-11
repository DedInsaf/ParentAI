"""Minimal server-side Platega adapter. Merchant credentials never reach the browser."""
from __future__ import annotations

import hmac
import json
import urllib.error
import urllib.request
from urllib.parse import urlsplit
import uuid


PLATEGA_SUBSCRIPTION_ENDPOINT = "https://app.platega.io/transaction/process"


class PlategaClient:
    def __init__(self, merchant_id="", secret="", opener=None):
        self.merchant_id = merchant_id or ""
        self.secret = secret or ""
        self.opener = opener or urllib.request.urlopen

    @property
    def enabled(self):
        return bool(self.merchant_id and self.secret)

    def public_status(self):
        return {
            "provider": "Platega",
            "enabled": self.enabled,
            "method": "recurring_sbp",
            "message": ("Оплата через Platega готова" if self.enabled else
                        "Для покупки нужно подключить магазин Platega"),
        }

    def valid_callback(self, merchant_id, secret):
        return (self.enabled and isinstance(merchant_id, str) and isinstance(secret, str)
                and hmac.compare_digest(merchant_id, self.merchant_id)
                and hmac.compare_digest(secret, self.secret))

    def create_subscription(self, amount_rubles):
        if not self.enabled:
            raise ValueError("Оплата ещё не подключена. Добавьте данные магазина Platega.")
        amount = int(amount_rubles)
        if amount <= 0:
            raise ValueError("Некорректная стоимость подписки.")
        body = json.dumps({
            "paymentMethod": 6,
            "paymentDetails": {
                "amount": amount,
                "currency": "RUB",
                "interval": 3,
                "intervalCount": 1,
            },
            "description": "Адым Paid beta — ежемесячная подписка",
        }, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            PLATEGA_SUBSCRIPTION_ENDPOINT, data=body, method="POST", headers={
                "Content-Type": "application/json",
                "X-MerchantId": self.merchant_id,
                "X-Secret": self.secret,
            })
        try:
            with self.opener(request, timeout=25) as response:
                result = json.loads(response.read(1_000_000))
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                raise ValueError("Platega отклонила данные магазина. Проверьте Merchant ID и API-ключ.") from None
            raise ValueError(f"Platega временно не создаёт подписку (код {exc.code}).") from None
        except (urllib.error.URLError, TimeoutError):
            raise ValueError("Не удалось связаться с Platega. Повторите позже.") from None
        except json.JSONDecodeError:
            raise ValueError("Platega вернула некорректный ответ.") from None
        provider_id = result.get("transactionId")
        redirect = result.get("redirect") or result.get("url")
        try:
            uuid.UUID(provider_id)
        except (ValueError, TypeError, AttributeError):
            raise ValueError("Platega не вернула идентификатор подписки.") from None
        target = urlsplit(redirect or "")
        if target.scheme != "https" or target.hostname != "pay.platega.io":
            raise ValueError("Platega вернула небезопасную ссылку оплаты.")
        return {"provider_id": provider_id, "redirect": redirect, "status": "pending"}
