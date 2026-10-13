#!/usr/bin/env node
/**
 * scripts/perf.js — A/B-замер влияния расширения на скорость страницы.
 *
 * Запускает portable Chromium дважды (с расширением и без), делает холодные
 * навигации на страницах author.today, собирает веб-метрики через CDP и
 * печатает таблицу «без → с расширением → дельта». Ноль зависимостей:
 * только Node.js >= 22 (глобальный WebSocket) + Chromium/Chrome.
 *
 * Использование:
 *   npm run perf                 # 5 прогонов × 2 URL, отчёт в perf/last-report.md
 *   npm run perf -- --quick      # 3 прогона, только каталог (быстрый путь)
 *   npm run perf -- --runs=10    # больше прогонов → стабильнее медиана
 *   npm run perf -- --headed     # в оконном режиме (фолбэк, если headless+extension не загрузился)
 *   npm run perf -- --chrome="C:\path\chrome.exe" --urls=https://author.today/...
 *
 * Что меряет (медиана по прогонам, кэш отключён):
 *   - Navigation Timing: TTFB, domInteractive, DCL, load
 *   - FCP, LCP (PerformanceObserver buffered), CLS (layout-shift)
 *   - long tasks > 50 мс (сумма/количество ≈ TBT)
 *   - CDP Performance.getMetrics: дельты Task/Script/Layout/RecalcStyleDuration,
 *     JSHeapUsedSize
 *   - sanity: в конфиге «с расширением» на каталоге есть .atr-controls
 *   - изолированная стоимость кода (конфиг «без»): eval 5 content-файлов +
 *     холодный/tёплый scan() в мс — точная цена нашего скрипта без шума сети
 *
 * Отчёты: perf/last-report.md (перезапись) + строка в perf/history.md
 * (для регулярных прогонов и отслеживания деградаций).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'extension');
const OUT_DIR = path.join(ROOT, 'perf');
const CATALOG_URL = 'https://author.today/work/genre/fantasy';
const SEARCH_URL = 'https://author.today/search?category=works&q=%D1%84%D1%8D%D0%BD%D1%82%D0%B5%D0%B7%D0%B8';
const CONTENT_FILES = [
  'content/storage.js',
  'content/sync.js',
  'content/ui.js',
  'content/dom.js',
  'content/main.js'
];
const SETTLE_MS = 4000; // ждём после load — финализация LCP/CLS
const NAV_TIMEOUT_MS = 45000;

// ---------------------------------------------------------------- аргументы ---

function parseArgs(argv) {
  const a = { runs: 5, urls: [CATALOG_URL, SEARCH_URL], headed: false, quick: false, chrome: null, out: null };
  for (const arg of argv) {
    if (arg === '--headed') a.headed = true;
    else if (arg === '--quick') a.quick = true;
    else if (arg.startsWith('--runs=')) a.runs = Math.max(1, parseInt(arg.slice(7), 10) || 5);
    else if (arg.startsWith('--urls=')) a.urls = arg.slice(7).split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg.startsWith('--chrome=')) a.chrome = arg.slice(9);
    else if (arg.startsWith('--out=')) a.out = arg.slice(6);
    else if (arg === '--help' || arg === '-h') {
      console.log('См. комментарий в начале файла: node scripts/perf.js [--runs=N] [--urls=...] [--quick] [--headed] [--chrome=path] [--out=file]');
      process.exit(0);
    } else {
      console.error('Неизвестный аргумент: ' + arg);
      process.exit(1);
    }
  }
  if (a.quick) { a.runs = Math.min(a.runs, 3); a.urls = [CATALOG_URL]; }
  return a;
}

// ------------------------------------------------------------------ утилиты ---

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function median(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((x, y) => x - y);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
const minOf = (v) => Math.min(...v.filter(Number.isFinite));
const maxOf = (v) => Math.max(...v.filter(Number.isFinite));
const fmtMs = (x) => (x == null ? '—' : Math.round(x) + ' ms');
const fmtCls = (x) => (x == null ? '—' : x.toFixed(3));
const fmtBytes = (x) => (x == null ? '—' : Math.round(x / 1024) + ' KB');
const fmtDelta = (base, ext) => {
  if (base == null || ext == null) return '—';
  const d = ext - base;
  const pct = base !== 0 ? ' (' + (d >= 0 ? '+' : '') + ((d / base) * 100).toFixed(1) + '%)' : '';
  return (d >= 0 ? '+' : '') + Math.round(d) + (Number.isInteger(d) ? '' : '') + pct;
};
const fmtDeltaBytes = (base, ext) => {
  if (base == null || ext == null) return '—';
  const d = ext - base;
  const pct = base !== 0 ? ' (' + (d >= 0 ? '+' : '') + ((d / base) * 100).toFixed(1) + '%)' : '';
  return (d >= 0 ? '+' : '') + Math.round(d / 1024) + ' KB' + pct;
};

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
  });
}

async function waitDevTools(port) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const v = await getJson(`http://127.0.0.1:${port}/json/version`);
      if (v.webSocketDebuggerUrl) return v;
    } catch (_) { /* браузер ещё поднимается */ }
    await sleep(250);
  }
  throw new Error('DevTools endpoint не поднялся за 20 с');
}

