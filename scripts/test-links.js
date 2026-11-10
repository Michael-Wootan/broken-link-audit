#!/usr/bin/env node
// Offline tests for link extraction, broken-link triage, topic detection and
// the replacement prompt. No store, network or API keys needed.
const assert = require('assert');
const path = require('path');
process.env.CONFIG_DIR = path.resolve(__dirname, 'fixtures');
process.env.SITE_URL = 'https://www.acmesupply.example';
const audit = require('../src/audit-external-links.js');
const fix = require('../src/fix-broken-links.js');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

t('external links are extracted with their anchor text', () => {
  const html = '<p>See <a href="https://en.wikipedia.org/wiki/Coffee" target="_blank"><strong>this overview</strong></a> and <a href="/products/espresso-blend">our blend</a>.</p>';
  assert.deepStrictEqual(audit.extractExternalLinks(html), [{ url: 'https://en.wikipedia.org/wiki/Coffee', anchorText: 'this overview' }]);
});

t('links to the site itself and to the store domain are not audited', () => {
  const html = '<a href="https://www.acmesupply.example/pages/about">about</a><a href="https://acmesupply.example/blogs/news/x">x</a><a href="https://acme.myshopify.com/cart">cart</a>';
  assert.deepStrictEqual(audit.extractExternalLinks(html), []);
  assert.strictEqual(fix.isInternalLink('https://www.acmesupply.example/products/x'), true);
  assert.strictEqual(fix.isInternalLink('https://en.wikipedia.org/wiki/Coffee'), false);
});

t('404, 410, DNS failures and certificate errors are truly broken', () => {
  assert.strictEqual(fix.isTrulyBroken({ status: 404 }), true);
  assert.strictEqual(fix.isTrulyBroken({ status: 410 }), true);
  assert.strictEqual(fix.isTrulyBroken({ error: 'ENOTFOUND' }), true);
  assert.strictEqual(fix.isTrulyBroken({ error: 'CERT_HAS_EXPIRED' }), true);
});

t('403 and 429 are bot blocks, not broken links', () => {
  assert.strictEqual(fix.isBotBlocked({ status: 403 }), true);
  assert.strictEqual(fix.isBotBlocked({ status: 429 }), true);
  assert.strictEqual(fix.isTrulyBroken({ status: 403 }), false);
  assert.strictEqual(fix.isTrulyBroken({ status: 200 }), false);
});

t('the topic comes from the broken URL and the post it sits in', () => {
  assert.strictEqual(fix.detectTopic('https://old.example/caffeine-and-sleep', 'afternoon-coffee'), 'health');
  assert.strictEqual(fix.detectTopic('https://old.example/page', 'what-is-espresso-roast'), 'processing');
  assert.strictEqual(fix.detectTopic('https://old.example/page', 'company-news'), 'general');
});

t('every topic has curated fallbacks, including general', () => {
  assert.ok(fix.TOPIC_FALLBACKS.general.length >= 1);
  assert.ok(fix.TOPIC_FALLBACKS.processing.every(u => u.startsWith('https://')));
});

t('the prompt carries the broken URL, numbered rules and URLs already used', () => {
  const prompt = fix.buildReplacementPrompt(
    { url: 'https://old.example/roasting-guide', status: 404 },
    ['what-is-espresso-roast'], 'processing', new Set(['https://en.wikipedia.org/wiki/Coffee_roasting']));
  assert.ok(prompt.includes('https://old.example/roasting-guide') && prompt.includes('HTTP 404'));
  assert.ok(prompt.includes('1. Each URL must be from a DIFFERENT domain'));
  assert.ok(prompt.includes('4. Do NOT suggest URLs from: pinterest.com, quora.com'));
  assert.ok(prompt.includes('5. Each URL must be a real'));
  assert.ok(prompt.includes('already used in the same post') && prompt.includes('Coffee_roasting'));
});

console.log(`\n${n} tests passed`);
