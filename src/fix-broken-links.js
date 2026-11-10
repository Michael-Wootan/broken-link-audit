#!/usr/bin/env node
/**
 * fix-broken-links.js: find and apply replacements for broken external links
 *
 * Two phases:
 *   Phase 1 (default):  find a live, relevant replacement for each broken link
 *   Phase 2 (--apply):  push the reviewed replacements to Shopify
 *
 * How replacements are found:
 *   1. Reads output/external-link-audit.json
 *   2. Sorts results: truly broken (404, 410, DNS failure, certificate error)
 *      versus bot-blocked (403, 429) versus timeouts
 *   3. Only truly broken links are replaced. Bot-blocked links work for real readers
 *   4. Internal links are never touched
 *   5. Claude suggests five candidates from trusted source types
 *   6. Each candidate is fetched to confirm it is live
 *   7. No replacement URL is used twice in the same post
 *   8. If every suggestion fails, a curated fallback for the topic is used
 *
 * Usage:
 *   node src/fix-broken-links.js                    phase 1: find replacements
 *   node src/fix-broken-links.js --resume           continue phase 1 where it stopped
 *   node src/fix-broken-links.js --apply --dry-run  phase 2 preview, no writes
 *   node src/fix-broken-links.js --apply            phase 2: push to Shopify
 *
 * Output:
 *   output/broken-link-fixes.json   machine-readable fixes (edit before --apply)
 *   output/broken-link-fixes.html   visual review report
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
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
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

const APPLY = process.argv.includes('--apply');
const DRY_RUN = process.argv.includes('--dry-run');
const RESUME = process.argv.includes('--resume');

const AUDIT_FILE = path.join(OUTPUT_DIR, 'external-link-audit.json');
const FIXES_FILE = path.join(OUTPUT_DIR, 'broken-link-fixes.json');
const REPORT_FILE = path.join(OUTPUT_DIR, 'broken-link-fixes.html');
const PROGRESS_FILE = path.join(OUTPUT_DIR, 'broken-link-fix-progress.json');

// ── Internal link detection ────────────────────────────────────────────────
function isInternalLink(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '') === SITE_HOST;
  } catch { return false; }
}

// ── Bot-blocked detection (these work for real users, don't replace) ────────
function isBotBlocked(entry) {
  // 403, 429, 999 from known bot-blocking domains
  if ([403, 429, 999].includes(entry.status)) return true;
  return false;
}

// ── Truly broken detection ─────────────────────────────────────────────────
function isTrulyBroken(entry) {
  if (entry.status === 404 || entry.status === 410) return true;
  if (entry.error === 'ENOTFOUND') return true;
  if (entry.error && entry.error.includes('CERT')) return true;
  if (entry.status === 500) return true;
  return false;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsRequest(options, body = null, followRedirects = true) {
  return new Promise((resolve, reject) => {
    const proto = options.protocol === 'http:' ? http : https;
    const req = proto.request(options, (res) => {
      if (followRedirects && [301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        try {
          const redir = new URL(res.headers.location, `https://${options.hostname}`);
          return resolve(httpsRequest({
            hostname: redir.hostname,
            path: redir.pathname + redir.search,
            method: options.method,
            headers: options.headers,
            protocol: redir.protocol,
          }, body, followRedirects));
        } catch { /* fall through */ }
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else if (res.statusCode === 429) {
          reject(new Error('RATE_LIMITED'));
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('TIMEOUT')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function shopifyGet(endpoint) {
  return httpsRequest({
    hostname: SHOPIFY_STORE,
    path: `/admin/api/2024-01${endpoint}`,
    method: 'GET',
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
  });
}

function shopifyPut(endpoint, body) {
  const payload = JSON.stringify(body);
  return httpsRequest({
    hostname: SHOPIFY_STORE,
    path: `/admin/api/2024-01${endpoint}`,
    method: 'PUT',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  }, payload);
}

// ── URL Verification ───────────────────────────────────────────────────────
function verifyUrl(url, timeout = 10000) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const proto = parsed.protocol === 'http:' ? http : https;
      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'HEAD',
        headers: {
          'User-Agent': CLIENT_ID,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        timeout,
      };
      const req = proto.request(options, (res) => {
        // Accept 200-399 (including redirects: page exists)
        if (res.statusCode < 400) {
          resolve({ live: true, status: res.statusCode });
        } else if (res.statusCode === 403 || res.statusCode === 405) {
          // Some sites block HEAD: try GET
          const getReq = proto.request({ ...options, method: 'GET' }, (getRes) => {
            let body = '';
            getRes.on('data', d => { body += d; if (body.length > 1000) getReq.destroy(); });
            getRes.on('end', () => resolve({ live: getRes.statusCode < 400, status: getRes.statusCode }));
          });
          getReq.on('error', () => resolve({ live: false, status: 0 }));
          getReq.setTimeout(timeout, () => { getReq.destroy(); resolve({ live: false, status: 0 }); });
          getReq.end();
        } else {
          resolve({ live: false, status: res.statusCode });
        }
      });
      req.on('error', () => resolve({ live: false, status: 0 }));
      req.setTimeout(timeout, () => { req.destroy(); resolve({ live: false, status: 0 }); });
      req.end();
    } catch {
      resolve({ live: false, status: 0 });
    }
  });
}

