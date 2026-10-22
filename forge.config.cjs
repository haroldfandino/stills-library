const path = require('node:path');
const fs = require('node:fs');

const resources = path.join(__dirname, 'native', process.platform, process.arch);
const suffix = process.platform === 'win32' ? '.exe' : '';
for (const required of [
  path.join(resources, 'extract-stills', `extract-stills${suffix}`),
  path.join(resources, `rename-stills${suffix}`),
  path.join(resources, 'BUILD-MANIFEST.json'),
]) {
  if (!fs.existsSync(required)) {
    throw new Error(`Missing release sidecar ${required}. Run scripts/build-native.py on this target machine first.`);
  }
}
module.exports = {
  packagerConfig: {
    asar: true,
    appBundleId: 'tv.filmkraft.stills-library',
    executableName: 'Stills Library',
    extendInfo: { LSMinimumSystemVersion: '15.0' },
    // Process and renderer output is bundled into dist/. The native sidecar and
    // CLI launcher are copied once through extraResource, outside app.asar.
    ignore: [
      /^\/(?:build|native|out|src|tests|scripts|docs|patches|bin|node_modules)(?:\/|$)/,
      /^\/(?:README\.md|description\.md|forge\.config\.cjs|tsconfig\.json|vite\.config\.ts|vitest\.config\.ts)$/,
    ],
    extraResource: [resources, path.join(__dirname, 'bin')],
  },
  makers: [
    { name: '@electron-forge/maker-dmg', platforms: ['darwin'] },
    { name: '@electron-forge/maker-squirrel', platforms: ['win32'] },
    { name: '@electron-forge/maker-zip', platforms: ['darwin', 'win32'] },
  ],
};
