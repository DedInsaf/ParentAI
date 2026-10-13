import json
import unittest

from payments import PlategaClient, PLATEGA_SUBSCRIPTION_ENDPOINT


class PlategaTests(unittest.TestCase):
    def test_subscription_request_and_safe_redirect(self):
        seen = {}
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self, _):
                return json.dumps({
                    'transactionId': '11111111-1111-4111-8111-111111111111',
                    'redirect': 'https://pay.platega.io/subscription/11111111',
                    'status': 'PENDING',
                }).encode()
        def opener(request, timeout):
            seen['url'], seen['body'], seen['headers'], seen['timeout'] = (
                request.full_url, json.loads(request.data),
                {key.lower(): value for key, value in request.headers.items()}, timeout)
            return Response()
        client = PlategaClient('merchant-id', 'secret-key', opener)
        result = client.create_subscription(299)
        self.assertEqual(seen['url'], PLATEGA_SUBSCRIPTION_ENDPOINT)
        self.assertEqual(seen['timeout'], 25)
        self.assertEqual(seen['headers']['x-merchantid'], 'merchant-id')
        self.assertEqual(seen['headers']['x-secret'], 'secret-key')
        self.assertEqual(seen['body']['paymentMethod'], 6)
        self.assertEqual(seen['body']['paymentDetails'], {
            'amount': 299, 'currency': 'RUB', 'interval': 3, 'intervalCount': 1})
        self.assertEqual(result['status'], 'pending')

    def test_credentials_and_redirect_are_validated(self):
        client = PlategaClient('merchant', 'secret')
        self.assertTrue(client.valid_callback('merchant', 'secret'))
        self.assertFalse(client.valid_callback('merchant', 'wrong'))
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self, _):
                return json.dumps({'transactionId':'11111111-1111-4111-8111-111111111111',
                                   'redirect':'https://example.com/phishing'}).encode()
        with self.assertRaisesRegex(ValueError, 'небезопасную'):
            PlategaClient('merchant', 'secret', lambda *_args, **_kwargs: Response()).create_subscription(299)

    def test_provider_transaction_limit_is_enforced_before_network_request(self):
        called = False
        def opener(*_args, **_kwargs):
            nonlocal called
            called = True
        client = PlategaClient('merchant', 'secret', opener)
        with self.assertRaisesRegex(ValueError, 'стоимость'):
            client.create_subscription(10_001)
        self.assertFalse(called)


if __name__ == '__main__':
    unittest.main()
