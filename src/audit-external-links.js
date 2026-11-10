#!/usr/bin/env node
/**
 * audit-external-links.js: crawl every blog article, extract its external
 * links, check each one, and write an HTML report plus a JSON file for the fixer.
 *
 * Posts listed as protected in config are still audited. The report marks them
 * so nobody edits a post that is ranking well.
 *
 * Usage:
 *   node src/audit-external-links.js                   full audit
 *   node src/audit-external-links.js --concurrency 10  check 10 URLs at once (default 5)
 *   node src/audit-external-links.js --timeout 10000   10s timeout per URL (default 8000)
 *
 * Output: output/external-link-audit.html and output/external-link-audit.json
 */

const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');

require('dotenv').config({ quiet: true });

const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const BLOG_ID = process.env.SHOPIFY_BLOG_ID || '';
const CONFIG_DIR = process.env.CONFIG_DIR || path.resolve(__dirname, '..', 'config');
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.resolve(__dirname, '..', 'output');
const SITE_URL   = (process.env.SITE_URL || 'https://www.acmesupply.example').replace(/\/+$/, '');
const SITE_HOST  = new URL(SITE_URL).hostname.replace(/^www\./, '');
const BLOG_HANDLE = process.env.SHOPIFY_BLOG_HANDLE || 'news';
const CLIENT_ID  = process.env.CLIENT_ID || 'link-audit/1.0';

// config/link-audit.json (falls back to the example):
//   protectedHandles  posts that must not be edited (for example top-ranking ones)
//   industry          one phrase describing the blog, used in the replacement prompt
//   trustedSources    the kinds of sites replacements may come from
//   avoidDomains      sites never suggested (they tend to block automated checks)
//   topics            [{ name, match: [fragments], fallbacks: [urls] }], first match wins;
//                     a topic named "general" is the last resort
function loadConfig() {
  for (const f of ['link-audit.json', 'link-audit.example.json']) {
    const p = path.join(CONFIG_DIR, f);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  return {};
}
const CONFIG = loadConfig();
const DO_NOT_TOUCH = new Set(CONFIG.protectedHandles || []);

const CONCURRENCY_IDX = process.argv.indexOf('--concurrency');
const CONCURRENCY = CONCURRENCY_IDX !== -1 ? parseInt(process.argv[CONCURRENCY_IDX + 1]) : 5;
const TIMEOUT_IDX = process.argv.indexOf('--timeout');
const URL_TIMEOUT = TIMEOUT_IDX !== -1 ? parseInt(process.argv[TIMEOUT_IDX + 1]) : 8000;


function shopifyGet(endpoint) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: SHOPIFY_STORE,
      path: `/admin/api/2024-01${endpoint}`,
      method: 'GET',
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Fetch all articles (paginated) ──────────────────────────────────────────
async function fetchAllArticles() {
  const all = [];
  let sinceId = 0;
  let page = 1;
  while (true) {
    const ep = sinceId
      ? `/blogs/${BLOG_ID}/articles.json?limit=250&since_id=${sinceId}&fields=id,handle,title,body_html`
      : `/blogs/${BLOG_ID}/articles.json?limit=250&fields=id,handle,title,body_html`;
    const data = await shopifyGet(ep);
    const arts = data.articles || [];
    if (arts.length === 0) break;
    all.push(...arts);
    sinceId = arts[arts.length - 1].id;
    console.log(`  Fetched page ${page}: ${arts.length} articles (total: ${all.length})`);
    page++;
    await sleep(500);
  }
  return all;
}

// ── Extract external links from HTML ────────────────────────────────────────
function extractExternalLinks(html) {
  if (!html) return [];
  const links = [];
  const re = /<a\s[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    const anchorHtml = m[2];
    // Strip HTML tags from anchor text
    const anchorText = anchorHtml.replace(/<[^>]+>/g, '').trim();
    // Skip internal links
    try {
      const parsed = new URL(url);
      if (parsed.hostname.replace(/^www\./, '') === SITE_HOST) continue;
      if (parsed.hostname.includes('myshopify.com')) continue;
    } catch { continue; }
    links.push({ url, anchorText });
  }
  return links;
}

// ── Check a single URL ──────────────────────────────────────────────────────
function checkUrl(url) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    try {
      const parsed = new URL(url);
      const client = parsed.protocol === 'https:' ? https : http;
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'HEAD',
        timeout: URL_TIMEOUT,
        headers: {
          'User-Agent': CLIENT_ID,
          'Accept': '*/*',
        },
      };

      const req = client.request(options, (res) => {
        const elapsed = Date.now() - startTime;
        // If HEAD returns 405 Method Not Allowed, try GET
        if (res.statusCode === 405) {
          checkUrlGet(url).then(resolve);
          return;
        }
        resolve({
          url,
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 400,
          redirect: res.statusCode >= 300 && res.statusCode < 400 ? res.headers.location : null,
          elapsed,
          error: null,
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ url, status: 0, ok: false, redirect: null, elapsed: URL_TIMEOUT, error: 'TIMEOUT' });
      });

      req.on('error', (err) => {
        const elapsed = Date.now() - startTime;
        resolve({ url, status: 0, ok: false, redirect: null, elapsed, error: err.code || err.message });
      });

      req.end();
    } catch (err) {
      resolve({ url, status: 0, ok: false, redirect: null, elapsed: 0, error: 'INVALID_URL' });
    }
  });
}