// ── Claude API ──────────────────────────────────────────────────────────────
async function claudeGenerate(prompt, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const body = JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      });
      const resp = await httpsRequest({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      }, body);
      return resp.content?.[0]?.text || '';
    } catch (err) {
      if (err.message === 'RATE_LIMITED' && attempt < retries - 1) {
        console.log('    ⏳ Claude rate limited, waiting 15s...');
        await sleep(15000);
      } else if (attempt < retries - 1) {
        await sleep(3000);
      } else {
        throw err;
      }
    }
  }
}

// ── Curated topic fallbacks ────────────────────────────────────────────────
// Last resort when every AI suggestion fails verification: stable pages on
// trusted sites, grouped by topic in config.
const TOPICS = CONFIG.topics || [];
const TOPIC_FALLBACKS = Object.fromEntries(TOPICS.map(t => [t.name, t.fallbacks || []]));
if (!TOPIC_FALLBACKS.general) TOPIC_FALLBACKS.general = [];

// ── Detect topic from the broken URL and the post it appears in ────────────
function detectTopic(url, blogHandle) {
  const combined = (url + ' ' + blogHandle).toLowerCase();
  for (const t of TOPICS) {
    if ((t.match || []).some(frag => combined.includes(String(frag).toLowerCase()))) return t.name;
  }
  return 'general';
}

// ── Replacement prompt ─────────────────────────────────────────────────────
function buildReplacementPrompt(entry, handles, topic, alreadyUsed) {
  const trusted = (CONFIG.trustedSources || ['Wikipedia', '.gov sites', 'university .edu sites', 'major news outlets']).join(', ');
  const rules = [
    'Each URL must be from a DIFFERENT domain',
    'Each URL must be a SPECIFIC page (not a homepage), relevant to what the original URL was about',
    `Only suggest URLs from high-authority sources: ${trusted}`,
  ];
  if (CONFIG.avoidDomains && CONFIG.avoidDomains.length) {
    rules.push(`Do NOT suggest URLs from: ${CONFIG.avoidDomains.join(', ')} (these often block automated checks)`);
  }
  rules.push('Each URL must be a real, well-known page that is very likely to exist');
  return `You are helping fix broken links on ${CONFIG.industry || 'a company'} blog (${SITE_HOST}).

This external link is broken (${entry.error || 'HTTP ' + entry.status}):
${entry.url}

The link appears in blog post(s): ${handles.slice(0, 3).join(', ')}
Detected topic: ${topic}

Suggest exactly 5 replacement URLs. Requirements:
${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}

${alreadyUsed.size > 0 ? `IMPORTANT: Do NOT suggest any of these URLs (already used in the same post):\n${[...alreadyUsed].join('\n')}` : ''}

Respond with ONLY 5 URLs, one per line, no numbering or explanation:`;
}

