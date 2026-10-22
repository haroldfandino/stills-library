import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { rpcCall } from './service/rpc';

function usage(): never {
  process.stderr.write(`Stills Library CLI\n\nCommands:\n  projects [--json]\n  prepare <filmkraft|screenbridge> <project-id> [--json]\n  status [session-id] [--json]\n  resume <session-id> [--json]\n  login\n  configure-google <desktop-oauth-client-id>\n  set-source <filmkraft|screenbridge> <folder>\n  set-project-source <session-id> <folder>\n`);
  process.exit(2);
}

async function launchApp(): Promise<void> {
  const explicit = process.env.STILLS_LIBRARY_APP_EXECUTABLE;
  let command: string;
  let args: string[] = [];
  if (explicit) {
    command = explicit;
  } else {
    const root = path.resolve(__dirname, '..');
    const devElectron = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
    if (!fs.existsSync(devElectron)) throw new Error('App is not running. Set STILLS_LIBRARY_APP_EXECUTABLE to the installed app path.');
    command = devElectron;
    args = [root];
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true, env });
  child.unref();
}

async function call(method: string, args: unknown[] = []): Promise<unknown> {
  try { return await rpcCall(method, args); } catch (first) {
    if (!/ENOENT|ECONNREFUSED|connect/i.test(String(first))) throw first;
    await launchApp();
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      try { return await rpcCall(method, args); } catch (error) {
        if (!/ENOENT|ECONNREFUSED|connect/i.test(String(error))) throw error;
      }
    }
    throw new Error('Could not connect to Stills Library after launching it.');
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const args = argv.filter(a => a !== '--json');
  const command = args.shift();
  let result: unknown;
  switch (command) {
    case 'projects': result = await call('listProjects'); break;
    case 'prepare':
      if (!args[0] || !args[1]) usage();
      result = await call('prepare', [args[0], args[1]]); break;
    case 'status': result = await call(args[0] ? 'getSession' : 'getState', args[0] ? [args[0]] : []); break;
    case 'resume':
      if (!args[0]) usage();
      result = await call('resume', [args[0]]); break;
    case 'login': result = await call('signIn'); break;
    case 'configure-google':
      if (!args[0]) usage();
      result = await call('configureGoogle', [args[0]]); break;
    case 'set-source':
      if (!args[0] || !args[1]) usage();
      result = await call('setSource', [args[0], args[1]]); break;
    case 'set-project-source':
      if (!args[0] || !args[1]) usage();
      result = await call('setProjectSource', [args[0], args[1]]); break;
    default: usage();
  }
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else if (typeof result === 'string') process.stdout.write(`${result}\n`);
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
