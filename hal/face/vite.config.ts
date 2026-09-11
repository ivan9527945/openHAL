import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const require = createRequire(import.meta.url);

/**
 * VAD 備案引擎（`@ricky0123/vad-web`）的模型與 wasm。
 * 從 node_modules 複製到 `/wake/`，**不走任何 CDN** —— 喚醒詞的音訊與資產都不外流
 * （安全紅線 5 的隱私論述前提）。Porcupine 的 .ppn / .pv 則由人工放進 public/wake/。
 */
const WAKE_ASSETS: Record<string, string> = {
  'wake/vad.worklet.bundle.min.js': '@ricky0123/vad-web/dist/vad.worklet.bundle.min.js',
  'wake/silero_vad_legacy.onnx': '@ricky0123/vad-web/dist/silero_vad_legacy.onnx',
  'wake/ort-wasm-simd-threaded.mjs': 'onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
  'wake/ort-wasm-simd-threaded.wasm': 'onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
};

const MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
};

function resolveAsset(spec: string): string | null {
  try {
    return require.resolve(spec);
  } catch {
    // 多半是套件的 "exports" 沒開放這個子路徑（onnxruntime-web 就是），改由套件根目錄拼路徑
  }
  const parts = spec.split('/');
  const pkg = spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '');
  const sub = spec.slice(pkg.length + 1);
  if (pkg.length === 0 || sub.length === 0) return null;
  try {
    const main = require.resolve(pkg);
    const marker = `${sep}node_modules${sep}${pkg.split('/').join(sep)}${sep}`;
    const i = main.lastIndexOf(marker);
    if (i < 0) return null;
    const file = join(main.slice(0, i + marker.length), sub);
    return existsSync(file) ? file : null;
  } catch {
    // 套件沒裝（例如只想跑 Porcupine）時靜默略過，不讓 build 掛掉
    return null;
  }
}

function wakeAssets(): Plugin {
  return {
    name: 'hal-wake-assets',
    // dev server：直接從 node_modules 餵，不必先 build
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0] ?? '';
        const key = url.replace(/^\/+/, '');
        const spec = WAKE_ASSETS[key];
        if (spec === undefined) {
          next();
          return;
        }
        const file = resolveAsset(spec);
        if (file === null) {
          next();
          return;
        }
        const ext = key.slice(key.lastIndexOf('.'));
        res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
        res.end(readFileSync(file));
      });
    },
    // build：原樣輸出到 dist/wake/（檔名不可加 hash，vad-web 是用固定檔名去 fetch）
    generateBundle() {
      for (const [fileName, spec] of Object.entries(WAKE_ASSETS)) {
        const file = resolveAsset(spec);
        if (file === null) {
          this.warn(`[hal-wake-assets] 找不到 ${spec}，略過（VAD 備案引擎將無法啟動）`);
          continue;
        }
        this.emitFile({ type: 'asset', fileName, source: readFileSync(file) });
      }
    },
  };
}

// base 用相對路徑：hal-server 之後不論掛在 / 或子路徑都能直接吃這包靜態檔
export default defineConfig({
  base: './',
  plugins: [wakeAssets()],
  build: {
    target: 'es2022',
    assetsInlineLimit: 0, // hal-eye.svg 保持獨立檔案，換素材時直接覆蓋即可
    chunkSizeWarningLimit: 4096, // 喚醒詞引擎是動態載入的獨立 chunk，體積大屬正常
  },
});
