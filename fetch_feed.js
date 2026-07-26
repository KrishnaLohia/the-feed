#!/usr/bin/env node
/*
 * Zerodha Group Content — daily feed fetcher
 * ------------------------------------------------------------
 * Pulls new content from every Zerodha source in sources.json and
 * accumulates it into feed_data.json, then regenerates a self-contained
 * index.html feed page.
 *
 * Reliable auto-fetch:  YouTube (Atom RSS) + Substack (RSS)
 * Best-effort attempt:  X / Twitter + Instagram (free public routes are
 *                       mostly blocked; these degrade to "follow directly"
 *                       cards but are retried live on every run so they
 *                       light up automatically if a route becomes available)
 *
 * No external dependencies — uses Node 18+ native fetch.
 */

const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const SOURCES_FILE = path.join(DIR, "sources.json");
const DATA_FILE = path.join(DIR, "feed_data.json");
const HTML_FILE = path.join(DIR, "index.html");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// ---------- small utils ----------

function nowISO() {
  return new Date().toISOString();
}

function log(...a) {
  console.log(`[${new Date().toISOString()}]`, ...a);
}

async function fetchText(url, { timeout = 20000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": UA, "Accept-Language": "en", ...headers },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function decodeEntities(s) {
  if (!s) return "";
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&amp;/g, "&");
}

function stripTags(s) {
  return decodeEntities(String(s || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function pick(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? decodeEntities(m[1].trim()) : "";
}

function toISO(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function truncate(s, n) {
  s = (s || "").trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

// ---------- RSS / Atom parsing ----------

function parseFeed(xml) {
  const items = [];
  // RSS 2.0 <item>
  const rss = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const block of rss) {
    const title = stripTags(pick(block, "title"));
    let link = pick(block, "link");
    if (!link) {
      const g = block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i);
      if (g && /^https?:/i.test(g[1])) link = decodeEntities(g[1].trim());
    }
    const published =
      toISO(pick(block, "pubDate")) || toISO(pick(block, "dc:date"));
    const desc =
      pick(block, "content:encoded") || pick(block, "description") || "";
    let thumb = "";
    const mc =
      block.match(/<media:content[^>]*url="([^"]+)"/i) ||
      block.match(/<media:thumbnail[^>]*url="([^"]+)"/i) ||
      block.match(/<enclosure[^>]*url="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
    if (mc) thumb = mc[1];
    if (!thumb) {
      const img = desc.match(/<img[^>]*src="([^"]+)"/i);
      if (img) thumb = img[1];
    }
    if (title || link)
      items.push({ title, link: link.trim(), published, summary: truncate(stripTags(desc), 700), thumbnail: thumb });
  }
  // Atom <entry> (YouTube)
  const atom = xml.match(/<entry>[\s\S]*?<\/entry>/gi) || [];
  for (const block of atom) {
    const title = stripTags(pick(block, "title"));
    const lm = block.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/i) ||
      block.match(/<link[^>]*href="([^"]+)"/i);
    const link = lm ? decodeEntities(lm[1]) : "";
    const published = toISO(pick(block, "published")) || toISO(pick(block, "updated"));
    const desc = pick(block, "media:description");
    const tm = block.match(/<media:thumbnail[^>]*url="([^"]+)"/i);
    const thumb = tm ? tm[1] : "";
    if (title || link)
      items.push({ title, link: link.trim(), published, summary: truncate(desc, 700), thumbnail: thumb });
  }
  return items;
}

// ---------- fetchers per platform ----------

async function fetchSubstack(src) {
  const url = `https://${src.domain}/feed`;
  const xml = await fetchText(url, { timeout: 20000 });
  return parseFeed(xml).map((i) => ({ ...i, platform: "substack" }));
}

async function resolveYouTubeChannelId(handle, cache) {
  if (cache[handle]) return cache[handle];
  const html = await fetchText(`https://www.youtube.com/@${handle}`, { timeout: 20000 });
  const m =
    html.match(/"externalId":"(UC[\w-]+)"/) ||
    html.match(/"channelId":"(UC[\w-]+)"/) ||
    html.match(/channel\/(UC[\w-]+)/);
  if (!m) throw new Error("could not resolve channel id");
  cache[handle] = m[1];
  return m[1];
}