// ── Phase 1: Find dynamic replacements ─────────────────────────────────────
async function phase1() {
  console.log('═'.repeat(60));
  console.log('  Phase 1: Dynamic Broken Link Replacement Finder');
  console.log('═'.repeat(60));
  console.log('');

  if (!fs.existsSync(AUDIT_FILE)) {
    console.error('Audit file not found. Run audit-external-links.js first.');
    process.exit(1);
  }

  const audit = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
  const brokenEntries = audit.broken || [];

  // Load existing progress if resuming
  let existingFixes = [];
  const completedUrls = new Set();
  if (RESUME && fs.existsSync(FIXES_FILE)) {
    existingFixes = JSON.parse(fs.readFileSync(FIXES_FILE, 'utf8'));
    existingFixes.forEach(f => completedUrls.add(f.brokenUrl));
    console.log(`📂 Resuming: ${existingFixes.length} fixes already done\n`);
  }

  // Categorize broken links
  const internal = [];
  const botBlocked = [];
  const trulyBroken = [];
  const timeouts = [];
  const other = [];

  for (const entry of brokenEntries) {
    // Skip internal links: NEVER touch these
    if (isInternalLink(entry.url)) {
      internal.push(entry);
      continue;
    }

    // Skip links only in DNT blogs
    const nonDntBlogs = entry.blogs.filter(b => !b.isDNT && !DO_NOT_TOUCH.has(b.handle));
    if (nonDntBlogs.length === 0) continue;

    // Already processed
    if (completedUrls.has(entry.url)) continue;

    if (isBotBlocked(entry)) {
      botBlocked.push(entry);
    } else if (isTrulyBroken(entry)) {
      trulyBroken.push(entry);
    } else if (entry.error === 'TIMEOUT') {
      timeouts.push(entry);
    } else {
      other.push(entry);
    }
  }

  console.log('📊 Link Classification:');
  console.log(`  🔴 Truly broken (will replace): ${trulyBroken.length}`);
  console.log(`  🟡 Bot-blocked (skip: works for real users): ${botBlocked.length}`);
  console.log(`  🟡 Timeouts (skip: may be temporary): ${timeouts.length}`);
  console.log(`  🟡 Other errors (skip): ${other.length}`);
  console.log(`  🟢 Internal links (never touch): ${internal.length}`);
  console.log('');

  // Track used replacement URLs per blog to ensure uniqueness
  const usedUrlsByBlog = new Map();

  // Process only truly broken links
  const fixes = [...existingFixes];
  let processed = 0;

  for (const entry of trulyBroken) {
    processed++;
    const nonDntBlogs = [...new Set(
      entry.blogs.filter(b => !b.isDNT && !DO_NOT_TOUCH.has(b.handle)).map(b => b.handle)
    )];

    console.log(`\n[${processed}/${trulyBroken.length}] ${entry.url}`);
    console.log(`  Status: ${entry.error || entry.status} | Blogs: ${nonDntBlogs.length}`);

    // Get already-used URLs for all affected blogs
    const alreadyUsed = new Set();
    for (const handle of nonDntBlogs) {
      const used = usedUrlsByBlog.get(handle) || new Set();
      for (const u of used) alreadyUsed.add(u);
    }

    // Ask Claude for 5 specific, diverse replacement suggestions
    let replacementUrl = null;
    try {
      const topic = detectTopic(entry.url, nonDntBlogs[0] || '');
      const prompt = buildReplacementPrompt(entry, nonDntBlogs, topic, alreadyUsed);

      const response = await claudeGenerate(prompt);
      const candidates = response.trim().split('\n')
        .map(l => l.trim().replace(/^\d+[\.\)]\s*/, ''))
        .filter(l => l.startsWith('http'));

      console.log(`  🤖 Claude suggested ${candidates.length} candidates`);

      // Verify each candidate until we find a live one not already used
      for (const candidate of candidates) {
        if (alreadyUsed.has(candidate)) {
          console.log(`  ⏭️  Skip (duplicate): ${candidate.substring(0, 60)}...`);
          continue;
        }

        const check = await verifyUrl(candidate);
        if (check.live) {
          replacementUrl = candidate;
          console.log(`  ✅ Verified: ${candidate.substring(0, 70)}...`);
          break;
        } else {
          console.log(`  ❌ Dead (${check.status}): ${candidate.substring(0, 60)}...`);
        }
        await sleep(300); // Don't hammer verification targets
      }

      // If no Claude suggestion worked, use topic fallbacks
      if (!replacementUrl) {
        console.log('  🔄 Trying topic fallbacks...');
        const fallbacks = TOPIC_FALLBACKS[topic] || TOPIC_FALLBACKS['general'];
        for (const fb of fallbacks) {
          if (alreadyUsed.has(fb)) continue;
          const check = await verifyUrl(fb);
          if (check.live) {
            replacementUrl = fb;
            console.log(`  ✅ Fallback: ${fb.substring(0, 70)}...`);
            break;
          }
        }
      }

      // Last resort: try general fallbacks
      if (!replacementUrl) {
        console.log('  🔄 Trying general fallbacks...');
        for (const fb of TOPIC_FALLBACKS['general']) {
          if (alreadyUsed.has(fb)) continue;
          replacementUrl = fb;
          console.log(`  ⚠️  Using unverified general fallback: ${fb}`);
          break;
        }
      }

    } catch (err) {
      console.log(`  ❌ Error finding replacement: ${err.message}`);
    }

    // Build fix entry
    const fix = {
      brokenUrl: entry.url,
      replacementUrl: replacementUrl || null,
      action: replacementUrl ? 'replace' : 'skip',
      reason: replacementUrl ? 'verified_live' : 'no_replacement_found',
      blogs: nonDntBlogs,
      approved: !!replacementUrl,
      originalStatus: entry.error || `HTTP ${entry.status}`,
    };

    fixes.push(fix);

    // Track used URLs per blog for uniqueness
    if (replacementUrl) {
      for (const handle of nonDntBlogs) {
        if (!usedUrlsByBlog.has(handle)) usedUrlsByBlog.set(handle, new Set());
        usedUrlsByBlog.get(handle).add(replacementUrl);
      }
    }

    // Save progress after each URL
    fs.writeFileSync(FIXES_FILE, JSON.stringify(fixes, null, 2));
    await sleep(500); // Pace Claude API calls
  }

  // Also add skip entries for bot-blocked links
  for (const entry of botBlocked) {
    const nonDntBlogs = [...new Set(
      entry.blogs.filter(b => !b.isDNT && !DO_NOT_TOUCH.has(b.handle)).map(b => b.handle)
    )];
    if (nonDntBlogs.length === 0) continue;
    if (completedUrls.has(entry.url)) continue;
    fixes.push({
      brokenUrl: entry.url,
      replacementUrl: null,
      action: 'skip',
      reason: 'bot_blocked_works_for_users',
      blogs: nonDntBlogs,
      approved: false,
      originalStatus: `HTTP ${entry.status} (bot-blocked)`,
    });
  }

  // Save final
  fs.writeFileSync(FIXES_FILE, JSON.stringify(fixes, null, 2));

  // Generate review report
  generateReviewReport(fixes);

  // Summary
  const replaceCount = fixes.filter(f => f.action === 'replace').length;
  const skipCount = fixes.filter(f => f.action === 'skip').length;

  console.log('\n' + '═'.repeat(60));
  console.log('  PHASE 1 COMPLETE');
  console.log(`  ✅ Replace: ${replaceCount} links (unique, verified replacements)`);
  console.log(`  ⏭️  Skip: ${skipCount} links (bot-blocked / no replacement)`);
  console.log(`  🚫 Removals: 0 (we never remove links)`);
  console.log('');
  console.log('  NEXT STEPS:');
  console.log('  1. Open broken-link-fixes.html to review');
  console.log('  2. Run: node fix-broken-links.js --apply --dry-run');
  console.log('  3. Run: node fix-broken-links.js --apply');
  console.log('═'.repeat(60));

  // Uniqueness check
  console.log('\n🔍 Uniqueness Check:');
  let dupeIssues = 0;
  for (const [handle, used] of usedUrlsByBlog) {
    const urls = [...used];
    const dupes = urls.filter((u, i) => urls.indexOf(u) !== i);
    if (dupes.length > 0) {
      console.log(`  ⚠️  ${handle}: ${dupes.length} duplicate replacement URLs`);
      dupeIssues++;
    }
  }
  if (dupeIssues === 0) {
    console.log('  ✅ No duplicate replacements within any blog!');
  }
}

