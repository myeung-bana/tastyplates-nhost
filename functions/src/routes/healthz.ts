import { Router } from 'express';
import type { Request, Response } from 'express';
import { checkHealth } from '../_lib/health';

const router = Router();

/** GET /healthz — machine-readable health check */
router.get('/healthz', async (_req: Request, res: Response) => {
  const result = await checkHealth();
  res.status(result.status === 'healthy' ? 200 : 503).json(result);
});

/** GET /ready — lightweight liveness probe (no external calls) */
router.get('/ready', (_req: Request, res: Response) => {
  res.json({ ok: true, uptime: Math.floor(process.uptime()) });
});

/** GET /health/ui — minimal browser dashboard */
router.get('/health/ui', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Tastyplates Functions — Health</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f1117; color: #e2e4f0;
           min-height: 100vh; padding: 40px 24px; }
    h1 { font-size: 20px; font-weight: 700; margin-bottom: 6px; }
    .subtitle { font-size: 13px; color: #6b7280; margin-bottom: 32px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; }
    .card { background: #1a1d27; border: 1px solid #2a2d3a; border-radius: 10px;
            padding: 20px; display: flex; flex-direction: column; gap: 10px; }
    .label { font-size: 13px; color: #6b7280; font-weight: 600; text-transform: uppercase;
             letter-spacing: .05em; }
    .pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px;
            border-radius: 20px; font-size: 13px; font-weight: 600; }
    .ok { background: rgba(34,197,94,.12); color: #22c55e; }
    .error { background: rgba(239,68,68,.12); color: #ef4444; }
    .pending { background: rgba(107,114,128,.12); color: #6b7280; }
    .latency { font-size: 12px; color: #6b7280; }
    .uptime { font-size: 13px; color: #6b7280; margin-top: 24px; }
    .error-msg { font-size: 11px; color: #ef4444; margin-top: 4px; }
  </style>
</head>
<body>
  <h1>🍽 Tastyplates Functions</h1>
  <p class="subtitle">Backend health monitor — refreshes every 10 s</p>
  <div class="grid" id="grid">
    <div class="card"><div class="label">Hasura</div><span class="pill pending">…</span></div>
    <div class="card"><div class="label">Redis</div><span class="pill pending">…</span></div>
    <div class="card"><div class="label">S3</div><span class="pill pending">…</span></div>
  </div>
  <p class="uptime" id="uptime"></p>
  <script>
    async function refresh() {
      try {
        const r = await fetch('/healthz');
        const d = await r.json();
        const checks = d.checks || {};
        const services = ['hasura', 'redis', 's3'];
        const cards = document.querySelectorAll('.card');
        services.forEach((svc, i) => {
          const c = checks[svc] || {};
          const pill = cards[i].querySelector('.pill');
          const cls = c.status === 'ok' ? 'ok' : c.status === 'error' ? 'error' : 'pending';
          pill.className = 'pill ' + cls;
          pill.textContent = c.status || '…';
          let extra = cards[i].querySelector('.latency');
          if (!extra) { extra = document.createElement('span'); extra.className = 'latency'; cards[i].appendChild(extra); }
          extra.textContent = c.latencyMs != null ? c.latencyMs + ' ms' : '';
          let errEl = cards[i].querySelector('.error-msg');
          if (c.error) {
            if (!errEl) { errEl = document.createElement('p'); errEl.className = 'error-msg'; cards[i].appendChild(errEl); }
            errEl.textContent = c.error;
          } else if (errEl) { errEl.remove(); }
        });
        document.getElementById('uptime').textContent = 'Uptime: ' + d.uptime + 's · Status: ' + (d.status || '—');
      } catch (e) { document.getElementById('uptime').textContent = 'Fetch error: ' + e.message; }
    }
    refresh();
    setInterval(refresh, 10000);
  </script>
</body>
</html>`);
});

export default router;
