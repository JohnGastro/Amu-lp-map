#!/usr/bin/env node
/**
 * refresh-hours.js
 *
 * Places API で各店舗の営業時間と営業状態を取得し、
 * public/data/hours.json に保存する。
 *
 * - 既存の hours.json がある場合、全店舗を再チェック（1日1回想定）
 * - place_id が無い店舗はスキップ
 *
 * Usage:
 *   GOOGLE_MAPS_API_KEY=xxx node scripts/refresh-hours.js
 *
 * Options:
 *   --dry-run  API呼び出しせずに対象のみ表示
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const CSV_PATH = path.resolve(__dirname, '../public/data/beppu-restaurants.csv');
const HOURS_PATH = path.resolve(__dirname, '../public/data/hours.json');

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

// --- CSV Parser (same as generate-routes.js) ---
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
    const placeId = obj['place_id'] || '';

    if (!name || !placeId) continue;

    shops.push({
      id: slug || name,
      name: name,
      placeId: placeId,
    });
  }

  return shops;
}

// --- Places API ---
function fetchPlaceDetails(placeId) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      place_id: placeId,
      fields: 'business_status,opening_hours,current_opening_hours',
      key: API_KEY,
    });

    const url = `https://maps.googleapis.com/maps/api/place/details/json?${params}`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Failed to parse Places API response'));
        }
      });
    }).on('error', reject);
  });
}

function convertPeriodsToHoursMap(openingHours) {
  if (!openingHours || !openingHours.weekday_text) return null;

  const dayMap = {
    'Monday': '月', 'Tuesday': '火', 'Wednesday': '水',
    'Thursday': '木', 'Friday': '金', 'Saturday': '土', 'Sunday': '日'
  };

  // Use periods if available for structured data
  if (openingHours.periods && Array.isArray(openingHours.periods)) {
    const result = {};
    const dayKeys = ['日', '月', '火', '水', '木', '金', '土'];

    // Initialize all days as closed
    dayKeys.forEach(k => { result[k] = []; });

    openingHours.periods.forEach(period => {
      if (!period.open) return;
      const dayIdx = period.open.day;
      const dayKey = dayKeys[dayIdx];
      if (!dayKey) return;

      const openTime = String(period.open.time || '').padStart(4, '0');
      const openFormatted = openTime.substring(0, 2) + ':' + openTime.substring(2);

      let closeFormatted = '23:59';
      if (period.close) {
        const closeTime = String(period.close.time || '').padStart(4, '0');
        closeFormatted = closeTime.substring(0, 2) + ':' + closeTime.substring(2);
      }

      result[dayKey].push({ open: openFormatted, close: closeFormatted });
    });

    return result;
  }

  return null;
}

function formatWeekdayText(openingHours) {
  if (!openingHours || !openingHours.weekday_text) return null;
  // weekday_text is like ["Monday: 11:00 AM – 2:30 PM", ...]
  // We store it as-is for display purposes
  return openingHours.weekday_text.join(' | ');
}

async function main() {
  if (!API_KEY && !DRY_RUN) {
    console.warn('Warning: GOOGLE_MAPS_API_KEY not set. Skipping hours refresh.');
    process.exit(0);
  }

  const shops = loadShopsFromCsv(CSV_PATH);
  console.log(`Loaded ${shops.length} shops with place_id from CSV`);

  if (DRY_RUN) {
    console.log('\n--- DRY RUN: Would fetch hours for: ---');
    shops.forEach(s => console.log(`  • ${s.name} (${s.placeId})`));
    return;
  }

  // Load existing hours
  let existing = {};
  if (fs.existsSync(HOURS_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(HOURS_PATH, 'utf8'));
      existing = data.shops || {};
      console.log(`Loaded ${Object.keys(existing).length} existing entries from hours.json`);
    } catch (e) {
      console.warn('Warning: Could not parse existing hours.json, starting fresh');
    }
  }

  const hours = { ...existing };
  let successCount = 0;
  let failCount = 0;
  let unchangedCount = 0;

  for (let i = 0; i < shops.length; i++) {
    const shop = shops[i];
    console.log(`[${i + 1}/${shops.length}] Checking: ${shop.name}`);

    try {
      const result = await fetchPlaceDetails(shop.placeId);

      if (result.status !== 'OK' || !result.result) {
        console.error(`  ✗ ${shop.name}: Places API error — ${result.status}`);
        failCount++;
        continue;
      }

      const details = result.result;
      const businessStatus = details.business_status || 'UNKNOWN';
      const hoursMap = convertPeriodsToHoursMap(details.opening_hours);
      const weekdayText = formatWeekdayText(details.opening_hours);

      const entry = {
        businessStatus: businessStatus,
        hoursMap: hoursMap,
        weekdayText: weekdayText,
        lastChecked: new Date().toISOString(),
      };

      // Check if changed
      const prev = hours[shop.id];
      if (prev && JSON.stringify(prev.hoursMap) === JSON.stringify(hoursMap) &&
          prev.businessStatus === businessStatus) {
        entry.lastChecked = prev.lastChecked; // Keep original check time if unchanged
        unchangedCount++;
        console.log(`  = ${shop.name}: unchanged (${businessStatus})`);
      } else {
        console.log(`  ✓ ${shop.name}: ${businessStatus}${hoursMap ? ' (hours updated)' : ''}`);
        successCount++;
      }

      hours[shop.id] = entry;
    } catch (e) {
      console.error(`  ✗ ${shop.name}: ${e.message}`);
      failCount++;
    }

    // Rate limit: 100ms between requests
    if (i < shops.length - 1) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  // Remove entries for shops no longer in CSV
  const shopIds = new Set(shops.map(s => s.id));
  for (const id of Object.keys(hours)) {
    if (!shopIds.has(id)) {
      delete hours[id];
      console.log(`Removed stale entry: ${id}`);
    }
  }

  const output = {
    generated: new Date().toISOString(),
    shops: hours,
  };
  fs.writeFileSync(HOURS_PATH, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\nWrote ${Object.keys(hours).length} entries to ${HOURS_PATH}`);
  console.log(`Done! ${successCount} updated, ${unchangedCount} unchanged, ${failCount} failed.`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
