#!/usr/bin/env node
/**
 * Pulls published posts from a WordPress.com site and writes them into _posts/
 * as Jekyll Markdown files. Downloads images locally and rewrites their URLs.
 *
 * Env:
 *   WP_SITE            e.g. imisfer.wordpress.com          (required)
 *   WP_CATEGORY_GATE   category slug that marks a post as ready to publish.
 *                      Leave empty to sync every published post.
 *   WP_TOKEN           optional OAuth token; only needed to read drafts.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const SITE = process.env.WP_SITE;
const GATE = (process.env.WP_CATEGORY_GATE || '').trim();
const TOKEN = process.env.WP_TOKEN || '';

if (!SITE) {
  console.error('WP_SITE is not set.');
  process.exit(1);
}

const API = `https://public-api.wordpress.com/wp/v2/sites/${SITE}`;
const POSTS_DIR = '_posts';
const IMG_ROOT = path.join('assets', 'img', 'posts');

const headers = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

// ---------------------------------------------------------------- helpers

async function api(pathname, params = {}) {
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GET ${url.pathname} -> ${res.status} ${res.statusText}`);
  }
  return { body: await res.json(), totalPages: Number(res.headers.get('x-wp-totalpages') || 1) };
}

/** Filesystem-safe filename fragment. Arabic characters are kept as-is. */
function safeSlug(raw, fallbackId) {
  const decoded = decodeURIComponent(raw || '');
  const cleaned = decoded
    .replace(/[\\/:*?"<>|#%]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .trim();
  return cleaned || `post-${fallbackId}`;
}

/** WordPress serves dates without an offset; treat them as Riyadh time. */
function formatDate(wpDate) {
  return `${wpDate.replace('T', ' ')} +0300`;
}

function decodeEntities(str = '') {
  return str
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html = '') {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- images

const IMAGE_HOST = /(wp\.com|wordpress\.com|files\.wordpress\.com)/i;

async function downloadImage(url, destDir) {
  const clean = url.split('?')[0];
  let name = path.basename(decodeURIComponent(clean)) || 'image';
  name = name.replace(/[\\/:*?"<>|]/g, '');
  const dest = path.join(destDir, name);

  try {
    await fs.access(dest);
    return dest; // already have it
  } catch {
    /* not cached, fall through */
  }

  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`  ! image ${res.status}: ${url}`);
    return null;
  }
  await fs.mkdir(destDir, { recursive: true });
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  console.log(`  + image ${dest}`);
  return dest;
}

/** Replaces remote WordPress image URLs in Markdown with local paths. */
async function localiseImages(markdown, slug) {
  const destDir = path.join(IMG_ROOT, slug);
  const urls = new Set();

  for (const m of markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) urls.add(m[1]);
  for (const m of markdown.matchAll(/<img[^>]+src="([^"]+)"/g)) urls.add(m[1]);

  let out = markdown;
  for (const url of urls) {
    if (!IMAGE_HOST.test(url)) continue;
    const saved = await downloadImage(url, destDir);
    if (saved) out = out.split(url).join('/' + saved.split(path.sep).join('/'));
  }
  return out;
}

// ---------------------------------------------------------------- markdown

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
});
turndown.use(gfm);

// Gutenberg wraps figures in markup Turndown flattens badly; keep the caption.
turndown.addRule('figure', {
  filter: 'figure',
  replacement: (content) => `\n\n${content.trim()}\n\n`,
});
turndown.addRule('figcaption', {
  filter: 'figcaption',
  replacement: (content) => (content.trim() ? `\n*${content.trim()}*\n` : ''),
});
turndown.remove(['script', 'style']);

// ---------------------------------------------------------------- fetching

async function fetchAll(pathname, params = {}) {
  const items = [];
  let page = 1;
  let totalPages = 1;
  do {
    const { body, totalPages: tp } = await api(pathname, { ...params, per_page: 100, page });
    totalPages = tp;
    items.push(...body);
    page += 1;
  } while (page <= totalPages);
  return items;
}

async function resolveGateId() {
  if (!GATE) return null;
  const cats = await fetchAll('/categories', { slug: GATE });
  if (!cats.length) {
    console.error(
      `Category "${GATE}" does not exist on ${SITE}. Create it in the WordPress app, or clear WP_CATEGORY_GATE.`
    );
    process.exit(1);
  }
  return cats[0].id;
}

// ---------------------------------------------------------------- writing

function buildFrontMatter(post, meta) {
  const lines = [
    '---',
    'layout: post',
    `title: ${JSON.stringify(decodeEntities(post.title.rendered))}`,
    `date: ${formatDate(post.date)}`,
    'lang: ar',
    'dir: rtl',
    `wp_id: ${post.id}`,
  ];
  if (meta.excerpt) lines.push(`excerpt: ${JSON.stringify(meta.excerpt)}`);
  if (meta.categories.length) lines.push(`categories: [${meta.categories.map((c) => JSON.stringify(c)).join(', ')}]`);
  if (meta.tags.length) lines.push(`tags: [${meta.tags.map((t) => JSON.stringify(t)).join(', ')}]`);
  if (meta.image) lines.push(`image: ${meta.image}`);
  lines.push('---', '');
  return lines.join('\n');
}

function termNames(post, taxonomy) {
  const groups = post._embedded?.['wp:term'] || [];
  return groups
    .flat()
    .filter((t) => t && t.taxonomy === taxonomy && t.slug !== GATE && t.slug !== 'uncategorized')
    .map((t) => decodeEntities(t.name));
}

async function main() {
  const gateId = await resolveGateId();
  console.log(`Site: ${SITE}${gateId ? `  |  gate: ${GATE} (#${gateId})` : '  |  no category gate'}`);

  const params = { status: 'publish', _embed: '1', orderby: 'date', order: 'desc' };
  if (gateId) params.categories = gateId;

  const posts = await fetchAll('/posts', params);
  console.log(`Fetched ${posts.length} post(s).`);

  await fs.mkdir(POSTS_DIR, { recursive: true });

  const written = new Map(); // wp_id -> filename

  for (const post of posts) {
    const slug = safeSlug(post.slug, post.id);
    const datePart = post.date.slice(0, 10);
    const filename = `${datePart}-${slug}.md`;

    let body = turndown.turndown(post.content.rendered || '');
    body = await localiseImages(body, slug);
    body = body.replace(/\n{3,}/g, '\n\n').trim();

    let image = null;
    const featured = post._embedded?.['wp:featuredmedia']?.[0]?.source_url;
    if (featured) {
      const saved = await downloadImage(featured, path.join(IMG_ROOT, slug));
      if (saved) image = '/' + saved.split(path.sep).join('/');
    }

    const meta = {
      excerpt: stripTags(post.excerpt?.rendered || '').slice(0, 300),
      categories: termNames(post, 'category'),
      tags: termNames(post, 'post_tag'),
      image,
    };

    const contents = buildFrontMatter(post, meta) + body + '\n';
    const target = path.join(POSTS_DIR, filename);

    let previous = null;
    try {
      previous = await fs.readFile(target, 'utf8');
    } catch {
      /* new file */
    }

    if (previous !== contents) {
      await fs.writeFile(target, contents, 'utf8');
      console.log(`  ${previous === null ? 'new  ' : 'edit '} ${filename}`);
    }
    written.set(post.id, filename);
  }

  // Remove posts that came from WordPress but no longer qualify.
  const existing = await fs.readdir(POSTS_DIR).catch(() => []);
  for (const file of existing) {
    if (!file.endsWith('.md')) continue;
    const text = await fs.readFile(path.join(POSTS_DIR, file), 'utf8');
    const match = text.match(/^wp_id:\s*(\d+)\s*$/m);
    if (!match) continue; // hand-written post, leave alone
    const id = Number(match[1]);
    if (written.has(id) && written.get(id) === file) continue;
    await fs.unlink(path.join(POSTS_DIR, file));
    console.log(`  del   ${file}`);
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
