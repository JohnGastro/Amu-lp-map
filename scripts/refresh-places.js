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
// downloadPhoto は path モジュールを使うので require 済み

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
const PUSH_SUPABASE = args.includes('--push');         // Supabase amu_beppu_shops/_photos に書き込む
const STORAGE_UPLOAD = args.includes('--storage');     // 採用写真をSupabase Storageにアップロードして永続URL化（lh3失効対策）
const FROM_CSV = args.includes('--from-csv');           // legacy CSV から店舗一覧（seed/移行期用）
const NO_JSON_FALLBACK = args.includes('--no-json-fallback');  // places.json書き出しをスキップ
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

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_ADMIN_PW = process.env.SUPABASE_ADMIN_PW || 'amu-beppu';

// --- 23万円事件への防御: 1実行あたりのハードリミット ---
const MAX_DETAILS_CALLS = 60;     // 40店舗 + 余裕
const MAX_PHOTO_HEAD_CALLS = 400; // 40店舗 × 10枚 + 余裕（Vision分類のため上限拡大）
const MAX_ANTHROPIC_CALLS = 80;   // キャプション40 + 写真分類は別カウンタ
const MAX_VISION_CALLS = 80;      // 40店舗 × 1リクエスト + 余裕
let detailsCallCount = 0;
let photoHeadCount = 0;
let anthropicCallCount = 0;
let visionCallCount = 0;

const CAPTION_REGEN_DAYS = 30;
const CAPTION_MODEL = 'claude-opus-4-7';
const VISION_MODEL = 'claude-haiku-4-5';   // 写真分類用、コスト最優先
const PHOTO_DL_DIR = '/tmp/beppu-vision-photos';
const PHOTO_DL_BYTES_MAX = 6 * 1024 * 1024;  // 1枚あたり最大6MB（暴走防止）
const PHOTO_MAX_WIDTH = 1600;
const PHOTOS_PER_SHOP = 5;
// Vision分類は飲食店向けの優先度。例: お買いもの店ではこの優先度ではうまく行かない可能性あり
const PHOTO_LABEL_PRIORITY = {
  food: 100,
  drink: 80,
  interior: 50,
  exterior: 40,
  signage: 20,
  menu: 15,
  people: 5,
  other: 10,
};

// --- Supabase Storage 永続化 ---
// Google Places の photo URL (lh3.googleusercontent.com) は数週間で失効するため、
// 採用写真をこのpublicバケットにコピーして、失効しない固定URLで配信する。
const STORAGE_BUCKET = 'amu-beppu-photos';
let storageUploadCount = 0;
const MAX_STORAGE_UPLOADS = 400; // 40店 × 10枚 + 余裕（暴走防止）

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

// 1段階目: サイズ/比率/attribution によるフィルタ — Vision呼び出しコストを抑える
function preFilterPhotos(photos, shopName) {
  if (!Array.isArray(photos) || photos.length === 0) return [];
  const scored = photos.map((p, idx) => {
    const { score, reason } = scorePhoto(p, shopName);
    return { photo: p, idx, score, reason };
  });
  if (DEBUG_PHOTOS) {
    console.log(`    [photos pre-filter] ${scored.length} returned by API:`);
    scored.forEach((x, i) => {
      const w = x.photo.width, h = x.photo.height;
      const ok = x.score >= 0 ? '✓' : '✗';
      console.log(`      ${ok} #${i} ${w}x${h} — ${x.reason}`);
    });
  }
  return scored
    .filter(x => x.score >= 0)
    .sort((a, b) => (b.score - a.score) || (a.idx - b.idx))
    .slice(0, 10); // Vision呼び出し前に上位10枚に絞る
}

// 2段階目: Vision分類後、ラベル優先度でソートしてサンプリング
function finalizePhotos(scoredWithLabels) {
  if (scoredWithLabels.length === 0) return [];
  // ラベル優先度 + 既存スコアで再ソート
  const enriched = scoredWithLabels.map(x => {
    const labelScore = PHOTO_LABEL_PRIORITY[x.label] ?? PHOTO_LABEL_PRIORITY.other;
    return { ...x, labelScore };
  });
  enriched.sort((a, b) => (b.labelScore - a.labelScore) || (b.score - a.score) || (a.idx - b.idx));
  if (DEBUG_PHOTOS) {
    console.log(`    [photos post-vision] ranked:`);
    enriched.forEach(x => console.log(`      ${x.label.padEnd(8)} (${x.labelScore}) #${x.idx} ${x.photo.width}x${x.photo.height}`));
  }
  const picked = [enriched[0]];
  let lastIdx = enriched[0].idx;
  for (const candidate of enriched.slice(1)) {
    if (picked.length >= PHOTOS_PER_SHOP) break;
    if (Math.abs(candidate.idx - lastIdx) < 2) continue;
    picked.push(candidate);
    lastIdx = candidate.idx;
  }
  return picked;
}

