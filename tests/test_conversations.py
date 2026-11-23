import tempfile
import unittest
from pathlib import Path

from packages.agent.conversations import Conversations


class ConversationTests(unittest.TestCase):
    def test_turns_are_scoped_ordered_and_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = Conversations(root, 'p', 'alice')
            chat, first, second = 'a' * 32, 'b' * 32, 'c' * 32
            reply = {'text': '回复', 'tool': 'oer', 'mode': 'local'}
            store.append(chat, first, 0, '解释析氧', reply)
            store.append(chat, first, 0, '解释析氧', reply)
            with self.assertRaises(ValueError):
                store.append(chat, second, 0, '过期请求', reply)
            store.append(chat, second, 1, '继续', reply)
            self.assertEqual(len(Conversations(root, 'p', 'alice').read(chat)), 2)
            self.assertEqual(store.list()[0]['title'], '解释析氧')
            for other in (Conversations(root, 'p', 'bob'), Conversations(root, 'q', 'alice')):
                self.assertEqual(other.list(), [])
                self.assertEqual(other.read(chat), [])