// -------------------------------------------------------------- детект chrome ---

function detectChrome(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  // portable ungoogled-chromium в загрузках (использовался для рендера иконок)
  for (const dir of ['D:\\Загрузки', path.join(os.homedir(), 'Downloads')]) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith('ungoogled-chromium')) candidates.push(path.join(dir, name, 'chrome.exe'));
      }
    } catch (_) { /* каталога нет */ }
  }
  candidates.push(
    path.join(process.env['ProgramFiles'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
  );
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  throw new Error('Chromium/Chrome не найден — укажите --chrome=путь (брендовый Chrome блокирует --load-extension)');
}

// -------------------------------------------------------------------- CDP ----

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Set();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers) h(msg);
      }
    });
  }
  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => reject(new Error('CDP WebSocket timeout')), 10000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(new Cdp(ws)); });
      ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error('CDP WebSocket error: ' + (e.message || e.type))); });
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 30000);
    });
  }
  once(method, sessionId) {
    return new Promise((resolve, reject) => {
      const handler = (msg) => {
        if (msg.method === method && (!sessionId || msg.sessionId === sessionId)) {
          this.handlers.delete(handler);
          clearTimeout(timer);
          resolve(msg.params);
        }
      };
      const timer = setTimeout(() => {
        this.handlers.delete(handler);
        reject(new Error('timeout ожидания ' + method));
      }, NAV_TIMEOUT_MS);
      this.handlers.add(handler);
    });
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

// ---------------------------------------------------- инжект до навигации ----

// PerformanceObserver'ы ставятся ДО загрузки страницы, чтобы не пропустить FCP.
const OBSERVER_SRC = `(() => {
  const r = { fcp: null, lcp: null, cls: 0, longTasks: [] };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (r.fcp === null) r.fcp = e.startTime; })
      .observe({ type: 'paint', buffered: true });
  } catch (_) {}
  try {
    new PerformanceObserver((l) => { const es = l.getEntries(); if (es.length) r.lcp = es[es.length - 1].startTime; })
      .observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (_) {}
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) r.cls += e.value; })
      .observe({ type: 'layout-shift', buffered: true });
  } catch (_) {}
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) r.longTasks.push(e.duration); })
      .observe({ type: 'longtask', buffered: true });
  } catch (_) {}
  window.__atrPerf = {
    report() {
      const n = performance.getEntriesByType('navigation')[0];
      return {
        fcp: r.fcp, lcp: r.lcp, cls: r.cls,
        longSum: r.longTasks.reduce((a, b) => a + b, 0),
        longCount: r.longTasks.length,
        nav: n ? {
          ttfb: n.responseStart,
          domInteractive: n.domInteractive,
          dcl: n.domContentLoadedEventEnd,
          load: n.loadEventEnd
        } : null
      };
    }
  };
})()`;

// --------------------------------------------------------------- браузер ----

function launchBrowser(chromePath, { port, headless, loadExtension }) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atr-perf-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-client-side-phishing-detection',
    '--disable-sync',
    '--disable-translate',
    '--disable-features=Translate,OptimizationGuideModelDownloading',
    '--window-size=1440,900'
  ];
  if (headless) args.push('--headless=new', '--disable-gpu');
  if (loadExtension) args.push('--load-extension=' + EXT_DIR);
  args.push('about:blank');
  const proc = spawn(chromePath, args, { stdio: 'ignore', windowsHide: true });
  return { proc, profileDir, port };
}

function killBrowser({ proc, profileDir }) {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F']);
    } else {
      proc.kill('SIGTERM');
    }
  } catch (_) {}
  try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch (_) {}
}

// ---------------------------------------------------------------- прогоны ----

/**
 * Ожидание готовности страницы ПОЛЛИНГОМ readyState (надёжнее события
 * Page.loadEventFired: на автор.today load может подвиснуть на ресурсе и
 * событие не приходит — проверено пробником 13.10.2026).
 *  - complete → сразу выходим;
 *  - interactive дольше 8 с без изменений → подвисший load, идём дальше
 *    с предупреждением (FCP/LCP/CLS к этому моменту уже собраны).
 */
