// Run only while the standalone web/worker are stopped. Engineering account only.
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { MlccStore } from '../standalone/store.mjs';

const { DATA_DIR, RECEIPT_PATH, EXISTING_RECEIPT } = process.env;
if (!DATA_DIR || !RECEIPT_PATH) throw new Error('Private DATA_DIR and RECEIPT_PATH are required');
const store = new MlccStore({ dataDir: resolve(DATA_DIR) });
try {
  if (store.db.prepare("SELECT count(*) AS count FROM runs WHERE status IN ('running','queued')").get().count) throw new Error('Unfinished work: refusing to seed');
  let account, userId;
  if (EXISTING_RECEIPT) {
    ({ account, userId } = JSON.parse(await readFile(EXISTING_RECEIPT, 'utf8')));
    if (!store.db.prepare('SELECT id FROM users WHERE id=?').get(userId)) throw new Error('Engineering account not found');
  } else {
    if (store.db.prepare('SELECT count(*) AS count FROM users').get().count) throw new Error('Existing database requires a private engineering receipt');
    account = { contact: `parity-${randomUUID()}@example.invalid`, name: '结果链路验收', password: randomBytes(24).toString('base64url') };
    userId = store.createUser(account).id;
  }
  const chat = store.createChat(userId, '结果链路工程验收 · 非科研结果');
  const workerId = 'parity-engineering-fixture';
  store.heartbeat(workerId, true);
  const { run } = store.createRun(userId, chat.id, randomUUID(), '验证自动收集、大文件和文件预览。所有附件均为工程夹具，不是科研计算结果。');
  const job = store.claimJob(workerId);
  if (job?.id !== run.id) throw new Error('Unexpected claimed job');
  await mkdir(dirname(resolve(RECEIPT_PATH)), { recursive: true, mode: 0o700 });
  await writeFile(RECEIPT_PATH, JSON.stringify({ account, userId, chatId: chat.id, runId: run.id, workerId, job, artifacts: [] }, null, 2) + '\n', { mode: 0o600 });
  await chmod(RECEIPT_PATH, 0o600);
  console.log(JSON.stringify({ runId: run.id, chatId: chat.id, engineeringOnly: true }));
} finally { store.close(); }
