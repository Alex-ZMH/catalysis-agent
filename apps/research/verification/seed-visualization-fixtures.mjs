// Engineering fixtures only. Never submits a model request or scientific job.
import { mkdir, readFile, readdir, writeFile, chmod } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { MlccStore } from '../standalone/store.mjs';
import { readArtifact } from '../standalone/worker.mjs';

const dataDir=process.env.DATA_DIR;
const receiptPath=process.env.RECEIPT_PATH;
if(!dataDir||!receiptPath)throw new Error('Set DATA_DIR and a private RECEIPT_PATH.');
const fixtures=join(dirname(fileURLToPath(import.meta.url)),'visualization-fixtures');
const names=(await readdir(fixtures)).filter(name=>name!=='README.txt').sort();
const files=await Promise.all(names.map(async name=>({name,...await readArtifact(fixtures,name)})));
const store=new MlccStore({dataDir:resolve(dataDir)});
try {
  if(store.db.prepare('select count(*) as count from users').get().count>0&&process.env.ALLOW_EXISTING_TEST_DATA!=='1')throw new Error('Refusing existing database. Explicit ALLOW_EXISTING_TEST_DATA=1 requires the web service to be stopped.');
  if(store.db.prepare("select count(*) as count from runs where status in ('queued','running')").get().count>0)throw new Error('Refusing to seed while work is unfinished.');
  const account={contact:`visualization-${randomUUID()}@example.invalid`,name:'可视化验收',password:randomBytes(24).toString('base64url')};
  const user=store.createUser(account);
  const chat=store.createChat(user.id,'可视化工程验收 · 非科研结果');
  const workerId='visualization-engineering-fixture';
  store.heartbeat(workerId,true);
  const {run}=store.createRun(user.id,chat.id,randomUUID(),'查看可视化格式工程测试；以下全部是格式夹具，不是实际科研计算结果。');
  const job=store.claimJob(workerId);
  if(job.id!==run.id)throw new Error('Unexpected job: seeding requires a quiescent service.');
  const artifacts=[];
  for(const file of files){
    const {artifact}=store.uploadArtifact(job.id,job.leaseToken,{artifactId:createHash('sha256').update(file.name).digest('hex'),...file});
    artifacts.push(artifact);
  }
  store.appendWorkerEvents(job.id,job.leaseToken,[{eventId:'engineering-summary',type:'assistant.delta',text:'可视化工程验收附件：覆盖结构、轨迹、体数据、能带、态密度、图片和文档。所有文件均为格式与交互测试夹具，不是实际科研结果。点击附件即可查看。'},{eventId:'engineering-completed',type:'run.completed'}]);
  store.heartbeat(workerId,false);
  await mkdir(dirname(resolve(receiptPath)),{recursive:true,mode:0o700});
  await writeFile(receiptPath,JSON.stringify({account,userId:user.id,chatId:chat.id,runId:run.id,artifacts},null,2)+'\n',{mode:0o600});
  await chmod(receiptPath,0o600);
  console.log(JSON.stringify({chatId:chat.id,artifactCount:artifacts.length,receiptPath,scientificCalculationSubmitted:false}));
}finally{store.close();}
