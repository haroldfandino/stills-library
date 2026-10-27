import fs from 'node:fs/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import { dataDir, rpcTokenPath, socketPath } from '../shared/runtime';

export interface RpcRequest { id: string; token: string; method: string; args?: unknown[]; }
export interface RpcResponse { id: string; ok: boolean; result?: unknown; error?: string; }
export type RpcDispatch = (method: string, args: unknown[]) => Promise<unknown>;

export async function startRpcServer(dispatch: RpcDispatch): Promise<net.Server> {
  await fs.mkdir(dataDir(), { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(32).toString('hex');
  await fs.writeFile(rpcTokenPath(), token, { mode: 0o600 });
  const address = socketPath();
  if (process.platform !== 'win32') {
    try { await fs.unlink(address); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    // A CLI can exit while an extraction is still running. Its disconnected
    // pipe must never turn an eventual response into an uncaught app error.
    socket.on('error', () => { socket.destroy(); });
    const respond = (response: RpcResponse) => {
      if (socket.writable && !socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
    };
    let buffer = '';
    socket.on('data', data => {
      buffer += data;
      if (buffer.length > 1024 * 1024) { socket.destroy(); return; }
      let breakAt: number;
      while ((breakAt = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, breakAt);
        buffer = buffer.slice(breakAt + 1);
        void (async () => {
          let id = '';
          try {
            const request = JSON.parse(line) as RpcRequest;
            if (!request || typeof request.id !== 'string' || !request.id
                || typeof request.method !== 'string' || !request.method) throw new Error('Invalid local CLI request');
            id = request.id;
            if (request.token !== token) throw new Error('Unauthorized local CLI request');
            const result = await dispatch(request.method, Array.isArray(request.args) ? request.args : []);
            respond({ id, ok: true, result });
          } catch (error) {
            respond({ id, ok: false, error: String((error as Error).message ?? error) });
          }
        })();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, () => { server.off('error', reject); resolve(); });
  });
  if (process.platform !== 'win32') await fs.chmod(address, 0o600);
  return server;
}

export async function rpcCall(method: string, args: unknown[] = []): Promise<unknown> {
  const token = (await fs.readFile(rpcTokenPath(), 'utf8')).trim();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath());
    const id = crypto.randomUUID();
    let buffer = '';
    let settled = false;
    const finish = (error?: unknown, result?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    socket.setEncoding('utf8');
    socket.once('error', error => finish(error));
    socket.once('close', () => finish(new Error('The Stills Library app closed before responding. Open the app and check session status before retrying.')));
    socket.once('connect', () => socket.write(`${JSON.stringify({ id, token, method, args } satisfies RpcRequest)}\n`));
    socket.on('data', data => {
      buffer += data;
      // Full queue status includes previews for every retained review session.
      // Large multi-video projects can legitimately exceed 32 MiB.
      if (buffer.length > 128 * 1024 * 1024) {
        finish(new Error('Local CLI response exceeded the size limit.'));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as RpcResponse;
        if (!response || response.id !== id || typeof response.ok !== 'boolean') {
          throw new Error('Invalid local CLI response.');
        }
        if (!response.ok) finish(new Error(response.error ?? 'RPC failed'));
        else finish(undefined, response.result);
      } catch (error) { finish(error); }
    });
  });
}
