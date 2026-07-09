/**
 * Link Shortener — ESM module
 * -----------------------------------
 * Usage:
 * import LinkShortener from './linkShortener.mjs';
 *
 * const ls = new LinkShortener({ file: './links.json' }); // optional persistence
 *
 * const short = ls.shorten('https://example.com/very/long/link', '1d');
 * // short => { code: 'aB3xQ9', short: 'go/aB3xQ9', url: '...', expiresAt: 173... }
 *
 * const original = ls.unshorten('go/aB3xQ9'); // or just 'aB3xQ9'
 * // original => 'https://example.com/very/long/link'  (or null if not found/expired)
 *
 * ls.delete('aB3xQ9');
 * ls.list();      // all non-expired links
 * ls.cleanup();   // manually purge expired links
 * ls.stop();      // stop background cleanup timer on shutdown
 *
 * Auto-expiry: pass a duration string ('10m','1h','1d','7d','30d') or ms number
 * or null for never. Expired links are auto-skipped by unshorten()/list(),
 * and a background timer purges them from storage periodically.
 *
 * Requires Node with ESM support. Either name the file .mjs, or set
 * "type": "module" in package.json and use a .js extension.
 */

import fs from 'fs';

const DURATIONS = {
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

function parseDuration(input) {
  if (input === null || input === undefined) return null; // never expires
  if (typeof input === 'number') return input;
  const match = /^(\d+)([mhd])$/.exec(String(input).trim());
  if (!match) throw new Error(`Invalid duration "${input}". Use formats like '10m', '1h', '7d', or a number of ms.`);
  const [, num, unit] = match;
  return parseInt(num, 10) * DURATIONS[unit];
}

function genCode(len = 6) {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export default class LinkShortener {
  /**
   * @param {Object} opts
   * @param {string} [opts.file] - path to JSON file for persistence. If omitted, in-memory only.
   * @param {string} [opts.prefix] - prefix shown in short links (default 'go/')
   * @param {number} [opts.codeLength] - length of generated codes (default 6)
   * @param {string|number|null} [opts.defaultExpiry] - default expiry for new links (default '1d')
   * @param {number} [opts.cleanupIntervalMs] - how often to auto-purge expired links (default 5 min). Set 0 to disable.
   */
  constructor(opts = {}) {
    this.file = opts.file || null;
    this.prefix = opts.prefix || 'go/';
    this.codeLength = opts.codeLength || 6;
    this.defaultExpiry = opts.defaultExpiry !== undefined ? opts.defaultExpiry : '1d';
    this.links = new Map(); // code -> { url, created, expiresAt }

    this._load();

    const interval = opts.cleanupIntervalMs !== undefined ? opts.cleanupIntervalMs : 5 * 60 * 1000;
    if (interval > 0) {
      this._timer = setInterval(() => this.cleanup(), interval);
      if (this._timer.unref) this._timer.unref();
    }
  }

  _load() {
    if (!this.file) return;
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        for (const [code, entry] of Object.entries(raw)) {
          this.links.set(code, entry);
        }
      }
    } catch (err) {
      console.error('[LinkShortener] Failed to load file:', err.message);
    }
  }

  _save() {
    if (!this.file) return;
    try {
      const obj = Object.fromEntries(this.links);
      fs.writeFileSync(this.file, JSON.stringify(obj, null, 2));
    } catch (err) {
      console.error('[LinkShortener] Failed to save file:', err.message);
    }
  }

  _isExpired(entry) {
    return entry.expiresAt !== null && entry.expiresAt <= Date.now();
  }

  // 🛠️ UPDATED: Sahi se dono format (?go=code aur /go/code) ko handle karne ke liye
  _extractCode(input) {
    if (!input) return '';
    let trimmed = String(input).trim();
    if (trimmed.includes('?go=')) {
      const urlParts = trimmed.split('?go=');
      trimmed = urlParts[urlParts.length - 1];
    }
    const parts = trimmed.split('/');
    return parts[parts.length - 1];
  }

  /**
   * Shorten a URL.
   * @param {string} url
   * @param {string|number|null} [expiry] - overrides defaultExpiry. '1h','7d', ms number, or null for never.
   * @returns {{code: string, short: string, url: string, expiresAt: number|null}}
   */
  shorten(url, expiry) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new Error('Invalid URL — must start with http:// or https://');
    }
    let code = genCode(this.codeLength);
    while (this.links.has(code)) code = genCode(this.codeLength);

    const ms = parseDuration(expiry !== undefined ? expiry : this.defaultExpiry);
    const expiresAt = ms === null ? null : Date.now() + ms;

    const entry = { url, created: Date.now(), expiresAt };
    this.links.set(code, entry);
    this._save();

    return { code, short: this.prefix + code, url, expiresAt };
  }

  /**
   * Resolve a short code/link back to the original URL.
   * @param {string} shortOrCode - e.g. 'go/aB3xQ9' or just 'aB3xQ9'
   * @returns {string|null} original URL, or null if not found / expired
   */
  unshorten(shortOrCode) {
    const code = this._extractCode(shortOrCode);
    const entry = this.links.get(code);
    if (!entry) return null;
    if (this._isExpired(entry)) return null;
    return entry.url;
  }

  /** Get full info about a code (even if expired). */
  get(shortOrCode) {
    const code = this._extractCode(shortOrCode);
    const entry = this.links.get(code);
    if (!entry) return null;
    return { code, short: this.prefix + code, ...entry, expired: this._isExpired(entry) };
  }

  delete(shortOrCode) {
    const code = this._extractCode(shortOrCode);
    const deleted = this.links.delete(code);
    if (deleted) this._save();
    return deleted;
  }

  /** List all non-expired links. */
  list() {
    const out = [];
    for (const [code, entry] of this.links) {
      if (!this._isExpired(entry)) {
        out.push({ code, short: this.prefix + code, ...entry });
      }
    }
    return out.sort((a, b) => b.created - a.created);
  }

  /** Remove expired links from storage. Returns number removed. */
  cleanup() {
    let removed = 0;
    for (const [code, entry] of this.links) {
      if (this._isExpired(entry)) {
        this.links.delete(code);
        removed++;
      }
    }
    if (removed > 0) this._save();
    return removed;
  }

  /** Stop the background cleanup timer (call on shutdown if needed). */
  stop() {
    if (this._timer) clearInterval(this._timer);
  }
}

// ---- quick demo when run directly: `node linkShortener.mjs` ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const ls = new LinkShortener({ file: './links.demo.json', defaultExpiry: '1d' });

  const s1 = ls.shorten('https://example.com/some/very/long/path?query=123');
  console.log('Shortened:', s1);

  const original = ls.unshorten(s1.code);
  console.log('Unshortened:', original);

  const s2 = ls.shorten('https://example.com/expires-fast', '1m');
  console.log('Shortened (1m expiry):', s2);

  console.log('All links:', ls.list());

  ls.stop();
}
