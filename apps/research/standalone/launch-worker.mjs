// The HTTP site, workspace and queue credentials belong exclusively to this app.
import {readFile,writeFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {createInterface} from 'node:readline'
import {once} from 'node:events'
import {parseEnv} from 'node:util'
import {runWorker,workerConfig} from './worker.mjs'

const base=join(homedir(),'mlcc-independent')
const shared=parseEnv(await readFile(join(base,'config/worker.env'),'utf8'))
const controller=new AbortController()
const input=createInterface({input:process.stdin})
input.once('close',()=>controller.abort())
const [token]=await once(input,'line')
if(!/^[a-f0-9]{64}$/.test(token)) throw Error('Missing isolated queue token')
const site=JSON.parse(await readFile(shared.MLCC_SITE_CONFIG,'utf8'))
const root=join(homedir(),'projects/catalysis-agent/jobs/research-studio')
site.workspace={...site.workspace,local:root,remote_root:join(root,'slurm')}
const privateSite=new URL('./site.json',import.meta.url)
await writeFile(privateSite,JSON.stringify(site),{flag:'wx',mode:0o600})
const config=workerConfig({...shared,MLCC_SITE_CONFIG:privateSite.pathname,MLCC_WORKSPACE_ROOT:join(root,'chats'),
  MLCC_API_ORIGIN:'http://127.0.0.1:25872/api',MLCC_WORKER_TOKEN:token,MLCC_WORKER_ID:'catalysis-v100'})
for(const signal of ['SIGTERM','SIGINT','SIGHUP']) process.once(signal,()=>controller.abort())
await runWorker(config,{signal:controller.signal})
