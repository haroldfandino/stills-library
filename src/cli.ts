import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { rpcCall } from './service/rpc';
import { developmentElectron } from './shared/tool-paths';

function usage(): never {
  process.stderr.write(`Stills Library CLI\n\nCommands:\n  run-queue --approve-all [--json]\n  pause-queue\n  retry-queue --approve-all [--json]\n  organize-ratios <completed-session-id> [--json]\n  grant-queue-folders\n  authorization-url\n  projects [--json]\n  prepare <filmkraft|screenbridge> <project-id> [--json]\n  status [session-id] [--json]\n  resume <session-id> [--json]\n  review-again <session-id> [--json]\n  login\n  logout\n  configure-google <desktop-oauth-client-id>\n  import-google <desktop-oauth-json-file>\n  set-source <filmkraft|screenbridge> <folder>\n  set-project-source <session-id> <folder>\n`);
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
    const devElectron = developmentElectron(root);
    command = devElectron;
    if (!fs.existsSync(devElectron) || process.env.ELECTRON_OVERRIDE_DIST_PATH) {
      const resolver = path.join(root, 'node_modules', 'electron', 'index.js');
      if (!fs.existsSync(resolver)) throw new Error('App is not running. Install dependencies with npm ci, or set STILLS_LIBRARY_APP_EXECUTABLE to the installed app path.');
      // Recent Electron packages download their runtime on first use. Keep
      // installer progress out of this CLI's machine-readable JSON output.
      command = await new Promise<string>((resolve, reject) => {
        const install = spawn(process.execPath, ['-e', 'process.stdout.write("\\nSTILLS_ELECTRON_PATH=" + JSON.stringify(require(process.argv[1])) + "\\n")', resolver], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        let errors = '';
        install.stdout.on('data', chunk => { output += chunk; });
        install.stderr.on('data', chunk => { errors += chunk; });
        install.once('error', reject);
        install.once('close', code => {
          const result = output.match(/STILLS_ELECTRON_PATH=(.+)/);
          if (code !== 0 || !result) reject(new Error(`Electron could not be prepared. Run npm run dev to retry. ${errors.trim()}`));
          else {
            try { resolve(JSON.parse(result[1]) as string); } catch (error) { reject(error); }
          }
        });
      });
    }
    args = [root];
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise<void>((resolve, reject) => {
    // This is the interactive review app, so Windows must show its first
    // window. windowsHide is reserved for background installers/native tools.
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false, env });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
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
    case 'authorization-url': result = await call('authorizationUrl'); break;
    case 'grant-queue-folders': result = await call('grantQueueFolders'); break;
    case 'retry-queue':
      if (!args.includes('--approve-all')) throw new Error('Use retry-queue --approve-all to retry flagged projects.');
      result = await call('retryBatch'); break;
    case 'run-queue':
      if (!args.includes('--approve-all')) throw new Error('Use run-queue --approve-all to authorize automatic selections, naming, delivery and skipping missing sources.');
      result = await call('startBatch', [true]); break;
    case 'pause-queue': result = await call('pauseBatch'); break;
    case 'projects': result = await call('listProjects'); break;
    case 'prepare':
      if (!args[0] || !args[1]) usage();
      result = await call('prepare', [args[0], args[1]]); break;
    case 'status': result = await call(args[0] ? 'getSession' : 'getState', args[0] ? [args[0]] : []); break;
    case 'resume':
      if (!args[0]) usage();
      result = await call('resume', [args[0]]); break;
    case 'review-again':
      if (!args[0]) usage();
      result = await call('reviewAgain', [args[0]]); break;
    case 'organize-ratios':
      if (!args[0]) usage();
      result = await call('organizeRatios', [args[0]]); break;
    case 'add-drive-source':
      if (!args[0] || !args[1]) usage();
      result = await call('addSource', [args[0], args[1]]); break;
    case 'retry-missing':
      if (!args.includes('--approve-all')) usage();
      result = await call('retryMissingSources', [true]); break;
    case 'login': result = await call('signIn'); break;
    case 'logout': result = await call('signOut'); break;
    case 'configure-google':
      if (!args[0]) usage();
      result = await call('configureGoogle', [args[0]]); break;
    case 'import-google':
      if (!args[0]) usage();
      result = await call('importGoogleCredentials', [path.resolve(args[0])]); break;
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
