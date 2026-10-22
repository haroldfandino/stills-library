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
            id = request.id;
            if (request.token !== token) throw new Error('Unauthorized local CLI request');
            const result = await dispatch(request.method, Array.isArray(request.args) ? request.args : []);
            socket.write(`${JSON.stringify({ id, ok: true, result } satisfies RpcResponse)}\n`);
          } catch (error) {
            socket.write(`${JSON.stringify({ id, ok: false, error: String((error as Error).message ?? error) } satisfies RpcResponse)}\n`);
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
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.once('connect', () => socket.write(`${JSON.stringify({ id, token, method, args } satisfies RpcRequest)}\n`));
    socket.on('data', data => {
      buffer += data;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      socket.end();
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as RpcResponse;
        if (!response.ok) reject(new Error(response.error ?? 'RPC failed'));
        else resolve(response.result);
      } catch (error) { reject(error); }
    });
  });
}
