const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('patchright');

const HOST = String(process.env.HOST || '0.0.0.0').trim() || '0.0.0.0';
const PORT = Number.isFinite(Number(process.env.PORT))
  ? Math.max(1, Math.min(65535, Math.round(Number(process.env.PORT))))
  : 7332;
const HOME_DIR = String(process.env.HOME || os.homedir() || '/home/nonroot').trim() || '/home/nonroot';
const CONTEXTS_DIR = String(process.env.CONTEXTS_DIR || path.join(HOME_DIR, '.stealth-browser', 'browser-contexts')).trim();
const BROWSER_CHANNEL = String(process.env.BROWSER_CHANNEL || 'chrome').trim() || 'chrome';
const BROWSER_LOCALE = String(process.env.BROWSER_LOCALE || 'en-US').trim() || 'en-US';
const BROWSER_TIMEZONE = String(process.env.BROWSER_TIMEZONE || 'UTC').trim() || 'UTC';
const ENABLE_NO_SANDBOX = process.env.PATCHRIGHT_NO_SANDBOX === '1';
const WARMUP_ON_START = process.env.BROWSER_WARMUP_ON_START === '1';
const MAX_BODY_BYTES = 256 * 1024;
const MAX_ACTIONS = 25;
const MAX_TIMEOUT_MS = 120000;
const DEFAULT_TIMEOUT_MS = 30000;
const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9.-]+(?<!-)$/i;
const CONTEXT_IDLE_TTL_MS = Number.isFinite(Number(process.env.CONTEXT_IDLE_TTL_MS))
  ? Math.max(30_000, Math.round(Number(process.env.CONTEXT_IDLE_TTL_MS)))
  : 10 * 60 * 1000;
const CONTEXT_SWEEP_INTERVAL_MS = Number.isFinite(Number(process.env.CONTEXT_SWEEP_INTERVAL_MS))
  ? Math.max(10_000, Math.round(Number(process.env.CONTEXT_SWEEP_INTERVAL_MS)))
  : 60_000;

const contextPool = new Map();
const startupState = {
  warmupAttempted: false,
  warmupSucceeded: false,
  warmupError: null,
};

fs.mkdirSync(CONTEXTS_DIR, { recursive: true });

function requestError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeDomain(domain) {
  const normalized = String(domain || '').trim().toLowerCase().replace(/^www\./, '');
  if (!normalized || !DOMAIN_RE.test(normalized) || normalized.includes('..')) {
    throw requestError('invalid domain');
  }
  return normalized;
}

function domainOf(url) {
  try {
    return normalizeDomain(new URL(url).hostname);
  } catch {
    return 'unknown';
  }
}

async function launchContext(domain) {
  const dir = path.join(CONTEXTS_DIR, domain);
  fs.mkdirSync(dir, { recursive: true });

  return chromium.launchPersistentContext(dir, {
    channel: BROWSER_CHANNEL,
    headless: true,
    viewport: null,
    locale: BROWSER_LOCALE,
    timezoneId: BROWSER_TIMEZONE,
    args: ENABLE_NO_SANDBOX ? ['--no-sandbox'] : [],
  });
}

async function getContextEntry(domain) {
  let entry = contextPool.get(domain);
  if (!entry) {
    entry = {
      domain,
      context: null,
      launchPromise: null,
      busyCount: 0,
      lastUsedAt: Date.now(),
      closing: false,
    };
    contextPool.set(domain, entry);
  }

  entry.lastUsedAt = Date.now();
  if (entry.context) {
    return entry;
  }

  if (!entry.launchPromise) {
    entry.launchPromise = launchContext(domain)
      .then((context) => {
        if (entry.closing) {
          return context.close().catch(() => {}).then(() => null);
        }
        entry.context = context;
        entry.lastUsedAt = Date.now();
        context.on('close', () => {
          const current = contextPool.get(domain);
          if (current === entry) {
            contextPool.delete(domain);
          }
        });
        return context;
      })
      .finally(() => {
        entry.launchPromise = null;
      });
  }

  await entry.launchPromise;
  if (!entry.context) {
    throw requestError(`context unavailable for ${domain}`, 503);
  }
  return entry;
}