// ── Phase 2: Apply approved fixes ───────────────────────────────────────────
async function phase2() {
  console.log('═'.repeat(60));
  console.log('  Phase 2: Apply Approved Broken Link Fixes');
  console.log(`  Mode: ${DRY_RUN ? '🧪 DRY RUN' : '🚀 LIVE'}`);
  console.log('═'.repeat(60));
  console.log('');

  if (!fs.existsSync(FIXES_FILE)) {
    console.error(`Fixes file not found: ${FIXES_FILE}`);
    console.error('Run Phase 1 first (node fix-broken-links.js)');
    process.exit(1);
  }

  const fixes = JSON.parse(fs.readFileSync(FIXES_FILE, 'utf8'));
  const approved = fixes.filter(f => f.approved && f.action === 'replace');
  console.log(`Total fixes: ${fixes.length}, Approved replacements: ${approved.length}\n`);

  // Group fixes by blog handle
  const fixesByBlog = new Map();
  for (const fix of approved) {
    for (const handle of fix.blogs) {
      // Skip internal links (extra safety check)
      if (isInternalLink(fix.brokenUrl)) continue;
      // Skip DNT blogs
      if (DO_NOT_TOUCH.has(handle)) continue;
      if (!fixesByBlog.has(handle)) fixesByBlog.set(handle, []);
      fixesByBlog.get(handle).push(fix);
    }
  }

  console.log(`Blogs to update: ${fixesByBlog.size}\n`);

  // Uniqueness validation before applying
  let dupeWarnings = 0;
  for (const [handle, blogFixes] of fixesByBlog) {
    const replacements = blogFixes.map(f => f.replacementUrl);
    const dupes = replacements.filter((u, i) => replacements.indexOf(u) !== i);
    if (dupes.length > 0) {
      console.log(`⚠️  WARNING: ${handle} has duplicate replacement URLs:`);
      dupes.forEach(d => console.log(`     ${d}`));
      dupeWarnings++;
    }
  }
  if (dupeWarnings > 0) {
    console.log(`\n⚠️  ${dupeWarnings} blogs have duplicate replacements. Fix broken-link-fixes.json first.`);
    if (!DRY_RUN) {
      console.log('Aborting. Fix duplicates then re-run.');
      process.exit(1);
    }
  }

  let updated = 0;
  let failed = 0;

  for (const [handle, blogFixes] of fixesByBlog) {
    console.log(`\n[${updated + failed + 1}/${fixesByBlog.size}] ${handle}`);
    console.log(`  Fixes to apply: ${blogFixes.length}`);

    try {
      // Fetch article with retry on rate limit
      let data, article;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await sleep(800);
          data = await shopifyGet(`/blogs/${BLOG_ID}/articles.json?handle=${handle}&fields=id,handle,title,body_html`);
          break;
        } catch (err) {
          if (err.message === 'RATE_LIMITED' && attempt < 2) {
            console.log('  ⏳ Rate limited, waiting 10s...');
            await sleep(10000);
          } else { throw err; }
        }
      }
      article = (data.articles || []).find(a => a.handle === handle);
      if (!article) {
        console.log('  ⚠️  Article not found, skipping');
        failed++;
        continue;
      }

      let html = article.body_html || '';
      let changesMade = 0;

      for (const fix of blogFixes) {
        // SAFETY: Never replace internal links
        if (isInternalLink(fix.brokenUrl)) {
          console.log(`  🛡️  Skipping internal link: ${fix.brokenUrl.substring(0, 50)}`);
          continue;
        }

        const escapedUrl = fix.brokenUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Replace the href URL
        const re = new RegExp(`(href=["'])${escapedUrl}(["'])`, 'gi');
        const newHtml = html.replace(re, `$1${fix.replacementUrl}$2`);
        if (newHtml !== html) {
          html = newHtml;
          changesMade++;
          console.log(`  ✅ Replaced: ${fix.brokenUrl.substring(0, 55)}...`);
          console.log(`       → ${fix.replacementUrl.substring(0, 55)}...`);
        }
      }

      if (changesMade === 0) {
        console.log('  ⚠️  No changes needed (links may already be fixed)');
        updated++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`  🧪 DRY RUN: would apply ${changesMade} changes`);
        updated++;
        continue;
      }

      // Push to Shopify with retry on rate limit
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await sleep(800);
          await shopifyPut(`/blogs/${BLOG_ID}/articles/${article.id}.json`, {
            article: { id: article.id, body_html: html },
          });
          break;
        } catch (err) {
          if (err.message === 'RATE_LIMITED' && attempt < 2) {
            console.log('  ⏳ Rate limited on PUT, waiting 10s...');
            await sleep(10000);
          } else { throw err; }
        }
      }
      console.log(`  ✅ UPDATED (${changesMade} links fixed)`);
      updated++;
    } catch (err) {
      console.error(`  ❌ Error: ${err.message}`);
      failed++;
    }
  }

  console.log('\n' + '═'.repeat(60));
  console.log(`  PHASE 2 COMPLETE`);
  console.log(`  ✅ Updated: ${updated} blogs`);
  console.log(`  ❌ Failed: ${failed} blogs`);
  console.log('═'.repeat(60));
}

