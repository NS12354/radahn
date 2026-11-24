import { defineConfig, loadEnv, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { blenderApi } from './server/blender.mjs';
import { githubApi } from './server/github.mjs';
import { claudeTermApi } from './server/claude-term.mjs';

/**
 * Dev-server API: POST /api/compile { files, board } → { hex, log, toolchain }
 * Uses arduino-cli if installed, else avr-gcc + vendor/ArduinoCore-avr.
 * The static production build has no compiler; the UI falls back to precompiled
 * examples or a user-supplied .hex.
 */
function compileApi(): Plugin {
  return {
    name: 'formframe-compile-api',
    configureServer(server) {
      server.middlewares.use('/api/compile', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', async () => {
          res.setHeader('content-type', 'application/json');
          try {
            const { compileSketch } = await import('./server/compile.mjs');
            const { files, board } = JSON.parse(body);
            const r = await compileSketch({ files, board });
            res.end(JSON.stringify(r));
          } catch (e: any) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      });
    },
  };
}

/** Dev-server API: POST /api/part-from-url { url } → extracted part spec (server/part-from-url.mjs). */
function partApi(): Plugin {
  return {
    name: 'formframe-part-api',
    configureServer(server) {
      server.middlewares.use('/api/part-from-url', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
        let body = '';
        req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
        req.on('end', async () => {
          res.setHeader('content-type', 'application/json');
          try {
            const stop = (await import('./server/guard.mjs')).guardAI(req.headers);
            if (stop) { res.statusCode = stop.status; return res.end(JSON.stringify(stop.body)); }
            const { partFromUrl } = await import('./server/part-from-url.mjs');
            const { url } = JSON.parse(body);
            res.end(JSON.stringify(await partFromUrl(String(url ?? '').trim())));
          } catch (e: any) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      });
    },
  };
}

/** Dev-server API: POST /api/plan { context } → AI progress update (server/plan-ai.mjs). */
function planApi(): Plugin {
  return {
    name: 'formframe-plan-api',
    configureServer(server) {
      server.middlewares.use('/api/plan', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
        let body = '';
        req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
        req.on('end', async () => {
          res.setHeader('content-type', 'application/json');
          try {
            const stop = (await import('./server/guard.mjs')).guardAI(req.headers);
            if (stop) { res.statusCode = stop.status; return res.end(JSON.stringify(stop.body)); }
            const { planWithAI } = await import('./server/plan-ai.mjs');
            res.end(JSON.stringify(await planWithAI(JSON.parse(body).context)));
          } catch (e: any) { res.statusCode = 400; res.end(JSON.stringify({ error: e.message })); }
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Server-side settings from .env (Vite only exposes VITE_* to the browser, and never these).
  const env = loadEnv(mode, process.cwd(), '');
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'BLENDER_PATH', 'GITHUB_CLIENT_ID']) if (env[k] && !process.env[k]) process.env[k] = env[k];
  return {
  base: './',
  // built on Vercel: no local-machine features (Blender link, Claude Code terminal, Arduino compiler)
  define: { __FF_HOSTED__: JSON.stringify(!!process.env.VERCEL) },
  plugins: [compileApi(), partApi(), planApi(), { name: 'formframe-blender-link', configureServer: blenderApi }, { name: 'formframe-github', configureServer: githubApi }, { name: 'formframe-claude-code', configureServer: claudeTermApi }],
  build: {
    target: 'es2022', chunkSizeWarningLimit: 2000,
    rollupOptions: { input: { studio: fileURLToPath(new URL('./index.html', import.meta.url)), modeler: fileURLToPath(new URL('./modeler.html', import.meta.url)), device: fileURLToPath(new URL('./device.html', import.meta.url)) } },
  },
  server: { port: 5173 },
  // pre-bundle deps that are only imported on demand, so the dev server doesn't reload the page when they're first used
  optimizeDeps: { include: ['@dimforge/rapier3d-compat'] },
};
});
