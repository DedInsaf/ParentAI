"""Concurrent account requests with an exclusive barrier for data erasure."""
from contextlib import contextmanager
import threading


class AccountRequests:
    def __init__(self):
        self.condition = threading.Condition()
        self.readers = 0
        self.writer = False
        self.waiting_writers = 0

    @contextmanager
    def shared(self):
        with self.condition:
            self.condition.wait_for(lambda: not self.writer and not self.waiting_writers)
            self.readers += 1
        try:
            yield
        finally:
            with self.condition:
                self.readers -= 1
                self.condition.notify_all()

    @contextmanager
    def exclusive(self):
        with self.condition:
            self.waiting_writers += 1
            try:
                self.condition.wait_for(lambda: not self.writer and not self.readers)
                self.writer = True
            finally:
                self.waiting_writers -= 1
        try:
            yield
        finally:
            with self.condition:
                self.writer = False
                self.condition.notify_all()
