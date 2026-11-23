"""Project- and operator-scoped conversational records, separate from scientific evidence."""
from contextlib import closing, contextmanager
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess

from packages.agent.model_broker import ModelUnavailable


class Conversations:
    def __init__(self, root, project, operator):
        directory = root / 'conversations'
        directory.mkdir(mode=0o700, exist_ok=True)
        self.path = directory / 'history.sqlite3'
        self.scope = (project, operator)

    @contextmanager
    def connection(self):
        with closing(sqlite3.connect(self.path, timeout=8)) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS turns (project TEXT, operator TEXT, chat TEXT, '
                       'seq INTEGER, token TEXT, question TEXT, answer TEXT, '
                       'PRIMARY KEY(project,operator,chat,seq), UNIQUE(project,operator,chat,token))')
            yield db

    def list(self):
        with self.connection() as db:
            rows = db.execute('SELECT chat, MAX(CASE WHEN seq=0 THEN question END), MAX(rowid) FROM turns '
                              'WHERE project=? AND operator=? GROUP BY chat ORDER BY 3 DESC LIMIT 100', self.scope)
            return [dict(id=chat, title=title[:80]) for chat, title, _ in rows]

    def read(self, chat):
        with self.connection() as db:
            rows = db.execute('SELECT token,question,answer FROM turns WHERE project=? AND operator=? AND chat=? '
                              'ORDER BY seq', (*self.scope, chat))
            return [dict(id=token, question=question, reply=json.loads(answer)) for token, question, answer in rows]

    def append(self, chat, token, expected, question, reply):
        with self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            scope = (*self.scope, chat)
            row = db.execute('SELECT question FROM turns WHERE project=? AND operator=? AND chat=? AND token=?',
                             (*scope, token)).fetchone()
            if row and row[0] == question:
                return
            count = db.execute('SELECT COUNT(*) FROM turns WHERE project=? AND operator=? AND chat=?', scope).fetchone()[0]
            if row or expected != count or count >= 100:
                raise ValueError('对话已更新或达到 100 轮，请重新打开对话或新建对话。')
            db.execute('INSERT INTO turns VALUES (?,?,?,?,?,?,?)',
                       (*scope, expected, token, question, json.dumps(reply, ensure_ascii=False)))


def answer(question, turns, broker, token, stopped):
    history = turns[-12:]
    if getattr(broker, 'allow_planner', False):
        messages = []
        for turn in history:
            messages.extend([{'role': 'user', 'content': turn['question']},
                             {'role': 'assistant', 'content': turn['reply']['text'][:4000]}])
        return broker.call({'mode': 'chat', 'token': token, 'question': question, 'messages': messages,
                            'previous': history[-1]['reply'] if history else None}, stopped=stopped)['reply']
    node = shutil.which(os.environ.get('CATALYSIS_NODE', 'node'))
    if not node:
        raise ModelUnavailable('服务端对话需要 Node.js 22.18+。也可直接打开离线版，无需安装。')
    script = Path(__file__).resolve().parents[2] / 'apps/web/electrochem/chat.js'
    runner = "const {question,turns}=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(require(process.argv[1]).localReply(question,turns)))"
    result = subprocess.run([node, '-e', runner, str(script)], check=True, timeout=10, capture_output=True,
                            input=json.dumps({'question': question, 'turns': history[-1:]}), text=True, encoding='utf-8')
    return json.loads(result.stdout)