async function closeContextEntry(domain, { removeDir = false } = {}) {
  const entry = contextPool.get(domain);
  if (entry) {
    entry.closing = true;
    contextPool.delete(domain);
    if (entry.launchPromise) {
      try {
        await entry.launchPromise;
      } catch {}
    }
    if (entry.context) {
      try {
        await entry.context.close();
      } catch {}
    }
  }

  if (removeDir) {
    const dir = path.join(CONTEXTS_DIR, domain);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

async function sweepIdleContexts() {
  const now = Date.now();
  const staleDomains = [];
  for (const [domain, entry] of contextPool.entries()) {
    if (!entry.context || entry.launchPromise || entry.closing || entry.busyCount > 0) {
      continue;
    }
    if (now - entry.lastUsedAt >= CONTEXT_IDLE_TTL_MS) {
      staleDomains.push(domain);
    }
  }
  for (const domain of staleDomains) {
    await closeContextEntry(domain);
  }
}

const contextSweeper = setInterval(() => {
  sweepIdleContexts().catch(() => {});
}, CONTEXT_SWEEP_INTERVAL_MS);
contextSweeper.unref?.();

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(requestError('request body too large', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        finish(parseBody(chunks));
      } catch (error) {
        fail(error);
      }
    });
    req.on('error', fail);
  });
}

function parseBody(chunks) {
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw requestError('request body must be a JSON object');
  }
  return parsed;
}

function clampTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.round(parsed), 1000), MAX_TIMEOUT_MS);
}