// --- Vision: 写真ラベル分類 ---
// 2モード:
//   1. --via-claude-cli: ローカルに画像DLしてから `claude -p` に絶対パスを渡す（subscription auth、追加課金ゼロ）
//   2. (default): Anthropic API 直叩き（要 ANTHROPIC_API_KEY、Visionサポートのキー）
let visionDisabled = false;

async function downloadPhoto(url, idx) {
  const filename = `${Date.now()}-${idx}.jpg`;
  const filepath = path.join(PHOTO_DL_DIR, filename);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = parseInt(res.headers.get('content-length') || '0', 10);
  if (len > PHOTO_DL_BYTES_MAX) throw new Error(`size ${len} > limit ${PHOTO_DL_BYTES_MAX}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > PHOTO_DL_BYTES_MAX) throw new Error(`size ${buf.length} > limit ${PHOTO_DL_BYTES_MAX}`);
  fs.writeFileSync(filepath, buf);
  return filepath;
}

// Storage上のオブジェクトパスを安定させるための短いハッシュ（photo_reference由来）
function shortHash(s) {
  let h = 0;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// lh3 の写真を1枚DLして amu-beppu-photos バケットにアップロードし、
// { publicUrl, storagePath } を返す。失敗時は例外を投げる（呼び出し側でlh3 urlにフォールバック）。
async function persistPhotoToStorage(placeId, candidate) {
  if (storageUploadCount >= MAX_STORAGE_UPLOADS) {
    throw new Error(`MAX_STORAGE_UPLOADS (${MAX_STORAGE_UPLOADS}) exceeded`);
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY env required for --storage');
  }
  const srcUrl = candidate.url;
  const res = await fetch(srcUrl);
  if (!res.ok) throw new Error(`source DL HTTP ${res.status}`);
  const contentType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > PHOTO_DL_BYTES_MAX) throw new Error(`size ${buf.length} > limit ${PHOTO_DL_BYTES_MAX}`);
  const ext = contentType.includes('png') ? 'png'
    : contentType.includes('webp') ? 'webp'
    : contentType.includes('heic') ? 'heic'
    : 'jpg';
  const key = shortHash(candidate.photo.photo_reference || srcUrl);
  // place_id は英数のみ（ChIJ…）なのでパスに安全。slugは日本語URLエンコード済みで二重エンコードになるため使わない。
  const storagePath = `${placeId}/${key}.${ext}`;
  const encodedPath = storagePath.split('/').map(encodeURIComponent).join('/');
  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${encodedPath}`;
  storageUploadCount++;
  const up = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'apikey': SUPABASE_ANON_KEY,
      'Content-Type': contentType,
      'x-upsert': 'true',
      'cache-control': 'public, max-age=31536000, immutable',
    },
    body: buf,
  });
  if (!up.ok) {
    throw new Error(`storage upload ${up.status}: ${(await up.text()).slice(0, 200)}`);
  }
  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${encodedPath}`;
  return { publicUrl, storagePath };
}

async function classifyPhotosViaClaudeCli(photoUrls) {
  if (!photoUrls.length) return [];
  if (visionDisabled) return null;
  if (visionCallCount >= MAX_VISION_CALLS) return null;
  visionCallCount++;
  fs.mkdirSync(PHOTO_DL_DIR, { recursive: true });

  // 1) ローカルにDL
  const localPaths = [];
  for (let i = 0; i < photoUrls.length; i++) {
    try {
      const p = await downloadPhoto(photoUrls[i], i);
      localPaths.push(p);
    } catch (e) {
      console.warn(`    ! photo DL failed #${i + 1}: ${e.message}`);
      localPaths.push(null);
    }
  }
  const valid = localPaths.map((p, i) => ({ idx: i, path: p })).filter(x => x.path);
  if (valid.length === 0) return null;

  // 2) claude -p で一括分類
  const prompt = [
    `次の${valid.length}枚の画像をそれぞれ分類してください。`,
    '出力は厳密に「#N: label」形式で1行ずつ。前置きや解説は出さない。',
    'labelは以下のいずれかの小文字英語: food / drink / interior / exterior / signage / menu / people / other',
    '',
    ...valid.map(v => `#${v.idx + 1}: ${v.path}`),
  ].join('\n');

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const result = await new Promise((resolve) => {
    const proc = spawn('claude', [
      '-p', prompt,
      '--permission-mode', 'bypassPermissions',
      '--model', VISION_MODEL,
      '--output-format', 'text',
    ], { stdio: ['ignore', 'pipe', 'pipe'], env });
    let out = '';
    let err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('error', () => resolve(null));
    proc.on('close', code => {
      if (code !== 0) {
        console.warn(`    ! Vision CLI exit ${code}: ${err.slice(0, 200)}`);
        return resolve(null);
      }
      resolve(out);
    });
  });

  // 3) 画像クリーンアップ
  for (const p of localPaths) {
    if (p) { try { fs.unlinkSync(p); } catch {} }
  }

  if (!result) return null;
  const labels = new Array(photoUrls.length).fill('other');
  result.split('\n').forEach(line => {
    const m = line.match(/#(\d+)\s*[:：]\s*([a-z]+)/i);
    if (m) {
      const idx = parseInt(m[1], 10) - 1;
      if (idx >= 0 && idx < labels.length) labels[idx] = m[2].toLowerCase();
    }
  });
  return labels;
}

