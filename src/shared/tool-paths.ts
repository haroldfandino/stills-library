import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './contracts';

export interface ToolPaths {
  root: string;
  resourcesPath: string;
  packaged: boolean;
  platform?: NodeJS.Platform;
  arch?: string;
  exists?: (file: string) => boolean;
}

// Development uses the same verified sidecars as a release when available.
// Otherwise use the Extract Stills virtual environment, including on Windows.
export function resolveTools(config: AppConfig, options: ToolPaths) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const exists = options.exists ?? fs.existsSync;
  const suffix = platform === 'win32' ? '.exe' : '';
  const nativeRoot = options.packaged
    ? path.join(options.resourcesPath, arch)
    : path.join(options.root, 'native', platform, arch);
  const extraction = path.join(nativeRoot, 'extract-stills', `extract-stills${suffix}`);
  const rename = path.join(nativeRoot, `rename-stills${suffix}`);
  const ffprobe = path.join(nativeRoot, 'extract-stills', '_internal', 'binaries', `ffprobe${suffix}`);
  const extractRoot = path.resolve(options.root, '../extract-stills');
  const virtualPython = platform === 'win32'
    ? path.join(extractRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(extractRoot, '.venv', 'bin', 'python');
  const python = config.pythonExecutable || (exists(virtualPython) ? virtualPython : platform === 'win32' ? 'py' : 'python3.12');
  const pythonArgs = platform === 'win32' && python === 'py' ? ['-3.12'] : [];
  const useNative = options.packaged || exists(path.join(nativeRoot, 'BUILD-MANIFEST.json'));
  return {
    extract: config.extractExecutable ? { command: config.extractExecutable }
      : useNative ? { command: extraction }
      : { command: python, args: [...pythonArgs, path.join(extractRoot, 'cli_entry.py')] },
    rename: config.renameExecutable ? { command: config.renameExecutable }
      : useNative ? { command: rename }
      : { command: python, args: [...pythonArgs, config.renameScript || path.resolve(options.root, '../postproduction-tools/Rename_stills/rename_stills.py')] },
    ffprobe: options.packaged || (useNative && exists(ffprobe)) ? ffprobe
      : config.ffprobeExecutable && config.ffprobeExecutable !== 'ffprobe' ? config.ffprobeExecutable
      : exists(path.join(extractRoot, 'ffmpeg', `ffprobe${suffix}`)) ? path.join(extractRoot, 'ffmpeg', `ffprobe${suffix}`)
      : config.ffprobeExecutable || 'ffprobe',
  };
}

export function developmentElectron(root: string, platform: NodeJS.Platform = process.platform): string {
  const executable = platform === 'win32' ? 'electron.exe'
    : platform === 'darwin' ? path.join('Electron.app', 'Contents', 'MacOS', 'Electron') : 'electron';
  return path.join(root, 'node_modules', 'electron', 'dist', executable);
}
