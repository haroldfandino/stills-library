import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const paths = vi.hoisted(() => ({ directory: '', address: '' }));
vi.mock('../shared/runtime', () => ({
  dataDir: () => paths.directory,
  rpcTokenPath: () => `${paths.directory}/rpc-token`,
  socketPath: () => paths.address,
}));
import { rpcCall, startRpcServer } from './rpc';

let server: net.Server | undefined;
const clients = new Set<net.Socket>();

beforeEach(async () => {
  paths.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stills-rpc-'));
  paths.address = process.platform === 'win32'
    ? `\\\\.\\pipe\\stills-library-test-${randomUUID()}`
    : path.join(paths.directory, 'service.sock');
});

afterEach(async () => {
  for (const socket of clients) socket.destroy();
  clients.clear();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  await fs.rm(paths.directory, { recursive: true, force: true });
});

async function fakeServer(handle: (socket: net.Socket) => void) {
  await fs.writeFile(path.join(paths.directory, 'rpc-token'), 'test-token');
  server = net.createServer(socket => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    handle(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(paths.address, resolve);
  });
}

describe('local service connection', () => {
  test('returns large retained review histories over the local pipe', async () => {
    const history = 'x'.repeat(33 * 1024 * 1024);
    server = await startRpcServer(async () => ({ history }));
    expect((await rpcCall('getState') as { history: string }).history).toBe(history);
  });

  test('returns a response through the local Windows pipe or Unix socket', async () => {
    server = await startRpcServer(async (method, args) => ({ method, args }));
    expect(await rpcCall('status', ['session-1'])).toEqual({ method: 'status', args: ['session-1'] });
  });

  test('rejects instead of hanging if the app closes without a response', async () => {
    await fakeServer(socket => socket.on('data', () => socket.end()));
    await expect(rpcCall('status')).rejects.toThrow(/closed before responding/);
  });

  test('rejects a response for a different request', async () => {
    await fakeServer(socket => socket.on('data', () => {
      socket.end(`${JSON.stringify({ id: 'wrong-request', ok: true, result: 'unexpected' })}\n`);
    }));
    await expect(rpcCall('status')).rejects.toThrow(/Invalid local CLI response/);
  });

  test('keeps the service alive if the CLI disconnects during a long operation', async () => {
    let finishWork!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { finishWork = resolve; });
    const dispatched = new Promise<void>(resolve => { started = resolve; });
    server = await startRpcServer(async method => {
      if (method === 'prepare') { started(); await waiting; }
      return 'ready';
    });
    const token = await fs.readFile(path.join(paths.directory, 'rpc-token'), 'utf8');
    const socket = net.createConnection(paths.address);
    clients.add(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.once('connect', resolve);
    });
    socket.write(`${JSON.stringify({ id: 'closing-client', token, method: 'prepare' })}\n`);
    await dispatched;
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
    socket.destroy();
    await closed;
    finishWork();
    expect(await rpcCall('status')).toBe('ready');
  });
});
