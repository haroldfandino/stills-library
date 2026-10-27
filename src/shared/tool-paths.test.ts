import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from './defaults';
import { developmentElectron, resolveTools } from './tool-paths';

const root = path.resolve('test fixture', 'Stills Library');
const options = { root, resourcesPath: path.join(root, 'resources'), packaged: false, platform: 'win32' as const, arch: 'x64', exists: () => false };

describe('Windows command resolution', () => {
  it('launches the actual Electron executable, not an unspawnable CMD shim', () => {
    expect(developmentElectron(root, 'win32')).toBe(path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'));
  });

  it('uses sibling virtual environment and bundled ffprobe without relying on PATH', () => {
    const python = path.resolve(root, '../extract-stills/.venv/Scripts/python.exe');
    const ffprobe = path.resolve(root, '../extract-stills/ffmpeg/ffprobe.exe');
    const result = resolveTools(DEFAULT_CONFIG, { ...options, exists: file => [python, ffprobe].includes(file) });
    expect(result.extract.command).toBe(python);
    expect(result.extract.args).toEqual([path.resolve(root, '../extract-stills/cli_entry.py')]);
    expect(result.rename.command).toBe(python);
    expect(result.ffprobe).toBe(ffprobe);
  });

  it('falls back to the Windows Python launcher with an explicit Python version', () => {
    expect(resolveTools(DEFAULT_CONFIG, options).extract).toEqual({ command: 'py', args: ['-3.12', path.resolve(root, '../extract-stills/cli_entry.py')] });
  });

  it('uses the complete native sidecar when the development bundle has a manifest', () => {
    const result = resolveTools(DEFAULT_CONFIG, { ...options, exists: () => true });
    expect(result.extract).toEqual({ command: path.join(root, 'native', 'win32', 'x64', 'extract-stills', 'extract-stills.exe') });
    expect(result.rename).toEqual({ command: path.join(root, 'native', 'win32', 'x64', 'rename-stills.exe') });
  });

  it('uses release resources regardless of a system Python or ffprobe setting', () => {
    const result = resolveTools({ ...DEFAULT_CONFIG, pythonExecutable: 'unavailable-python', ffprobeExecutable: 'unavailable-ffprobe' }, { ...options, packaged: true });
    expect(result.extract).toEqual({ command: path.join(options.resourcesPath, 'x64', 'extract-stills', 'extract-stills.exe') });
    expect(result.ffprobe).toBe(path.join(options.resourcesPath, 'x64', 'extract-stills', '_internal', 'binaries', 'ffprobe.exe'));
  });
});