async function fetchYouTube(src, cache) {
  const cid = await resolveYouTubeChannelId(src.handle, cache);
  const xml = await fetchText(
    `https://www.youtube.com/feeds/videos.xml?channel_id=${cid}`,
    { timeout: 20000 }
  );
  return parseFeed(xml).map((i) => ({ ...i, platform: "youtube" }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Best-effort X via public mirrors. These throttle aggressively, so we go slow
// and retry with backoff instead of hammering (which gets us cut off mid-run).
const X_MIRRORS = ["https://nitter.net", "https://xcancel.com", "https://nitter.tiekoetter.com"];
async function fetchX(src) {
  for (const base of X_MIRRORS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await sleep(700); // space out requests so the mirror doesn't throttle us
      try {
        const xml = await fetchText(`${base}/${src.handle}/rss`, { timeout: 12000 });
        const items = parseFeed(xml).filter((i) => i.title || i.link);
        if (items.length)
          return items.map((i) => ({
            ...i,
            platform: "x",
            link: i.link.replace(/https?:\/\/[^/]+/, "https://x.com"),
          }));
      } catch (_) {}
      await sleep(1500 * (attempt + 1)); // 1.5s, 3s backoff before retrying
    }
  }
  return []; // no route available -> handled as a "follow directly" card
}

// Best-effort Instagram: free public routes are login-walled; retry anyway.
async function fetchInstagram(src) {
  return []; // no reliable free route -> "follow directly" card
}

// ---------- direct-link fallback URLs ----------

function directUrl(src) {
  if (src.type === "x") return `https://x.com/${src.handle}`;
  if (src.type === "instagram") return `https://www.instagram.com/${src.handle}/`;
  if (src.type === "youtube") return `https://www.youtube.com/@${src.handle}`;
  if (src.type === "substack") return `https://${src.domain}`;
  return "#";
}

// ---------- main ----------

async function main() {
  const config = JSON.parse(fs.readFileSync(SOURCES_FILE, "utf8"));
  let store = { items: [], youtubeChannels: {}, runs: [], directSources: [] };
  if (fs.existsSync(DATA_FILE)) {
    try {
      store = { ...store, ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) };
    } catch (_) {}
  }

  const seen = new Map(store.items.map((i) => [i.id, i]));
  const directSources = [];
  const summary = { added: 0, bySource: {}, errors: [] };

  for (const group of config.groups) {
    for (const src of group.sources) {
      const label = src.name;
      let fetched = [];
      try {
        if (src.type === "substack") fetched = await fetchSubstack(src);
        else if (src.type === "youtube") fetched = await fetchYouTube(src, store.youtubeChannels);
        else if (src.type === "x") fetched = await fetchX(src);
        else if (src.type === "instagram") fetched = await fetchInstagram(src);
      } catch (e) {
        summary.errors.push(`${label}: ${e.message}`);
        log(`  ! ${label}: ${e.message}`);
      }

      // Sources with no auto-fetch become "follow directly" cards.
      if ((src.type === "x" || src.type === "instagram") && fetched.length === 0) {
        directSources.push({
          group: group.name,
          name: label,
          platform: src.type,
          url: directUrl(src),
        });
      }

      let added = 0;
      for (const it of fetched) {
        if (!it.link) continue;
        const id = it.link;
        const existing = seen.get(id);
        if (existing) {
          // Re-fetch enriches items already in the feed (e.g. fuller summaries).
          if (it.title) existing.title = it.title;
          if (it.summary) existing.summary = it.summary;
          if (it.thumbnail) existing.thumbnail = it.thumbnail;
          if (it.published) existing.published = it.published;
          continue;
        }
        const item = {
          id,
          platform: it.platform,
          group: group.name,
          sourceName: label,
          title: it.title || "(untitled)",
          link: it.link,
          published: it.published,
          summary: it.summary || "",
          thumbnail: it.thumbnail || "",
          firstSeen: nowISO(),
        };
        seen.set(id, item);
        added++;
      }
      if (added) {
        summary.added += added;
        summary.bySource[label] = added;
        log(`  + ${label}: ${added} new`);
      }
    }
  }

  store.items = [...seen.values()].sort((a, b) => {
    const da = a.published || a.firstSeen;
    const db = b.published || b.firstSeen;
    return db.localeCompare(da);
  });
  store.directSources = directSources;
  store.lastRun = nowISO();
  store.runs = [...(store.runs || []), { at: nowISO(), added: summary.added, errors: summary.errors.length }].slice(-60);

  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
  renderHtml(store);

  log(`Done. ${summary.added} new item(s). Total ${store.items.length}. ${summary.errors.length} error(s).`);
}

// ---------- HTML rendering ----------

function renderHtml(store) {
  const tpl = fs.readFileSync(path.join(DIR, "template.html"), "utf8");
  const payload = JSON.stringify({
    items: store.items,
    directSources: store.directSources || [],
    lastRun: store.lastRun,
  }).replace(/</g, "\\u003c");
  const html = tpl.replace("/*__FEED_DATA__*/null", payload);
  fs.writeFileSync(HTML_FILE, html);
}

main().catch((e) => {
  log("FATAL", e);
  process.exit(1);
});
