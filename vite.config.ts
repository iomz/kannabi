import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { reactRouter } from '@react-router/dev/vite';
import { defineConfig, loadEnv } from 'vite';

/** The one place a Kannabi version is written is package metadata. The build
 * reads it from there so nothing in the application can drift from it. */
export const packageVersion: string = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
).version;

export const versionDefine = '__KANNABI_VERSION__';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [reactRouter()],
    define: { [versionDefine]: JSON.stringify(packageVersion) },
    server: {
      host: '127.0.0.1',
      proxy: { '/api': `http://127.0.0.1:${env.PORT || '3000'}` },
    },
  };
});
