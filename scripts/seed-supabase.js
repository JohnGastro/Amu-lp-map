#!/usr/bin/env node
/**
 * seed-supabase.js
 *
 * 既存の CSV + places.json + hours.json を Supabase の
 * amu_beppu_shops / amu_beppu_shop_photos に流し込む。
 * 一回限りの seed スクリプト（冪等、何度流しても OK）。
 *
 * Usage:
 *   SUPABASE_URL=https://aoehwevqlkpgvzdyfuja.supabase.co \
 *   SUPABASE_ANON_KEY=eyJ... \
 *   SEED_PW=amu-beppu \
 *   node scripts/seed-supabase.js
 *
 *   --dry-run  実際の RPC は呼ばず、何件流すかだけ表示
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CSV_PATH = path.resolve(__dirname, '../public/data/beppu-restaurants.csv');
const PLACES_PATH = path.resolve(__dirname, '../public/data/places.json');
const HOURS_PATH = path.resolve(__dirname, '../public/data/hours.json');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SEED_PW = process.env.SEED_PW || 'amu-beppu';
const DRY_RUN = process.argv.includes('--dry-run');

if (!DRY_RUN && (!SUPABASE_URL || !SUPABASE_ANON_KEY)) {
  console.error('Error: SUPABASE_URL and SUPABASE_ANON_KEY required (or use --dry-run)');
  process.exit(1);
}

// --- CSV Parser (refresh-places.js から流用) ---
function* parseCsvRows(text) {
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        row.push(field); field = '';
        if (ch === '\r' && text[i + 1] === '\n') i++;
        if (row.length > 0) { yield row; row = []; }
      } else field += ch;
    }
  }
  row.push(field);
  if (row.some(c => c.trim() !== '')) yield row;
}

function loadShopsFromCsv() {
  let text = fs.readFileSync(CSV_PATH, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const it = parseCsvRows(text);
  const headers = it.next().value.map(h => h.trim());
  const shops = [];
  for (const r of it) {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (r[i] || '').trim(); });
    if (!obj['タイトル'] || !obj['推定_place_id']) continue;
    const lat = parseFloat(obj['緯度_detail'] || obj['緯度']);
    const lng = parseFloat(obj['経度_detail'] || obj['経度']);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    shops.push({
      placeId: obj['推定_place_id'],
      slug: obj['URL内スラッグ'] || obj['タイトル'],
      name: obj['タイトル'],
      lat, lng,
      address: obj['住所'] || null,
      phone: obj['電話番号'] || null,
      website: obj['ウェブサイト'] || null,
      googleMapsUrl: obj['GoogleマップURL'] || null,
      category: obj['タグ'] || obj['カテゴリ'] || null,
      hoursText: obj['営業時間_曜日'] || null,
      businessStatus: obj['営業状態'] || null,
      reviewSummary: obj['レビュー要約文'] || null,
      ratingCsv: obj['総合評価'] ? parseFloat(obj['総合評価']) : null,
      ratingCountCsv: obj['レビュー数'] ? parseInt(obj['レビュー数'], 10) : null,
    });
  }
  return shops;
}

function loadPlaces() {
  if (!fs.existsSync(PLACES_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(PLACES_PATH, 'utf8')).shops || {}; }
  catch { return {}; }
}
function loadHours() {
  if (!fs.existsSync(HOURS_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(HOURS_PATH, 'utf8')).shops || {}; }
  catch { return {}; }
}

async function rpc(name, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`${name} ${res.status}: ${errText.slice(0, 300)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function main() {
  const csvShops = loadShopsFromCsv();
  const placesMap = loadPlaces();
  const hoursMap = loadHours();
  console.log(`Loaded ${csvShops.length} shops from CSV / ${Object.keys(placesMap).length} from places.json / ${Object.keys(hoursMap).length} from hours.json`);

  if (DRY_RUN) {
    csvShops.forEach((s, i) => console.log(`  [${i+1}/${csvShops.length}] ${s.name} (${s.placeId})`));
    return;
  }

  let upsertOk = 0, photosOk = 0, failed = 0;
  for (let i = 0; i < csvShops.length; i++) {
    const shop = csvShops[i];
    const placesEntry = placesMap[shop.slug] || {};
    const hoursEntry = hoursMap[shop.slug] || {};

    const payload = {
      slug: shop.slug,
      name: shop.name,
      lat: shop.lat,
      lng: shop.lng,
      address: shop.address,
      phone: shop.phone,
      website: shop.website,
      google_maps_url: shop.googleMapsUrl,
      category: shop.category,
      hours_text: shop.hoursText,
      hours_json: hoursEntry.hoursMap || null,
      business_status: hoursEntry.businessStatus || shop.businessStatus,
      rating: placesEntry.rating ?? shop.ratingCsv,
      rating_count: placesEntry.ratingCount ?? shop.ratingCountCsv,
      rating_median: placesEntry.ratingMedian,
      editorial_summary: placesEntry.editorialSummary,
      caption_auto: placesEntry.caption || shop.reviewSummary,
      caption_source: placesEntry.captionSource || (shop.reviewSummary ? 'csv-fallback' : 'none'),
      caption_generated_at: placesEntry.captionGenerated,
      last_checked_at: placesEntry.lastChecked,
    };

    console.log(`[${i + 1}/${csvShops.length}] ${shop.name}`);
    try {
      await rpc('amu_beppu_shop_upsert', {
        pw: SEED_PW,
        p_place_id: shop.placeId,
        p_payload: payload,
      });
      upsertOk++;
    } catch (e) {
      console.error(`  ✗ upsert: ${e.message}`);
      failed++;
      continue;
    }

    // 写真: places.json の photos[] を auto_selected=true, display_order 0..N で投入
    if (Array.isArray(placesEntry.photos) && placesEntry.photos.length) {
      const photos = placesEntry.photos.map((p, idx) => ({
        photo_ref: null,
        url: p.url,
        width: p.width || null,
        height: p.height || null,
        attribution: p.attribution || null,
        label: p.label || null,
        auto_selected: true,
        display_order: idx,
        source: 'google_places',
      }));
      try {
        await rpc('amu_beppu_shop_photos_replace_set', {
          pw: SEED_PW,
          p_place_id: shop.placeId,
          p_photos: photos,
        });
        photosOk++;
        console.log(`  ✓ upserted + ${photos.length} photos`);
      } catch (e) {
        console.error(`  ✗ photos: ${e.message}`);
      }
    } else {
      console.log(`  ✓ upserted (no photos)`);
    }

    await new Promise(r => setTimeout(r, 80));
  }

  console.log(`\nDone. shops: ${upsertOk}/${csvShops.length}, photos blocks: ${photosOk}, failed: ${failed}`);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
