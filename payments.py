"""Minimal server-side Platega adapter. Merchant credentials never reach the browser."""
from __future__ import annotations

import hmac
import json
import re
import urllib.error
import urllib.request
from urllib.parse import urlsplit
import uuid


PLATEGA_TRANSACTION_ENDPOINT = "https://app.platega.io/transaction/process"


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
            "method": "sbp",
            "message": ("Оплата через Platega готова" if self.enabled else
                        "Для покупки нужно подключить магазин Platega"),
        }

    def valid_callback(self, merchant_id, secret):
        return (self.enabled and isinstance(merchant_id, str) and isinstance(secret, str)
                and hmac.compare_digest(merchant_id, self.merchant_id)
                and hmac.compare_digest(secret, self.secret))

    def create_checkout(self, amount_rubles, plan_title="Адым Плюс", *, buyer_email=None):
        if not self.enabled:
            raise ValueError("Оплата ещё не подключена. Добавьте данные магазина Platega.")
        amount = int(amount_rubles)
        if not 0 < amount <= 10_000:
            raise ValueError("Некорректная стоимость подписки.")
        if (not isinstance(buyer_email, str) or len(buyer_email) > 254
                or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", buyer_email)):
            raise ValueError("Для оплаты нужна действующая почта покупателя.")
        body = json.dumps({
            "metadata": {"user_email": buyer_email},
            "paymentMethod": 2,
            "paymentDetails": {
                "amount": amount,
                "currency": "RUB",
            },
            "description": f"{plan_title} — доступ на 30 дней",
            "return": "https://app.adym.ru/?payment=return",
            "failedUrl": "https://app.adym.ru/?payment=failed",
        }, ensure_ascii=False).encode("utf-8")
        result = self._request(PLATEGA_TRANSACTION_ENDPOINT, body)
        provider_id = result.get("transactionId")
        redirect = result.get("redirect") or result.get("url")
        try:
            provider_id = str(uuid.UUID(provider_id))
        except (ValueError, TypeError, AttributeError):
            raise ValueError("Platega не вернула идентификатор платежа.") from None
        target = urlsplit(redirect) if isinstance(redirect, str) else None
        if not target or target.scheme != "https" or target.netloc != "pay.platega.io":
            raise ValueError("Platega вернула небезопасную ссылку оплаты.")
        return {"provider_id": provider_id, "redirect": redirect, "status": "pending"}

    def checkout_status(self, provider_id):
        provider_id = str(uuid.UUID(provider_id))
        result = self._request(f"https://app.platega.io/transaction/{provider_id}")
        details = result.get("paymentDetails")
        if not isinstance(details, dict):
            raise ValueError("Platega не вернула данные предыдущего платежа.")
        return result.get("status"), details.get("amount"), details.get("currency")

    def _request(self, url, body=None):
        request = urllib.request.Request(
            url, data=body, headers={
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
            raise ValueError(f"Platega временно недоступна (код {exc.code}).") from None
        except (urllib.error.URLError, TimeoutError):
            raise ValueError("Не удалось связаться с Platega. Повторите позже.") from None
        except json.JSONDecodeError:
            raise ValueError("Platega вернула некорректный ответ.") from None
        if not isinstance(result, dict):
            raise ValueError("Platega вернула некорректный ответ.")
        return result
