#!/usr/bin/env node
/**
 * refresh-places.js
 *
 * Places Details API で各店舗の写真・レビュー・評価を取得し、
 * `public/data/places.json` に保存する。月1回 or 新店追加時のみキャプション再生成。
 *
 * 過去のGCP 23万円請求事件を踏まえ、API呼び出しにハードリミットを設けている。
 *
 * Usage:
 *   GOOGLE_MAPS_API_KEY=xxx ANTHROPIC_API_KEY=xxx node scripts/refresh-places.js
 *
 * Options:
 *   --dry-run         API呼び出しせず対象一覧のみ表示
 *   --sample N        先頭N店舗だけ処理（テスト用）
 *   --shop <slug>     特定店舗だけ処理
 *   --no-caption      キャプション生成をスキップ（Places API動作確認のみ）
 *   --force-caption   30日以内エントリでもキャプション再生成
 *   --via-claude-cli  Anthropic API直叩きでなく `claude -p` でサブスク認証経由（ローカル運用）
 *   --debug-photos    写真スコアリングの採用/不採用理由を表示
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CSV_PATH = path.resolve(__dirname, '../public/data/beppu-restaurants.csv');
const PLACES_PATH = path.resolve(__dirname, '../public/data/places.json');

const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const NO_CAPTION = args.includes('--no-caption');
const FORCE_CAPTION = args.includes('--force-caption');
const VIA_CLAUDE_CLI = args.includes('--via-claude-cli');
const DEBUG_PHOTOS = args.includes('--debug-photos');
const SAMPLE_N = (() => {
  const idx = args.indexOf('--sample');
  if (idx === -1) return null;
  const n = parseInt(args[idx + 1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
})();
const ONLY_SHOP = (() => {
  const idx = args.indexOf('--shop');
  return idx === -1 ? null : args[idx + 1];
})();

// --- 23万円事件への防御: 1実行あたりのハードリミット ---
const MAX_DETAILS_CALLS = 60;     // 40店舗 + 余裕
const MAX_PHOTO_HEAD_CALLS = 300; // 40店舗 × 5枚 + 余裕
const MAX_ANTHROPIC_CALLS = 60;
let detailsCallCount = 0;
let photoHeadCount = 0;
let anthropicCallCount = 0;

const CAPTION_REGEN_DAYS = 30;
const CAPTION_MODEL = 'claude-opus-4-7';
const PHOTO_MAX_WIDTH = 1600;
const PHOTOS_PER_SHOP = 5;

// --- CSV Parser (refresh-hours.js から流用) ---
function* parseCsvRows(text) {
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { field += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        row.push(field); field = '';
        if (ch === '\r' && text[i + 1] === '\n') i++;
        if (row.length > 0) { yield row; row = []; }
      } else { field += ch; }
    }
  }
  row.push(field);
  if (row.length > 0 && row.some(c => c.trim() !== '')) yield row;
}

function loadShopsFromCsv(filePath) {
  let text = fs.readFileSync(filePath, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const iter = parseCsvRows(text);
  const headerRow = iter.next().value;
  if (!headerRow) throw new Error('CSV is empty');
  const headers = headerRow.map(h => h.trim());
  const shops = [];
  for (const row of iter) {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (row[i] || '').trim(); });
    const name = obj['タイトル'];
    const slug = obj['URL内スラッグ'] || '';
    const placeId = obj['推定_place_id'] || '';
    if (!name || !placeId) continue;
    shops.push({
      id: slug || name,
      name,
      placeId,
      category: obj['タグ'] || obj['カテゴリ'] || '',
      reviewSummary: obj['レビュー要約文'] || '',
      googleMapUrl: obj['GoogleマップURL'] || '',
    });
  }
  return shops;
}

// --- HTTP ---
async function httpGetJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

async function httpHeadFollow(url) {
  // Place Photo APIは302で実画像URLにリダイレクトする。
  // redirect: 'manual' でLocationヘッダだけ取って課金を最小化（画像bodyは取らない）。
  const res = await fetch(url, { method: 'GET', redirect: 'manual' });
  if (res.status === 302 || res.status === 301) {
    const location = res.headers.get('location');
    if (location) return location;
  }
  // 直接200で返るケースもあり得るのでその場合はリクエストURLをそのまま返す
  if (res.ok) return url;
  throw new Error(`Photo HEAD failed: ${res.status}`);
}

// --- Places API (Legacy) ---
async function fetchPlaceDetails(placeId) {
  if (detailsCallCount >= MAX_DETAILS_CALLS) {
    throw new Error(`MAX_DETAILS_CALLS (${MAX_DETAILS_CALLS}) exceeded — aborting to prevent runaway billing`);
  }
  detailsCallCount++;
  const params = new URLSearchParams({
    place_id: placeId,
    fields: 'photos,reviews,rating,user_ratings_total,editorial_summary,name',
    language: 'ja',
    key: GOOGLE_KEY,
  });
  const url = `https://maps.googleapis.com/maps/api/place/details/json?${params}`;
  return httpGetJson(url);
}

async function resolvePhotoUrl(photoReference) {
  if (photoHeadCount >= MAX_PHOTO_HEAD_CALLS) {
    throw new Error(`MAX_PHOTO_HEAD_CALLS (${MAX_PHOTO_HEAD_CALLS}) exceeded`);
  }
  photoHeadCount++;
  const params = new URLSearchParams({
    photo_reference: photoReference,
    maxwidth: String(PHOTO_MAX_WIDTH),
    key: GOOGLE_KEY,
  });
  const url = `https://maps.googleapis.com/maps/api/place/photo?${params}`;
  return httpHeadFollow(url);
}

// --- 写真スコアリング ---
const PHOTO_MIN_WIDTH = 800;
const PHOTO_MIN_HEIGHT = 600;
const PHOTO_RATIO_MIN = 0.4;
const PHOTO_RATIO_MAX = 2.5;

function scorePhoto(photo, shopName) {
  const width = photo.width || 0;
  const height = photo.height || 0;
  if (width < PHOTO_MIN_WIDTH || height < PHOTO_MIN_HEIGHT) {
    return { score: -1, reason: `size ${width}x${height} too small` };
  }
  const ratio = width / height;
  if (ratio < PHOTO_RATIO_MIN || ratio > PHOTO_RATIO_MAX) {
    return { score: -1, reason: `ratio ${ratio.toFixed(2)} out of range` };
  }
  let score = 0;
  const attrs = (photo.html_attributions || []).join(' ').toLowerCase();
  if (attrs.includes('owner') || (shopName && attrs.includes(shopName.toLowerCase()))) score += 2;
  else if (attrs.length > 0) score += 1;
  return { score, reason: `ok (ratio ${ratio.toFixed(2)})` };
}

function pickPhotos(photos, shopName) {
  if (!Array.isArray(photos) || photos.length === 0) return [];
  const scored = photos.map((p, idx) => {
    const { score, reason } = scorePhoto(p, shopName);
    return { photo: p, idx, score, reason };
  });
  if (DEBUG_PHOTOS) {
    console.log(`    [photos] ${scored.length} returned by API:`);
    scored.forEach((x, i) => {
      const w = x.photo.width, h = x.photo.height;
      const ok = x.score >= 0 ? '✓' : '✗';
      console.log(`      ${ok} #${i} ${w}x${h} — ${x.reason}`);
    });
  }
  const filtered = scored
    .filter(x => x.score >= 0)
    .sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
  if (filtered.length === 0) return [];
  const picked = [filtered[0]];
  let lastIdx = filtered[0].idx;
  for (const candidate of filtered.slice(1)) {
    if (picked.length >= PHOTOS_PER_SHOP) break;
    if (Math.abs(candidate.idx - lastIdx) < 3) continue;
    picked.push(candidate);
    lastIdx = candidate.idx;
  }
  return picked.map(x => x.photo);
}

// --- レビュー中央値 ---
function reviewRatingMedian(reviews) {
  if (!Array.isArray(reviews) || reviews.length === 0) return null;
  const ratings = reviews.map(r => r.rating).filter(r => typeof r === 'number').sort((a, b) => a - b);
  if (ratings.length === 0) return null;
  const mid = Math.floor(ratings.length / 2);
  return ratings.length % 2 ? ratings[mid] : (ratings[mid - 1] + ratings[mid]) / 2;
}

// --- キャプション生成 ---
function buildCaptionPrompts({ shopName, category, googleSummary, reviews, fewShotExamples }) {
  const reviewText = (reviews || []).slice(0, 5).map(r => {
    const t = (r.text || '').slice(0, 300).replace(/\s+/g, ' ');
    return `★${r.rating}: ${t}`;
  }).join('\n');

  const systemPrompt = [
    '別府のホテルAmu周辺の店ガイドのキャプションを書く。',
    '【制約】',
    '- 3〜4文、各文20〜35字。',
    '- 中性的・実用的トーン。断定や誇張を避ける（「〜やすい」「〜寄り」「〜が出やすい」等の語尾を活用）。',
    '- 形容詞の連打NG。',
    '- 「美味しい」「最高」「絶品」「素晴らしい」「感動」等の主観強語は禁止。',
    '- レビュー要約だが「広告じみていない」自然な散文に。',
    '- 体言止め混ぜてもOKだが連発しない。',
    '',
    '【出力形式】',
    'キャプション本文だけ。前置きや「以下が〜」のような枕詞は出さない。',
  ].join('\n');

  const userPrompt = [
    `# 店名\n${shopName}`,
    `# カテゴリ\n${category || '不明'}`,
    googleSummary ? `# Googleの編集サマリ\n${googleSummary}` : '',
    `# Googleレビュー（最大5件、各300字まで）\n${reviewText || '（取得できず）'}`,
    '',
    fewShotExamples && fewShotExamples.length
      ? `# 文体の参考例（既存の中性トーン）\n${fewShotExamples.map((e, i) => `${i + 1}. ${e}`).join('\n')}`
      : '',
    '',
    '上記を元に、Amuのガイドに載せる短い紹介文を書いてください。',
  ].filter(Boolean).join('\n');

  return { systemPrompt, userPrompt };
}

async function generateCaptionViaAnthropicApi(prompts) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CAPTION_MODEL,
      max_tokens: 400,
      system: prompts.systemPrompt,
      messages: [{ role: 'user', content: prompts.userPrompt }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.content || []).map(c => c.text || '').join('').trim();
}

function generateCaptionViaClaudeCli(prompts) {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', [
      '-p', prompts.userPrompt,
      '--system-prompt', prompts.systemPrompt,
      '--model', CAPTION_MODEL,
      '--output-format', 'text',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`claude CLI exit ${code}: ${err.slice(0, 200)}`));
    });
  });
}

async function generateCaption(promptData) {
  if (anthropicCallCount >= MAX_ANTHROPIC_CALLS) {
    throw new Error(`MAX_ANTHROPIC_CALLS (${MAX_ANTHROPIC_CALLS}) exceeded`);
  }
  anthropicCallCount++;
  const prompts = buildCaptionPrompts(promptData);
  if (VIA_CLAUDE_CLI) {
    return generateCaptionViaClaudeCli(prompts);
  }
  return generateCaptionViaAnthropicApi(prompts);
}

// --- 1店舗処理 ---
async function processShop(shop, existingEntry, fewShotExamples) {
  const result = await fetchPlaceDetails(shop.placeId);
  if (result.status !== 'OK' || !result.result) {
    throw new Error(`Places API: ${result.status} ${result.error_message || ''}`);
  }
  const details = result.result;

  const pickedPhotos = pickPhotos(details.photos || [], shop.name);
  const photos = [];
  for (const p of pickedPhotos) {
    try {
      const url = await resolvePhotoUrl(p.photo_reference);
      photos.push({
        url,
        width: p.width,
        height: p.height,
        attribution: (p.html_attributions || []).join(' | '),
      });
    } catch (e) {
      console.warn(`    ! photo HEAD failed: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 80));
  }

  const ratingMedian = reviewRatingMedian(details.reviews);
  const editorialSummary = details.editorial_summary && details.editorial_summary.overview;

  // キャプション生成判定
  const needsCaption = (() => {
    if (NO_CAPTION) return false;
    if (FORCE_CAPTION) return true;
    if (!existingEntry || !existingEntry.captionGenerated || existingEntry.captionSource !== 'generated') return true;
    const ageMs = Date.now() - new Date(existingEntry.captionGenerated).getTime();
    return ageMs > CAPTION_REGEN_DAYS * 24 * 60 * 60 * 1000;
  })();

  let caption = (existingEntry && existingEntry.caption) || shop.reviewSummary || '';
  let captionSource = (existingEntry && existingEntry.captionSource) || (shop.reviewSummary ? 'csv-fallback' : 'none');
  let captionGenerated = existingEntry && existingEntry.captionGenerated;

  const hasCaptionAuth = VIA_CLAUDE_CLI || !!ANTHROPIC_KEY;
  if (needsCaption && hasCaptionAuth) {
    try {
      const generated = await generateCaption({
        shopName: shop.name,
        category: shop.category,
        googleSummary: editorialSummary,
        reviews: details.reviews,
        fewShotExamples,
      });
      if (generated && generated.length > 0) {
        caption = generated;
        captionSource = 'generated';
        captionGenerated = new Date().toISOString();
      }
    } catch (e) {
      console.warn(`    ! caption generation failed: ${e.message}`);
    }
  } else if (needsCaption && !hasCaptionAuth) {
    console.warn('    ! no caption auth (set ANTHROPIC_API_KEY or use --via-claude-cli), skipping');
  }

  return {
    placeId: shop.placeId,
    photos,
    rating: details.rating || null,
    ratingCount: details.user_ratings_total || null,
    ratingMedian,
    editorialSummary: editorialSummary || null,
    caption,
    captionSource,
    captionGenerated: captionGenerated || null,
    lastChecked: new Date().toISOString(),
  };
}

// --- main ---
async function main() {
  if (!GOOGLE_KEY && !DRY_RUN) {
    console.error('Error: GOOGLE_MAPS_API_KEY not set. Use --dry-run to preview targets.');
    process.exit(1);
  }

  let shops = loadShopsFromCsv(CSV_PATH);
  console.log(`Loaded ${shops.length} shops with place_id from CSV`);

  if (ONLY_SHOP) {
    shops = shops.filter(s => s.id === ONLY_SHOP || s.name === ONLY_SHOP);
    if (shops.length === 0) {
      console.error(`No shop matches --shop ${ONLY_SHOP}`);
      process.exit(1);
    }
  }
  if (SAMPLE_N) {
    shops = shops.slice(0, SAMPLE_N);
  }

  if (DRY_RUN) {
    console.log('\n--- DRY RUN: targets ---');
    shops.forEach(s => console.log(`  • ${s.name} [${s.id}] (${s.placeId})`));
    return;
  }

  // 既存places.json
  let existing = {};
  if (fs.existsSync(PLACES_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(PLACES_PATH, 'utf8'));
      existing = data.shops || {};
      console.log(`Loaded ${Object.keys(existing).length} existing entries from places.json`);
    } catch (e) {
      console.warn(`Warning: parse existing places.json failed: ${e.message}`);
    }
  }

  // few-shot examples: CSV既存「レビュー要約文」から3件
  const fewShotExamples = shops
    .map(s => s.reviewSummary)
    .filter(Boolean)
    .slice(0, 3);

  const out = { ...existing };
  let success = 0, fail = 0;

  for (let i = 0; i < shops.length; i++) {
    const shop = shops[i];
    console.log(`\n[${i + 1}/${shops.length}] ${shop.name} (${shop.id})`);
    try {
      const entry = await processShop(shop, existing[shop.id], fewShotExamples);
      out[shop.id] = entry;
      success++;
      console.log(`  ✓ photos:${entry.photos.length} median:${entry.ratingMedian} captionSource:${entry.captionSource}`);
      if (entry.captionSource === 'generated') {
        console.log(`  📝 ${entry.caption}`);
      }
    } catch (e) {
      console.error(`  ✗ ${e.message}`);
      fail++;
    }
    await new Promise(r => setTimeout(r, 120));
  }

  // SAMPLEモード時は既存entry削除しない
  const isFullRun = !SAMPLE_N && !ONLY_SHOP;
  if (isFullRun) {
    const validIds = new Set(shops.map(s => s.id));
    for (const id of Object.keys(out)) {
      if (!validIds.has(id)) {
        delete out[id];
        console.log(`Removed stale entry: ${id}`);
      }
    }
  }

  const output = {
    generated: new Date().toISOString(),
    captionModel: CAPTION_MODEL,
    shops: out,
  };
  fs.writeFileSync(PLACES_PATH, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\nWrote ${Object.keys(out).length} entries to ${PLACES_PATH}`);
  console.log(`Done! ${success} ok, ${fail} failed.`);
  console.log(`API usage: details=${detailsCallCount} photoHead=${photoHeadCount} anthropic=${anthropicCallCount}`);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