let stallWarned = false;
async function waitForReady(browser, sessionId) {
  const deadline = Date.now() + NAV_TIMEOUT_MS;
  let last = '';
  let interactiveSince = null;
  while (Date.now() < deadline) {
    const r = await browser.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sessionId);
    last = r.result && r.result.value;
    if (last === 'complete') return 'complete';
    if (last === 'interactive') {
      if (interactiveSince === null) interactiveSince = Date.now();
      else if (Date.now() - interactiveSince > 8000) {
        if (!stallWarned) {
          stallWarned = true;
          process.stderr.write('  предупреждение: load завис на ресурсе (interactive > 8 с) — продолжаем (покажу один раз)\n');
        }
        return 'partial';
      }
    } else {
      interactiveSince = null;
    }
    await sleep(300);
  }
  if (last === 'interactive' || last === 'complete') return 'partial';
  throw new Error('страница не вышла из readyState="' + last + '" за ' + NAV_TIMEOUT_MS + ' мс');
}

/** Навигационные тайминги: 0/undefined = событие не наступило → null. */
const nz = (x) => (typeof x === 'number' && x > 0 ? x : null);

async function measureRun(browser, url) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    await browser.send('Page.enable', {}, sessionId);
    await browser.send('Network.enable', {}, sessionId);
    await browser.send('Performance.enable', {}, sessionId);
    await browser.send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
    await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVER_SRC }, sessionId);
    await sleep(400); // даём about:blank долечиться, чтобы не ловить чужие события

    const { metrics: m0list } = await browser.send('Performance.getMetrics', {}, sessionId);
    const m0 = Object.fromEntries(m0list.map((x) => [x.name, x.value]));

    const nav = await browser.send('Page.navigate', { url }, sessionId);
    if (nav.errorText) throw new Error('navigate: ' + nav.errorText);
    await waitForReady(browser, sessionId);
    await sleep(SETTLE_MS); // финализация LCP/CLS

    const { metrics: m1list } = await browser.send('Performance.getMetrics', {}, sessionId);
    const m1 = Object.fromEntries(m1list.map((x) => [x.name, x.value]));

    const evalRes = await browser.send(
      'Runtime.evaluate',
      { expression: 'JSON.stringify(window.__atrPerf ? window.__atrPerf.report() : null)', returnByValue: true },
      sessionId
    );
    const domRes = await browser.send(
      'Runtime.evaluate',
      { expression: "JSON.stringify({panels: document.querySelectorAll('.atr-controls').length})", returnByValue: true },
      sessionId
    );

    const data = JSON.parse(evalRes.result.value) || {};
    const dom = JSON.parse(domRes.result.value) || { panels: 0 };
    const s = (name) => m1[name] != null && m0[name] != null ? (m1[name] - m0[name]) * 1000 : null; // сек → мс
    return {
      url,
      fcp: data.fcp, lcp: data.lcp, cls: data.cls,
      longSum: data.longSum, longCount: data.longCount,
      ttfb: nz(data.nav && data.nav.ttfb),
      dcl: nz(data.nav && data.nav.dcl),
      load: nz(data.nav && data.nav.load),
      task: s('TaskDuration'),
      script: s('ScriptDuration'),
      layout: s('LayoutDuration'),
      recalc: s('RecalcStyleDuration'),
      heap: m1.JSHeapUsedSize || null,
      panels: dom.panels
    };
  } finally {
    await browser.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

/** Изолированная стоимость кода расширения (в конфиге «без расширения»). */
async function measureCodeCost(browser) {
  const files = CONTENT_FILES.map((f) => ({
    name: f,
    src: fs.readFileSync(path.join(EXT_DIR, f), 'utf8')
  }));
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    await browser.send('Page.enable', {}, sessionId);
    const nav = await browser.send('Page.navigate', { url: CATALOG_URL }, sessionId);
    if (nav.errorText) throw new Error('navigate: ' + nav.errorText);
    await waitForReady(browser, sessionId);
    await sleep(1500);
    const expr =
      `(() => {` +
      ` const files = ${JSON.stringify(files)};` +
      ` const parts = {}; const t0 = performance.now();` +
      ` for (const f of files) { const s = performance.now(); (0, eval)(f.src); parts[f.name] = +(performance.now() - s).toFixed(2); }` +
      ` const tEval = +(performance.now() - t0).toFixed(2);` +
      ` const s1 = performance.now(); ATR.dom.scan(); const cold = +(performance.now() - s1).toFixed(2);` +
      ` const s2 = performance.now(); ATR.dom.scan(); const warm = +(performance.now() - s2).toFixed(2);` +
      ` return JSON.stringify({ parts, tEval, scanCold: cold, scanWarm: warm, panels: document.querySelectorAll('.atr-controls').length });` +
      `})()`;
    const res = await browser.send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
    return JSON.parse(res.result.value);
  } finally {
    await browser.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

// ------------------------------------------------------------- конфигуры ----

async function runConfig(chromePath, { withExtension, runs, urls, headless }) {
  const port = await freePort();
  const launched = launchBrowser(chromePath, { port, headless, loadExtension: withExtension });
  try {
    const version = await waitDevTools(port);
    const browser = await Cdp.connect(version.webSocketDebuggerUrl);
    const result = { runs: {}, codeCost: null, version: version.Browser || '', sanity: null };
    try {
      for (const url of urls) {
        const list = [];
        for (let i = 0; i < runs; i++) list.push(await measureRun(browser, url));
        result.runs[url] = list;
        const last = list[list.length - 1];
        process.stderr.write(
          `  ${withExtension ? '[с расширением] ' : '[без]         '} ${url.replace('https://author.today', '')} — ${list.length} прогонов, панелей: ${last.panels}\n`
        );
        if (result.sanity === null) result.sanity = last.panels;
      }
      if (!withExtension) result.codeCost = await measureCodeCost(browser);
    } finally {
      browser.close();
    }
    return result;
  } finally {
    killBrowser(launched);
  }
}

// ---------------------------------------------------------------- отчёт ----

function buildReport(args, chromePath, resB, resA, codeCost) {
  const git = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const head = git.status === 0 ? git.stdout.trim() : '?';
  const lines = [];
  lines.push('# Замер производительности — ' + new Date().toISOString().slice(0, 19).replace('T', ' '));
  lines.push('');
  lines.push(`- коммит: \`${head}\`, chromium: \`${chromePath}\``);
  lines.push(`- прогоны: ${args.runs} на конфиг, кэш отключён, headless=${!args.headed}, медианы`);
  lines.push(`- браузер A: ${resA.version || '?'}`);
  lines.push('');

  const METRICS = [
    ['FCP, ms', 'fcp', fmtMs],
    ['LCP, ms', 'lcp', fmtMs],
    ['CLS', 'cls', fmtCls],
    ['TTFB, ms', 'ttfb', fmtMs],
    ['DOMContentLoaded, ms', 'dcl', fmtMs],
    ['load, ms', 'load', fmtMs],
    ['Long tasks, сумма ms', 'longSum', fmtMs],
    ['Long tasks, шт', 'longCount', (x) => (x == null ? '—' : String(Math.round(x)))],
    ['TaskDuration, ms', 'task', fmtMs],
    ['ScriptDuration, ms', 'script', fmtMs],
    ['LayoutDuration, ms', 'layout', fmtMs],
    ['RecalcStyleDuration, ms', 'recalc', fmtMs],
    ['JSHeap', 'heap', fmtBytes]
  ];

  const historyLines = [];
  for (const url of Object.keys(resB.runs)) {
    const runsB = resB.runs[url];
    const runsA = resA.runs[url] || [];
    lines.push('## ' + url.replace('https://author.today', '') + '');
    lines.push('');
    lines.push('| Метрика | без расширения | с расширением | дельта |');
    lines.push('| --- | ---: | ---: | ---: |');
    const medB = {}; const medA = {};
    for (const [label, key, fmt] of METRICS) {
      const b = median(runsB.map((r) => r[key]));
      const a = median(runsA.map((r) => r[key]));
      medB[key] = b; medA[key] = a;
      const delta =
        key === 'cls'
          ? (b != null && a != null ? (a - b >= 0 ? '+' : '') + (a - b).toFixed(3) : '—')
          : key === 'heap'
            ? fmtDeltaBytes(b, a)
            : fmtDelta(b, a);
      lines.push(`| ${label} | ${fmt(b)} | ${fmt(a)} | ${delta} |`);
    }
    lines.push('');
    // разброс ключевых метрик — видно, насколько медиана устойчива
    const spread = (key, fmt) => {
      const b = runsB.map((r) => r[key]).filter(Number.isFinite);
      const a = runsA.map((r) => r[key]).filter(Number.isFinite);
      if (!b.length && !a.length) return null;
      return `  - разброс ${key}: без ${fmt(minOf(b))}…${fmt(maxOf(b))}, с расширением ${fmt(minOf(a))}…${fmt(maxOf(a))}`;
    };
    for (const s of [spread('fcp', fmtMs), spread('lcp', fmtMs), spread('cls', fmtCls)]) if (s) lines.push(s);
    lines.push('');
    historyLines.push(
      `| ${new Date().toISOString().slice(0, 16).replace('T', ' ')} | \`${head}\` | ${url.replace('https://author.today', '')} | ` +
      `FCP ${fmtMs(medB.fcp)}→${fmtMs(medA.fcp)} | LCP ${fmtMs(medB.lcp)}→${fmtMs(medA.lcp)} | ` +
      `CLS ${fmtCls(medB.cls)}→${fmtCls(medA.cls)} | Task ${fmtMs(medB.task)}→${fmtMs(medA.task)} |`
    );
  }

  if (codeCost) {
    lines.push('## Изолированная стоимость кода расширения (страница уже загружена)');
    lines.push('');
    lines.push(`- eval + init (включая первый \`scan()\`): **${codeCost.tEval} мс**`);
    lines.push(`- повторный (тёплый) \`scan()\`: **${codeCost.scanWarm} мс** (холодный — ${codeCost.scanCold} мс, включает инжект ${codeCost.panels} панелей)`);
    lines.push('- по файлам: ' + Object.entries(codeCost.parts).map(([k, v]) => `${path.basename(k)} ${v} мс`).join(', '));
    lines.push('');
  }

  lines.push('## Как читать');
  lines.push('');
  lines.push('- **FCP/LCP**: расширение грузится на `document_idle` (после парсинга) — дельты в пределах шума сети норма.');
  lines.push('- **CLS**: главный кандидат на влияние — инжект панелей/тумблера сдвигает текст после load; дельта > 0.02 стоит внимания.');
  lines.push('- **TaskDuration/ScriptDuration**: суммарная работа главного потока — влияние видно как +мс.');
  lines.push('- Разброс велик → увеличить `--runs`; сеть шумит, медиана устойчивее среднего.');
  lines.push('');
  return { text: lines.join('\n'), history: historyLines };
}

// ------------------------------------------------------------------ main ----

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const chromePath = detectChrome(args.chrome);
  const headless = !args.headed;

  console.error('Chromium: ' + chromePath);
  console.error(`Прогоны: ${args.runs} × ${args.urls.length} URL, ${headless ? 'headless' : 'headed'}`);

  // Сначала база (без расширения), потом с расширением.
  console.error('\nКонфиг B: без расширения…');
  const resB = await runConfig(chromePath, { withExtension: false, runs: args.runs, urls: args.urls, headless });

  console.error('Конфиг A: с расширением…');
  let resA = await runConfig(chromePath, { withExtension: true, runs: args.runs, urls: args.urls, headless });

  // Sanity: расширение обязано внедрить панели. Если headless его не загрузил —
  // один автоматический повтор конфига A в оконном режиме.
  const firstUrl = args.urls[0];
  if (resA.runs[firstUrl] && resA.runs[firstUrl].some((r) => r.panels > 0) === false) {
    console.error('  ВНИМАНИЕ: панели не появились — похоже, --load-extension не сработал в headless.');
    if (headless) {
      console.error('  Повтор конфига A в оконном режиме…');
      resA = await runConfig(chromePath, { withExtension: true, runs: args.runs, urls: args.urls, headless: false });
    }
  }
  const okA = Object.values(resA.runs).some((list) => list.some((r) => r.panels > 0));
  const okB = Object.values(resB.runs).every((list) => list.every((r) => r.panels === 0));

  const report = buildReport(args, chromePath, resB, resA, resB.codeCost);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = args.out || path.join(OUT_DIR, 'last-report.md');
  fs.writeFileSync(outPath, report.text, 'utf8');
  const historyPath = path.join(OUT_DIR, 'history.md');
  if (!fs.existsSync(historyPath) || fs.statSync(historyPath).size === 0) {
    fs.writeFileSync(historyPath, '| Дата | Коммит | URL | FCP | LCP | CLS | Task |\n| --- | --- | --- | --- | --- | --- | --- |\n', 'utf8');
  }
  for (const l of report.history) fs.appendFileSync(historyPath, l + '\n', 'utf8');

  console.log(report.text);
  console.log('Отчёт: ' + outPath + '  (история: perf/history.md)');
  if (!okA) { console.error('FAIL: в конфиге A нет ни одной панели — расширение не загрузилось.'); process.exit(2); }
  if (!okB) console.error('ВНИМАНИЕ: в конфиге B появились панели — расширение как-то попало в базовый прогон.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