function normalizeSelector(value, fieldName = 'selector') {
  if (typeof value !== 'string') {
    throw requestError(`${fieldName} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw requestError(`${fieldName} is required`);
  }
  if (normalized.length > 300) {
    throw requestError(`${fieldName} is too long`);
  }
  return normalized;
}

function normalizeActions(actions) {
  if (!Array.isArray(actions)) {
    throw requestError('actions must be an array');
  }

  return actions.slice(0, MAX_ACTIONS).map((action) => {
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      throw requestError('invalid action');
    }

    const type = String(action.type || '').trim();
    switch (type) {
      case 'wait':
        return { type, ms: clampTimeout(action.ms || 1000) };
      case 'click':
        return {
          type,
          selector: normalizeSelector(action.selector),
          timeout: clampTimeout(action.timeout || 5000),
        };
      case 'wait_for':
        return {
          type,
          selector: normalizeSelector(action.selector),
          timeout: clampTimeout(action.timeout || 5000),
        };
      case 'type':
        return {
          type,
          selector: normalizeSelector(action.selector),
          value: String(action.value || '').slice(0, 2000),
        };
      case 'scroll':
        return { type };
      default:
        throw requestError(`unsupported action type: ${type}`);
    }
  });
}

function normalizeScrapeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    throw requestError('invalid url');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw requestError('url must use http or https');
  }
  return parsed.toString();
}

async function handleScrape(body) {
  const url = normalizeScrapeUrl(body.url);
  const actions = normalizeActions(body.actions || []);
  const timeout = clampTimeout(body.timeout);
  const fullHtml = body.full_html === true;

  const domain = domainOf(url);
  const entry = await getContextEntry(domain);
  const context = entry.context;
  entry.busyCount += 1;
  entry.lastUsedAt = Date.now();
  let page = null;

  try {
    page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

    for (const action of actions) {
      switch (action.type) {
        case 'wait':
          await page.waitForTimeout(action.ms || 1000);
          break;
        case 'click':
          await page.locator(action.selector).first().click({ timeout: action.timeout || 5000 }).catch(() => {});
          break;
        case 'wait_for':
          await page.waitForSelector(action.selector, { timeout: action.timeout || 5000 }).catch(() => {});
          break;
        case 'type':
          await page.fill(action.selector, action.value);
          break;
        case 'scroll':
          await page.evaluate(() => window.scrollBy(0, window.innerHeight));
          break;
      }
    }

    const extracted = await page.evaluate((pageUrl) => {
      const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
      const pushUnique = (items, value, maxLength = 180) => {
        const text = clean(value);
        if (!text || text.length < 3 || text.length > maxLength || items.includes(text)) {
          return;
        }
        items.push(text);
      };
      const blockedTerms = [
        'help', 'privacy', 'cookie', 'sign in', 'register',
        'saved search', 'filter', 'sort',
      ];
      const blockedHrefBits = [
        '/messages', '/notifications', '/help',
      ];
      const pageHost = (() => {
        try {
          return new URL(pageUrl).hostname.replace(/^www\./, '');
        } catch {
          return '';
        }
      })();
      const root = document.querySelector('main,[role="main"],#main,article') || document.body;
      const bodyText = clean(root?.innerText || document.body?.innerText || '');
      const categoryPaths = [];
      const categoryHints = [];

      [
        'nav[aria-label*="breadcrumb" i]',
        '[data-testid*="breadcrumb" i]',
        '[class*="breadcrumb"]',
        '[typeof="BreadcrumbList"]',
        'ol[aria-label*="breadcrumb" i]',
        'ul[aria-label*="breadcrumb" i]',
      ].forEach((selector) => {
        document.querySelectorAll(selector).forEach((node) => {
          const text = clean(node.innerText || node.textContent || '');
          if (!text) {
            return;
          }
          const normalized = text
            .replace(/\s*(?:>|›|»|\/|\\|\|)\s*/g, ' > ')
            .replace(/\s{2,}/g, ' ')
            .trim();
          pushUnique(categoryPaths, normalized, 220);
        });
      });

      Array.from(document.querySelectorAll('a[href],button,[role="link"]')).forEach((node) => {
        const text = clean(node.innerText || node.textContent || node.getAttribute?.('aria-label') || node.title || '');
        if (!text) {
          return;
        }
        const href = String(node.getAttribute?.('href') || '').toLowerCase();
        const cls = String(node.className || '').toLowerCase();
        const aria = String(node.getAttribute?.('aria-label') || '').toLowerCase();
        const testId = String(node.getAttribute?.('data-testid') || '').toLowerCase();
        if (
          href.includes('/c/') || href.includes('/category/') ||
          cls.includes('breadcrumb') || cls.includes('category') ||
          aria.includes('category') ||
          testId.includes('breadcrumb') || testId.includes('category')
        ) {
          pushUnique(categoryHints, text, 120);
        }
      });

      const seen = new Set();
      const links = Array.from(document.querySelectorAll('a[href]')).map((anchor) => {
        const text = clean(anchor.innerText || anchor.textContent || anchor.getAttribute('aria-label') || anchor.title || '');
        let href = '';
        try {
          href = new URL(anchor.getAttribute('href'), location.href).href;
        } catch {}
        return { text, href };
      }).filter(({ text, href }) => {
        if (!href || !href.startsWith('http') || !text || text.length < 4) {
          return false;
        }
        let linkHost = '';
        try {
          linkHost = new URL(href).hostname.replace(/^www\./, '');
        } catch {}
        if (pageHost && linkHost && pageHost !== linkHost) {
          return false;
        }
        const textLower = text.toLowerCase();
        const hrefLower = href.toLowerCase();
        if (blockedTerms.some((term) => textLower.includes(term) || hrefLower.includes(term))) {
          return false;
        }
        if (blockedHrefBits.some((bit) => hrefLower.includes(bit))) {
          return false;
        }
        if (seen.has(href)) {
          return false;
        }
        seen.add(href);
        return true;
      }).slice(0, 80);

      const categoryText = [
        categoryPaths.length ? `CATEGORY PATHS:\n${categoryPaths.join('\n')}` : '',
        categoryHints.length ? `CATEGORY HINTS:\n${categoryHints.join('\n')}` : '',
      ].filter(Boolean).join('\n\n');
      const linkText = links.length
        ? `\n\nLINKS:\n${links.map(({ text, href }) => `${text} => ${href}`).join('\n')}`
        : '';

      return {
        text: `${bodyText}${categoryText ? `\n\n${categoryText}` : ''}${linkText}`.trim(),
        links,
        categoryPaths,
        categoryHints,
      };
    }, page.url());

    return {
      success: true,
      url: page.url(),
      title: await page.title(),
      text: extracted.text,
      links: extracted.links,
      category_paths: extracted.categoryPaths,
      category_hints: extracted.categoryHints,
      ...(fullHtml ? { html: await page.content() } : {}),
    };
  } finally {
    entry.busyCount = Math.max(0, entry.busyCount - 1);
    entry.lastUsedAt = Date.now();
    if (page) {
      await page.close().catch(() => {});
    }
  }
}

async function handleContextClear(body) {
  const domain = normalizeDomain(body.domain);
  await closeContextEntry(domain, { removeDir: true });
  return { success: true, message: `Context cleared: ${domain}` };
}

async function runStartupWarmup() {
  startupState.warmupAttempted = true;
  const domain = 'warmup.local';
  try {
    await getContextEntry(domain);
    await closeContextEntry(domain, { removeDir: true });
    startupState.warmupSucceeded = true;
    startupState.warmupError = null;
  } catch (error) {
    startupState.warmupSucceeded = false;
    startupState.warmupError = error.message;
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    return res.end(JSON.stringify({
      status: 'ok',
      host: HOST,
      port: PORT,
      engine: 'patchright',
      browser_channel: BROWSER_CHANNEL,
      sandbox: ENABLE_NO_SANDBOX ? 'disabled' : 'enabled',
      idle_ttl_ms: CONTEXT_IDLE_TTL_MS,
      warmup_attempted: startupState.warmupAttempted,
      warmup_succeeded: startupState.warmupSucceeded,
      warmup_error: startupState.warmupError,
      active_contexts: Array.from(contextPool.keys()),
      persisted_contexts: fs.readdirSync(CONTEXTS_DIR),
    }));
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    res.writeHead(error.statusCode || 400);
    return res.end(JSON.stringify({ error: error.message }));
  }

  try {
    let result;
    if (req.url === '/scrape') {
      result = await handleScrape(body);
    } else if (req.url === '/context/clear') {
      result = await handleContextClear(body);
    } else {
      res.writeHead(404);
      return res.end(JSON.stringify({ error: 'Unknown endpoint' }));
    }
    res.writeHead(200);
    res.end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(error.statusCode || 500);
    res.end(JSON.stringify({ success: false, error: error.message }));
  }
});

server.headersTimeout = MAX_TIMEOUT_MS + 5000;
server.requestTimeout = MAX_TIMEOUT_MS + 5000;

async function shutdown(exitCode = 0) {
  clearInterval(contextSweeper);
  const domains = Array.from(contextPool.keys());
  for (const domain of domains) {
    await closeContextEntry(domain);
  }
  server.close(() => process.exit(exitCode));
  setTimeout(() => process.exit(exitCode), 5000).unref?.();
}

async function start() {
  if (WARMUP_ON_START) {
    await runStartupWarmup();
  }

  server.listen(PORT, HOST, () => {
    console.log(`stealth-browser running on http://${HOST}:${PORT}`);
  });
}

process.on('SIGTERM', () => {
  shutdown(0).catch(() => process.exit(1));
});
process.on('SIGINT', () => {
  shutdown(0).catch(() => process.exit(1));
});

start().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