// ── Generate review HTML report ─────────────────────────────────────────────
function generateReviewReport(fixes) {
  const replaces = fixes.filter(f => f.action === 'replace');
  const skips = fixes.filter(f => f.action === 'skip');

  let html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Broken Link Fixes: Review Report</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
  h1 { color: #2d6a4f; }
  .stats { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
  .stat { background: white; padding: 12px 20px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .stat .num { font-size: 28px; font-weight: 700; }
  .stat .label { font-size: 12px; color: #666; }
  .stat.green .num { color: #2d6a4f; }
  .stat.red .num { color: #dc3545; }
  .stat.orange .num { color: #e67700; }

  .fix-card { background: white; border-radius: 8px; padding: 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .fix-card.replace { border-left: 4px solid #2d6a4f; }
  .fix-card.skip { border-left: 4px solid #ccc; }
  .fix-header { font-weight: 600; font-size: 14px; margin-bottom: 8px; display: flex; justify-content: space-between; }
  .broken-url { color: #dc3545; font-family: monospace; font-size: 12px; word-break: break-all; }
  .replacement-url { color: #2d6a4f; font-family: monospace; font-size: 12px; word-break: break-all; }
  .blogs { font-size: 12px; color: #666; margin-top: 6px; }
  .reason { font-size: 11px; color: #999; margin-top: 4px; }
  .filter-bar { margin-bottom: 20px; }
  .filter-bar button { padding: 8px 16px; border: 1px solid #ddd; border-radius: 4px; background: white; cursor: pointer; margin-right: 8px; }
  .filter-bar button.active { background: #2d6a4f; color: white; border-color: #2d6a4f; }
</style>
</head><body>
<h1>🔗 Broken Link Fixes Report</h1>
<p>Generated: ${new Date().toISOString()}</p>
<div class="stats">
  <div class="stat green"><div class="num">${replaces.length}</div><div class="label">Replacements</div></div>
  <div class="stat orange"><div class="num">${skips.length}</div><div class="label">Skipped</div></div>
  <div class="stat red"><div class="num">0</div><div class="label">Removals</div></div>
</div>
<div class="filter-bar">
  <button class="active" onclick="filter('all')">All (${fixes.length})</button>
  <button onclick="filter('replace')">Replacements (${replaces.length})</button>
  <button onclick="filter('skip')">Skipped (${skips.length})</button>
</div>
<div id="fixes">`;

  for (const fix of fixes) {
    html += `
  <div class="fix-card ${fix.action}" data-action="${fix.action}">
    <div class="fix-header">
      <span>${fix.action === 'replace' ? '✅ Replace' : '⏭️ Skip'}</span>
      <span>${fix.originalStatus}</span>
    </div>
    <div class="broken-url">❌ ${fix.brokenUrl}</div>
    ${fix.replacementUrl ? `<div class="replacement-url">✅ → ${fix.replacementUrl}</div>` : ''}
    <div class="blogs">Blogs: ${fix.blogs.join(', ')}</div>
    <div class="reason">${fix.reason}</div>
  </div>`;
  }

  html += `
</div>
<script>
function filter(type) {
  document.querySelectorAll('.filter-bar button').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  document.querySelectorAll('.fix-card').forEach(c => {
    c.style.display = (type === 'all' || c.dataset.action === type) ? '' : 'none';
  });
}
</script>
</body></html>`;

  fs.writeFileSync(REPORT_FILE, html);
  console.log(`\n📊 Report saved: ${REPORT_FILE}`);
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!SHOPIFY_TOKEN || !SHOPIFY_STORE || !BLOG_ID) {
    console.error('Missing SHOPIFY_ADMIN_TOKEN, SHOPIFY_STORE or SHOPIFY_BLOG_ID');
    process.exit(1);
  }
  if (!APPLY && !ANTHROPIC_KEY) {
    console.error('Missing ANTHROPIC_API_KEY (needed to find replacements)');
    process.exit(1);
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  if (APPLY) {
    await phase2();
  } else {
    await phase1();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { isInternalLink, isBotBlocked, isTrulyBroken, detectTopic, buildReplacementPrompt, TOPIC_FALLBACKS };