async function classifyPhotos(photoUrls) {
  if (VIA_CLAUDE_CLI) return classifyPhotosViaClaudeCli(photoUrls);
  // Anthropic API 直叩きルート（要 ANTHROPIC_API_KEY）
  if (!ANTHROPIC_KEY || visionDisabled) return null;
  if (visionCallCount >= MAX_VISION_CALLS) return null;
  if (!photoUrls.length) return [];
  visionCallCount++;

  const numbered = photoUrls.map((u, i) => `#${i + 1}`).join(' / ');
  const systemPrompt = [
    'あなたは飲食店ガイドの写真キュレーター。提示された写真を以下のいずれか1ラベルに分類してください。',
    '',
    'ラベル候補（小文字英語で）:',
    '- food: 料理・スイーツ・盛り付け・テーブル上の食事',
    '- drink: 飲み物・ドリンク・酒・コーヒー単体',
    '- interior: 店内空間・席・カウンター（料理が映っていない）',
    '- exterior: 店舗の外観・ファサード・入口',
    '- signage: 看板・ロゴ・店名表示',
    '- menu: メニュー表・価格表',
    '- people: 人物が主役の写真（スタッフ・客）',
    '- other: 上記いずれにも該当しない',
    '',
    '出力フォーマット（厳密）:',
    '画像1枚につき1行、`#N: label` の形のみ。前置きや解説は出さない。',
  ].join('\n');

  const userText = `次の ${photoUrls.length} 枚を順に分類してください（${numbered}）。各行 \`#N: label\` のみ。`;
  const content = [];
  for (let i = 0; i < photoUrls.length; i++) {
    content.push({ type: 'image', source: { type: 'url', url: photoUrls[i] } });
  }
  content.push({ type: 'text', text: userText });

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: 'user', content }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 401) {
        visionDisabled = true;
        console.warn(`    ! Vision auth invalid — disabling for this run (subscription tokens cannot call /v1/messages with image content)`);
      } else {
        console.warn(`    ! Vision classify failed: ${res.status}: ${errText.slice(0, 200)}`);
      }
      return null;
    }
    const data = await res.json();
    const text = (data.content || []).map(c => c.text || '').join('');
    const labels = new Array(photoUrls.length).fill('other');
    text.split('\n').forEach(line => {
      const m = line.match(/#(\d+)\s*[:：]\s*([a-z]+)/i);
      if (m) {
        const idx = parseInt(m[1], 10) - 1;
        const label = m[2].toLowerCase();
        if (idx >= 0 && idx < labels.length) labels[idx] = label;
      }
    });
    return labels;
  } catch (e) {
    console.warn(`    ! Vision classify exception: ${e.message}`);
    return null;
  }
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
    'あなたは別府のホテル Amu のキュレーション担当。Amu が「滞在中に立ち寄って欲しい」と選んだ周辺の店の紹介文を書く。',
    '',
    '【絶対NG】',
    '- 価格に関する論評（「価格はやや高め」「料金は控えめ」「コスパ」「会計の見通し」「予算」など、金額の高低や財布感に触れる表現は一切NG）。',
    '- 評価・口コミに関する分析的な記述（「評価が分かれる」「賛否」「割れる」「ズレ」「見込み」「レビュー数」「評価帯」「ばらつき」「期待値を絞る」など）。',
    '- 訪問のストレスを連想させる記述（「混雑」「並ぶ」「待ち時間」「行列」「売り切れ」「予約が無難」「事前確認が必要」など）。',
    '- 客層に関する記述（「常連寄り」「一見さん」「外国人客」「賑やか」「うるさい」など）。',
    '- 弱点・短所を匂わす表現（「クセ」「物足りない」「微妙」「遠め」「狭め」「やや遅め」「やや高め」「分かれ寄り」など）。',
    '- 主観強語（「美味しい」「最高」「絶品」「素晴らしい」「感動」「最強」「最高峰」など）。',
    '',
    '【書くべきこと】',
    '- その店の「特色・楽しみ方・どんな滞在シーンに合うか」。',
    '- 料理／飲み物／空間／立地のうち、その店ならではの要素を具体的に1〜2個。',
    '- 散歩・夜の一杯・朝の珈琲など、Amu滞在のどのシーンに溶け込むかの示唆。',
    '',
    '【トーン】',
    '- 3〜4文、各文20〜35字。',
    '- 中性的・実用的。断定や誇張を避け、「〜やすい」「〜寄り」「〜が出やすい」「〜が残る」など穏やかな語尾を活用。',
    '- 形容詞の連打NG。体言止めは混ぜてもOKだが連発しない。',
    '- 広告コピーではなく、ホテルの友人が伝言を残すような落ち着いた一文。',
    '',
    '【出力形式】',
    'キャプション本文だけ。前置きや「以下が〜」のような枕詞は出さない。',
    '',
    '【書き終わったら必ず】',
    '上に書いた「絶対NG」リストの語句が混入していないか自分で読み返し、混入していたら必ず書き直してから出力する。',
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
    // ANTHROPIC_API_KEY と ANTHROPIC_AUTH_TOKEN を env から外して、
    // CLI が Claude Code のサブスク認証 (OAuth) を使うようにする。
    // 残しておくと、Vision用に渡した token (Vision endpoint で 401) を
    // CLI も優先利用してしまい、全キャプション生成が失敗する。
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const proc = spawn('claude', [
      '-p', prompts.userPrompt,
      '--system-prompt', prompts.systemPrompt,
      '--model', CAPTION_MODEL,
      '--output-format', 'text',
    ], { stdio: ['ignore', 'pipe', 'pipe'], env });
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

  // Stage 1: サイズ/比率による事前フィルタ
  const candidates = preFilterPhotos(details.photos || [], shop.name);
  // photo_reference → 実URL 解決
  const resolved = [];
  for (const c of candidates) {
    try {
      const url = await resolvePhotoUrl(c.photo.photo_reference);
      resolved.push({ ...c, url });
    } catch (e) {
      console.warn(`    ! photo HEAD failed: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 60));
  }

  // Stage 2: Vision で内容分類（CLIモード or ANTHROPIC_API_KEY ありの時）
  let labels = null;
  if (resolved.length && (VIA_CLAUDE_CLI || ANTHROPIC_KEY)) {
    labels = await classifyPhotos(resolved.map(r => r.url));
  }
  const withLabels = resolved.map((r, i) => ({ ...r, label: (labels && labels[i]) || 'unclassified' }));

  // Stage 3: 料理優先で最終選別（Visionなしならラベルなし=スコア通り）
  const pickedTop = labels ? finalizePhotos(withLabels) : withLabels.slice(0, PHOTOS_PER_SHOP);
  const pickedIds = new Set(pickedTop.map(x => x.url));
  // pushモード時は採用外の写真も含めて全候補を返す（CMSで切替できるよう）
  const allCandidates = PUSH_SUPABASE
    ? [
        ...pickedTop.map((x, i) => ({ ...x, _autoSelected: true, _displayOrder: i })),
        ...withLabels.filter(x => !pickedIds.has(x.url)).map((x, i) => ({
          ...x, _autoSelected: false, _displayOrder: 100 + i,
        })),
      ]
    : pickedTop.map((x, i) => ({ ...x, _autoSelected: true, _displayOrder: i }));

  const photos = [];
  for (const x of allCandidates) {
    let finalUrl = x.url;
    let storagePath = null;
    // 採用写真（表示対象）だけ永続化する。非採用候補はlh3のまま残し、
    // CMSで後から採用された時に次回の refresh で永続化される。
    if (STORAGE_UPLOAD && x._autoSelected) {
      try {
        const up = await persistPhotoToStorage(shop.placeId, x);
        finalUrl = up.publicUrl;
        storagePath = up.storagePath;
      } catch (e) {
        console.warn(`    ! storage upload failed (${shop.id}): ${e.message} — keeping lh3 url`);
      }
    }
    photos.push({
      photo_ref: x.photo.photo_reference || null,
      url: finalUrl,
      storage_path: storagePath,
      width: x.photo.width,
      height: x.photo.height,
      attribution: (x.photo.html_attributions || []).join(' | '),
      label: x.label,
      auto_selected: x._autoSelected,
      display_order: x._displayOrder,
    });
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

// --- Supabase RPC helper ---
async function supaRpc(name, body) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY env required for --push');
  }
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

async function loadShopsFromSupabase() {
  const data = await supaRpc('amu_beppu_shops_list_all', { pw: SUPABASE_ADMIN_PW });
  return (data || []).map(s => ({
    id: s.slug,
    name: s.name,
    placeId: s.place_id,
    category: s.category || '',
    reviewSummary: s.caption_auto || '',
    googleMapUrl: s.google_maps_url || '',
    _existing: {
      caption: s.caption_auto,
      captionSource: s.caption_source,
      captionGenerated: s.caption_generated_at,
    },
  }));
}

async function pushShopToSupabase(shop, entry) {
  // shop master 更新（caption_override は守られる）
  await supaRpc('amu_beppu_shop_upsert', {
    pw: SUPABASE_ADMIN_PW,
    p_place_id: shop.placeId,
    p_payload: {
      slug: shop.id,
      name: shop.name,
      rating: entry.rating,
      rating_count: entry.ratingCount,
      rating_median: entry.ratingMedian,
      editorial_summary: entry.editorialSummary,
      caption_auto: entry.caption,
      caption_generated_at: entry.captionGenerated,
      last_checked_at: entry.lastChecked,
    },
  });

  // 写真候補一括書き換え（excluded/display_orderは保持される設計）
  if (entry.photos && entry.photos.length) {
    await supaRpc('amu_beppu_shop_photos_replace_set', {
      pw: SUPABASE_ADMIN_PW,
      p_place_id: shop.placeId,
      p_photos: entry.photos,
    });
  }
}

// --- main ---
async function main() {
  if (!GOOGLE_KEY && !DRY_RUN) {
    console.error('Error: GOOGLE_MAPS_API_KEY not set. Use --dry-run to preview targets.');
    process.exit(1);
  }

  let shops;
  if (PUSH_SUPABASE && !FROM_CSV) {
    console.log('Loading shop master from Supabase (--push mode)…');
    shops = await loadShopsFromSupabase();
    console.log(`Loaded ${shops.length} shops from Supabase`);
  } else {
    shops = loadShopsFromCsv(CSV_PATH);
    console.log(`Loaded ${shops.length} shops with place_id from CSV`);
  }

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

  let pushed = 0;
  for (let i = 0; i < shops.length; i++) {
    const shop = shops[i];
    console.log(`\n[${i + 1}/${shops.length}] ${shop.name} (${shop.id})`);
    try {
      const existingEntry = shop._existing || existing[shop.id];
      const entry = await processShop(shop, existingEntry, fewShotExamples);
      out[shop.id] = entry;
      success++;
      console.log(`  ✓ photos:${entry.photos.length} median:${entry.ratingMedian} captionSource:${entry.captionSource}`);
      if (entry.captionSource === 'generated') {
        console.log(`  📝 ${entry.caption}`);
      }
      if (PUSH_SUPABASE) {
        try {
          await pushShopToSupabase(shop, entry);
          pushed++;
          console.log(`  ↑ pushed to Supabase`);
        } catch (e) {
          console.error(`  ! supabase push failed: ${e.message}`);
        }
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

  // places.json fallback の書き出し（PUSH+NO_JSON_FALLBACKでskip）
  if (!(PUSH_SUPABASE && NO_JSON_FALLBACK)) {
    const output = {
      generated: new Date().toISOString(),
      captionModel: CAPTION_MODEL,
      shops: out,
    };
    fs.writeFileSync(PLACES_PATH, JSON.stringify(output, null, 2), 'utf8');
    console.log(`\nWrote ${Object.keys(out).length} entries to ${PLACES_PATH}`);
  }

  console.log(`Done! ${success} ok, ${fail} failed${PUSH_SUPABASE ? `, ${pushed} pushed to Supabase` : ''}.`);
  console.log(`API usage: details=${detailsCallCount} photoHead=${photoHeadCount} caption=${anthropicCallCount} vision=${visionCallCount}`);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
