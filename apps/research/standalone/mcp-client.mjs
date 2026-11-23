import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export function childEnvironment(config, source = process.env) {
  const env = {}
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) if (source[key]) env[key] = source[key]
  return { ...env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1',
    MLCC_SITE_CONFIG: config.siteConfig, MLCC_WORKSPACE_ROOT: config.workspaceRoot }
}

export class McpClient {
  constructor({command, args, cwd, env, signal}) {
    this.nextId = 1; this.pending = new Map(); this.closed = false
    this.child = spawn(command, args, {cwd, env, stdio: ['pipe', 'pipe', 'pipe']})
    // Python MCP emits one JSON-RPC message per UTF-8 line. Diagnostics must never
    // become user output or unbounded process buffers.
    this.child.stderr.on('data', () => {})
    this.child.stdin.on('error', () => {this.fail(new Error('MLCC tool input failed'));this.close()})
    this.lines = createInterface({input: this.child.stdout})
    this.lines.on('line', line => {
      if (Buffer.byteLength(line) > 8 * 1024 * 1024) { this.close(); return }
      let message; try {message = JSON.parse(line)} catch {this.fail(new Error('Invalid MCP response')); return}
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer); this.pending.delete(message.id)
      if (message.error) pending.reject(new Error('MLCC tool protocol error'))
      else pending.resolve(message.result)
    })
    this.child.on('error', () => this.fail(new Error('MLCC tool process could not start')))
    this.child.on('close', () => {this.closed = true; this.fail(new Error('MLCC tool process ended'))})
    this.abort = () => this.close(); this.signal = signal
    signal?.addEventListener('abort', this.abort, {once: true})
  }
  fail(error) { for (const pending of this.pending.values()) {clearTimeout(pending.timer);pending.reject(error)} this.pending.clear() }
  async request(method, params = {}, timeout = 180_000) {
    if (this.closed || this.signal?.aborted) throw new Error('MLCC tool request aborted')
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {this.pending.delete(id);reject(new Error('MLCC tool timed out; execution state needs checking'));this.close()}, timeout)
      this.pending.set(id, {resolve, reject, timer})
      this.child.stdin.write(JSON.stringify({jsonrpc:'2.0', id, method, params})+'\n', error => {
        if (error) this.fail(new Error('MLCC tool input failed'))
      })
    })
  }
  async initialize() {
    await this.request('initialize', {protocolVersion:'2025-03-26', capabilities:{}, clientInfo:{name:'mlcc-independent',version:'1.0.0'}}, 30_000)
    this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n')
    const tools = []; let cursor
    do { const page = await this.request('tools/list', cursor ? {cursor} : {}, 30_000); tools.push(...page.tools); cursor = page.nextCursor } while (cursor)
    return tools
  }
  call(name, args) {return this.request('tools/call',{name,arguments:args})}
  close() {
    if (this.closed) return
    this.closed = true;this.signal?.removeEventListener('abort',this.abort)
    this.fail(new Error('MLCC tool request aborted'));this.lines.close();this.child.stdin.destroy()
    this.child.kill('SIGTERM')
    const timer=setTimeout(()=>this.child.kill('SIGKILL'),2000);timer.unref()
  }
}