function checkUrlGet(url) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    try {
      const parsed = new URL(url);
      const client = parsed.protocol === 'https:' ? https : http;
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        timeout: URL_TIMEOUT,
        headers: {
          'User-Agent': CLIENT_ID,
          'Accept': 'text/html',
        },
      };

      const req = client.request(options, (res) => {
        // Consume body so connection closes
        res.on('data', () => {});
        res.on('end', () => {
          const elapsed = Date.now() - startTime;
          resolve({
            url,
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 400,
            redirect: res.statusCode >= 300 && res.statusCode < 400 ? res.headers.location : null,
            elapsed,
            error: null,
          });
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ url, status: 0, ok: false, redirect: null, elapsed: URL_TIMEOUT, error: 'TIMEOUT' });
      });

      req.on('error', (err) => {
        const elapsed = Date.now() - startTime;
        resolve({ url, status: 0, ok: false, redirect: null, elapsed, error: err.code || err.message });
      });

      req.end();
    } catch (err) {
      resolve({ url, status: 0, ok: false, redirect: null, elapsed: 0, error: 'INVALID_URL' });
    }
  });
}

// ── Concurrent URL checker ──────────────────────────────────────────────────
async function checkUrlsBatch(urls, concurrency) {
  const results = new Map();
  const queue = [...new Set(urls)]; // dedupe
  let idx = 0;
  let completed = 0;
  const total = queue.length;

  async function worker() {
    while (idx < queue.length) {
      const i = idx++;
      const url = queue[i];
      if (results.has(url)) continue;
      const result = await checkUrl(url);
      results.set(url, result);
      completed++;
      if (completed % 25 === 0 || completed === total) {
        const broken = [...results.values()].filter(r => !r.ok).length;
        console.log(`  Checked ${completed}/${total} URLs (${broken} broken so far)`);
      }
    }
  }

  const workers = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return results;
}

