#!/usr/bin/env node
/**
 * generate-routes.js
 *
 * CSVから店舗データを読み込み、Google Directions API でルートを取得して
 * public/data/routes.json に保存する。
 *
 * - 既存の routes.json がある場合、同じ座標の店舗はスキップ（差分のみ取得）
 * - 新しい店舗 or 座標が変わった店舗だけ API を呼ぶ
 *
 * Usage:
 *   GOOGLE_MAPS_API_KEY=xxx node scripts/generate-routes.js
 *
 * Options:
 *   --force   既存キャッシュを無視して全店舗再取得
 *   --dry-run API呼び出しせずに差分のみ表示
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

// --- Config ---
const HOTEL = { lat: 33.2785833, lng: 131.5030278, name: 'Amu' };
const WALK_TO_DRIVE_THRESHOLD_MINUTES = 20;

const CSV_PATH = path.resolve(__dirname, '../public/data/beppu-restaurants.csv');
const ROUTES_PATH = path.resolve(__dirname, '../public/data/routes.json');

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const DRY_RUN = args.includes('--dry-run');

// --- CSV Parser ---
function* parseCsvRows(text) {
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\n' || ch === '\r') {
        row.push(field);
        field = '';
        if (ch === '\r' && text[i + 1] === '\n') i++;
        if (row.length > 0) {
          yield row;
          row = [];
        }
      } else {
        field += ch;
      }
    }
  }
  row.push(field);
  if (row.length > 0 && row.some(c => c.trim() !== '')) {
    yield row;
  }
}

function loadCsv(filePath) {
  let text = fs.readFileSync(filePath, 'utf8');
  // Remove BOM
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
    const lat = parseFloat(obj['緯度_detail'] || obj['緯度']);
    const lng = parseFloat(obj['経度_detail'] || obj['経度']);

    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    shops.push({
      id: slug || name,
      name: name,
      lat: lat,
      lng: lng,
    });
  }

  return shops;
}

// --- Directions API ---
function fetchDirections(origin, destination, mode) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      origin: `${origin.lat},${origin.lng}`,
      destination: `${destination.lat},${destination.lng}`,
      mode: mode,
      key: API_KEY,
    });

    const url = `https://maps.googleapis.com/maps/api/directions/json?${params}`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Failed to parse Directions API response'));
        }
      });
    }).on('error', reject);
  });
}

function decodePolyline(encoded) {
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let b;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    points.push({
      lat: Math.round((lat / 1e5) * 1e6) / 1e6,
      lng: Math.round((lng / 1e5) * 1e6) / 1e6,
    });
  }

  return points;
}

async function getRouteForShop(shop) {
  // 1. Walking route
  const walkResult = await fetchDirections(
    { lat: shop.lat, lng: shop.lng },
    HOTEL,
    'walking'
  );

  if (walkResult.status !== 'OK' || !walkResult.routes || !walkResult.routes[0]) {
    console.error(`  ✗ ${shop.name}: Directions API error (walking) — ${walkResult.status}`);
    return null;
  }

  const walkRoute = walkResult.routes[0];
  const walkLeg = walkRoute.legs[0];
  const walkDurationSec = walkLeg.duration.value;
  const walkDistanceM = walkLeg.distance.value;
  const walkPath = decodePolyline(walkRoute.overview_polyline.points);
  const walkBounds = walkRoute.bounds;

  // 2. Check if driving is needed
  const shouldDrive = (walkDurationSec / 60) > WALK_TO_DRIVE_THRESHOLD_MINUTES;

  if (shouldDrive) {
    const driveResult = await fetchDirections(
      { lat: shop.lat, lng: shop.lng },
      HOTEL,
      'driving'
    );

    if (driveResult.status === 'OK' && driveResult.routes && driveResult.routes[0]) {
      const driveRoute = driveResult.routes[0];
      const driveLeg = driveRoute.legs[0];

      return {
        origin: { lat: shop.lat, lng: shop.lng },
        mode: 'DRIVING',
        duration: driveLeg.duration.value,
        distance: driveLeg.distance.value,
        path: decodePolyline(driveRoute.overview_polyline.points),
        bounds: driveRoute.bounds,
        walkDuration: walkDurationSec,
        walkDistance: walkDistanceM,
      };
    }
    // Driving failed, fall back to walking
  }

  return {
    origin: { lat: shop.lat, lng: shop.lng },
    mode: 'WALKING',
    duration: walkDurationSec,
    distance: walkDistanceM,
    path: walkPath,
    bounds: walkBounds,
    walkDuration: walkDurationSec,
    walkDistance: walkDistanceM,
  };
}

// --- Coordinate key for cache comparison ---
function coordKey(shop) {
  return `${shop.lat.toFixed(6)},${shop.lng.toFixed(6)}`;
}

// --- Main ---
async function main() {
  if (!API_KEY && !DRY_RUN) {
    console.warn('Warning: GOOGLE_MAPS_API_KEY not set. Skipping route generation.');
    console.warn('Set it with: GOOGLE_MAPS_API_KEY=xxx node scripts/generate-routes.js');
    process.exit(0);
  }

  // Load CSV
  const shops = loadCsv(CSV_PATH);
  console.log(`Loaded ${shops.length} shops from CSV`);

  // Load existing routes
  let existing = {};
  if (!FORCE && fs.existsSync(ROUTES_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(ROUTES_PATH, 'utf8'));
      existing = data.routes || {};
      console.log(`Loaded ${Object.keys(existing).length} existing routes from routes.json`);
    } catch (e) {
      console.warn('Warning: Could not parse existing routes.json, starting fresh');
    }
  }

  // Find shops that need route generation
  const toFetch = [];
  const upToDate = [];

  for (const shop of shops) {
    const ex = existing[shop.id];
    if (ex && ex.origin) {
      const exKey = `${ex.origin.lat.toFixed(6)},${ex.origin.lng.toFixed(6)}`;
      if (exKey === coordKey(shop)) {
        upToDate.push(shop.id);
        continue;
      }
    }
    toFetch.push(shop);
  }

  console.log(`Up to date: ${upToDate.length}, Need fetch: ${toFetch.length}`);

  if (toFetch.length === 0) {
    console.log('All routes are up to date. Nothing to do.');

    // Still clean up removed shops
    const shopIds = new Set(shops.map(s => s.id));
    let removed = 0;
    for (const id of Object.keys(existing)) {
      if (!shopIds.has(id)) {
        delete existing[id];
        removed++;
      }
    }
    if (removed > 0) {
      console.log(`Removed ${removed} routes for shops no longer in CSV`);
      writeRoutes(existing);
    }
    return;
  }

  if (DRY_RUN) {
    console.log('\n--- DRY RUN: Would fetch routes for: ---');
    toFetch.forEach(s => console.log(`  • ${s.name} (${s.lat}, ${s.lng})`));
    return;
  }

  // Fetch routes for new/changed shops
  const routes = { ...existing };
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < toFetch.length; i++) {
    const shop = toFetch[i];
    console.log(`[${i + 1}/${toFetch.length}] Fetching route for: ${shop.name}`);

    try {
      const route = await getRouteForShop(shop);
      if (route) {
        routes[shop.id] = route;
        const modeLbl = route.mode === 'DRIVING' ? '車' : '徒歩';
        const mins = Math.round(route.duration / 60);
        console.log(`  ✓ ${modeLbl} ${mins}分 (${route.path.length} points)`);
        successCount++;
      } else {
        failCount++;
      }
    } catch (e) {
      console.error(`  ✗ ${shop.name}: ${e.message}`);
      failCount++;
    }

    // Rate limit: 50ms between requests
    if (i < toFetch.length - 1) {
      await new Promise(r => setTimeout(r, 50));
    }
  }

  // Remove routes for shops no longer in CSV
  const shopIds = new Set(shops.map(s => s.id));
  for (const id of Object.keys(routes)) {
    if (!shopIds.has(id)) {
      delete routes[id];
      console.log(`Removed stale route: ${id}`);
    }
  }

  writeRoutes(routes);
  console.log(`\nDone! ${successCount} fetched, ${failCount} failed, ${upToDate.length} cached.`);
}

function writeRoutes(routes) {
  const output = {
    generated: new Date().toISOString(),
    hotel: HOTEL,
    routes: routes,
  };
  fs.writeFileSync(ROUTES_PATH, JSON.stringify(output, null, 2), 'utf8');
  console.log(`Wrote ${Object.keys(routes).length} routes to ${ROUTES_PATH}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