// ── Generate HTML report ────────────────────────────────────────────────────
function generateReport(blogData, urlResults) {
  let totalLinks = 0;
  let brokenLinks = 0;
  let brokenOnDNT = 0;
  let brokenOnFixable = 0;
  let uniqueDomains = new Set();

  const blogEntries = [];

  for (const blog of blogData) {
    const brokenInBlog = [];
    const okInBlog = [];

    for (const link of blog.links) {
      totalLinks++;
      const result = urlResults.get(link.url);
      try { uniqueDomains.add(new URL(link.url).hostname); } catch {}

      if (result && !result.ok) {
        brokenLinks++;
        if (blog.isDNT) brokenOnDNT++;
        else brokenOnFixable++;
        brokenInBlog.push({ ...link, ...result });
      } else {
        okInBlog.push({ ...link, ...result });
      }
    }

    if (brokenInBlog.length > 0 || blog.links.length > 0) {
      blogEntries.push({
        ...blog,
        broken: brokenInBlog,
        ok: okInBlog,
      });
    }
  }

  // Sort: blogs with broken links first, then by broken count desc
  blogEntries.sort((a, b) => {
    if (a.broken.length && !b.broken.length) return -1;
    if (!a.broken.length && b.broken.length) return 1;
    return b.broken.length - a.broken.length;
  });

  const blogsWithBroken = blogEntries.filter(b => b.broken.length > 0);

  let html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>External Link Audit</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 1400px; margin: 0 auto; padding: 20px; background: #f5f5f5; color: #1a1a1a; }
  h1 { color: #2d6a4f; }
  .stats { display: flex; gap: 16px; margin-bottom: 30px; flex-wrap: wrap; }
  .stat { background: white; padding: 14px 20px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); min-width: 140px; }
  .stat .num { font-size: 28px; font-weight: 700; }
  .stat .label { font-size: 12px; color: #666; margin-top: 4px; }
  .stat.red .num { color: #dc3545; }
  .stat.orange .num { color: #e67700; }
  .stat.green .num { color: #2d6a4f; }

  .filters { margin-bottom: 20px; display: flex; gap: 10px; flex-wrap: wrap; }
  .filters button { padding: 8px 16px; border: 1px solid #ccc; background: white; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .filters button.active { background: #2d6a4f; color: white; border-color: #2d6a4f; }

  .search { padding: 10px 16px; font-size: 14px; border: 1px solid #ccc; border-radius: 6px; width: 300px; margin-bottom: 20px; }

  .blog-card { background: white; border-radius: 8px; padding: 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .blog-card.has-broken { border-left: 4px solid #dc3545; }
  .blog-card.all-ok { border-left: 4px solid #2d6a4f; }
  .blog-card.dnt { opacity: 0.7; }

  .blog-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .blog-title { font-weight: 600; font-size: 14px; }
  .blog-meta { font-size: 12px; color: #888; }
  .blog-link { font-size: 12px; }
  .dnt-badge { background: #dc3545; color: white; font-size: 10px; padding: 2px 8px; border-radius: 10px; margin-left: 8px; }
  .fixable-badge { background: #2d6a4f; color: white; font-size: 10px; padding: 2px 8px; border-radius: 10px; margin-left: 8px; }

  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
  th { text-align: left; padding: 6px 8px; background: #f8f8f8; border-bottom: 1px solid #ddd; font-weight: 600; }
  td { padding: 6px 8px; border-bottom: 1px solid #eee; vertical-align: top; }
  .url-cell { max-width: 400px; word-break: break-all; }
  .anchor-cell { max-width: 200px; }
  .status-ok { color: #2d6a4f; font-weight: 600; }
  .status-broken { color: #dc3545; font-weight: 600; }
  .status-redirect { color: #e67700; font-weight: 600; }
  .status-timeout { color: #888; font-weight: 600; }
  .error-detail { font-size: 11px; color: #888; }
</style>
</head><body>
<h1>External Link Audit</h1>
<p>Generated ${new Date().toISOString().split('T')[0]}. Shows all external links found in blog body HTML. Broken links sorted first.</p>

<div class="stats">
  <div class="stat"><div class="num">${blogData.length}</div><div class="label">Blogs Scanned</div></div>
  <div class="stat"><div class="num">${totalLinks}</div><div class="label">External Links</div></div>
  <div class="stat"><div class="num">${uniqueDomains.size}</div><div class="label">Unique Domains</div></div>
  <div class="stat red"><div class="num">${brokenLinks}</div><div class="label">Broken Links</div></div>
  <div class="stat green"><div class="num">${brokenOnFixable}</div><div class="label">Broken (fixable blogs)</div></div>
  <div class="stat orange"><div class="num">${brokenOnDNT}</div><div class="label">Broken (DO NOT TOUCH)</div></div>
  <div class="stat"><div class="num">${blogsWithBroken.length}</div><div class="label">Blogs with Broken</div></div>
</div>

<input type="text" class="search" placeholder="Search by blog title, URL, or domain..." oninput="filterCards(this.value)">

<div class="filters">
  <button class="active" onclick="showAll(this)">All with Broken (${blogsWithBroken.length})</button>
  <button onclick="showCategory(this, 'fixable')">Fixable (${blogsWithBroken.filter(b => !b.isDNT).length})</button>
  <button onclick="showCategory(this, 'dnt')">DO NOT TOUCH (${blogsWithBroken.filter(b => b.isDNT).length})</button>
  <button onclick="showEverything(this)">All Blogs (${blogEntries.length})</button>
</div>

<div id="cards">
`;

  for (const blog of blogEntries) {
    const hasBroken = blog.broken.length > 0;
    const cardClass = hasBroken ? 'has-broken' : 'all-ok';
    const dntClass = blog.isDNT ? 'dnt' : '';
    const badge = blog.isDNT
      ? '<span class="dnt-badge">DO NOT TOUCH</span>'
      : '<span class="fixable-badge">FIXABLE</span>';
    const displayStyle = hasBroken ? '' : 'style="display:none"';

    html += `
<div class="blog-card ${cardClass} ${dntClass}" data-type="${blog.isDNT ? 'dnt' : 'fixable'}" data-has-broken="${hasBroken}" data-search="${(blog.title + ' ' + blog.handle + ' ' + blog.links.map(l => l.url).join(' ')).toLowerCase()}" ${displayStyle}>
  <div class="blog-header">
    <div>
      <span class="blog-title">${blog.title}</span>
      ${hasBroken ? badge : ''}
    </div>
    <a class="blog-link" href="${SITE_URL}/blogs/${BLOG_HANDLE}/${blog.handle}" target="_blank">View live ↗</a>
  </div>
  <div class="blog-meta">${blog.handle}: ${blog.links.length} external links, ${blog.broken.length} broken</div>
`;

    if (blog.broken.length > 0) {
      html += `<table><tr><th>Status</th><th>URL</th><th>Anchor Text</th><th>Detail</th></tr>`;
      for (const link of blog.broken) {
        const statusClass = link.error === 'TIMEOUT' ? 'status-timeout' : 'status-broken';
        const statusText = link.error ? link.error : link.status;
        const detail = link.redirect ? `→ ${link.redirect}` : (link.error || '');
        html += `<tr>
          <td class="${statusClass}">${statusText}</td>
          <td class="url-cell"><a href="${link.url}" target="_blank">${link.url}</a></td>
          <td class="anchor-cell">${link.anchorText || '(no text)'}</td>
          <td class="error-detail">${detail}</td>
        </tr>`;
      }
      html += `</table>`;
    }

    html += `</div>\n`;
  }

  html += `
</div>

<script>
function showAll(btn) {
  document.querySelectorAll('.filters button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.blog-card').forEach(c => {
    c.style.display = c.dataset.hasBroken === 'true' ? '' : 'none';
  });
}
function showCategory(btn, cat) {
  document.querySelectorAll('.filters button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.blog-card').forEach(c => {
    c.style.display = (c.dataset.hasBroken === 'true' && c.dataset.type === cat) ? '' : 'none';
  });
}
function showEverything(btn) {
  document.querySelectorAll('.filters button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.blog-card').forEach(c => c.style.display = '');
}
function filterCards(q) {
  q = q.toLowerCase();
  document.querySelectorAll('.blog-card').forEach(c => {
    c.style.display = c.dataset.search.includes(q) ? '' : 'none';
  });
}
</script>
</body></html>`;

  return html;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('═'.repeat(60));
  if (!SHOPIFY_TOKEN || !SHOPIFY_STORE || !BLOG_ID) {
    console.error('Missing SHOPIFY_ADMIN_TOKEN, SHOPIFY_STORE or SHOPIFY_BLOG_ID');
    process.exit(1);
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log('  External Link Audit');
  console.log(`  Concurrency: ${CONCURRENCY}`);
  console.log(`  Timeout: ${URL_TIMEOUT}ms`);
  console.log('═'.repeat(60));
  console.log('');

  // Step 1: Fetch all articles
  console.log('Step 1: Fetching all blog articles...');
  const articles = await fetchAllArticles();
  console.log(`  Total: ${articles.length}\n`);

  // Step 2: Extract external links
  console.log('Step 2: Extracting external links...');
  const blogData = [];
  const allUrls = [];

  for (const article of articles) {
    const links = extractExternalLinks(article.body_html);
    if (links.length > 0) {
      blogData.push({
        handle: article.handle,
        title: article.title,
        id: article.id,
        isDNT: DO_NOT_TOUCH.has(article.handle),
        links,
      });
      for (const l of links) allUrls.push(l.url);
    }
  }

  const uniqueUrls = [...new Set(allUrls)];
  console.log(`  Blogs with external links: ${blogData.length}`);
  console.log(`  Total external links: ${allUrls.length}`);
  console.log(`  Unique URLs to check: ${uniqueUrls.length}\n`);

  // Step 3: Check all URLs
  console.log('Step 3: Checking URLs for broken links...');
  const urlResults = await checkUrlsBatch(uniqueUrls, CONCURRENCY);

  const broken = [...urlResults.values()].filter(r => !r.ok);
  console.log(`\n  Results: ${broken.length} broken out of ${uniqueUrls.length} unique URLs\n`);

  // Step 4: Generate report
  console.log('Step 4: Generating report...');
  const html = generateReport(blogData, urlResults);

  const outPath = path.join(OUTPUT_DIR, 'external-link-audit.html');
  fs.writeFileSync(outPath, html, 'utf8');
  console.log(`  Report saved: ${outPath}`);

  // Also save raw JSON for programmatic use
  const jsonData = {
    generated: new Date().toISOString(),
    summary: {
      totalBlogs: blogData.length,
      totalLinks: allUrls.length,
      uniqueUrls: uniqueUrls.length,
      brokenCount: broken.length,
    },
    broken: broken.map(r => ({
      url: r.url,
      status: r.status,
      error: r.error,
      blogs: blogData
        .filter(b => b.links.some(l => l.url === r.url))
        .map(b => ({ handle: b.handle, isDNT: b.isDNT })),
    })),
  };
  const jsonPath = path.join(OUTPUT_DIR, 'external-link-audit.json');
  fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2));
  console.log(`  JSON data: ${jsonPath}`);

  console.log('\n' + '═'.repeat(60));
  console.log(`  DONE: Open external-link-audit.html in your browser`);
  console.log('═'.repeat(60));
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { extractExternalLinks };
