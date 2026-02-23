(function (global) {
  'use strict';

  /**
   * @typedef {'昼食'|'朝食'|'夕食'|'お酒'|'喫茶'|'お買いもの'|'散歩'|'駐車場'|'温泉'} Category
   */

  /**
   * @typedef {Object} Place
   * @property {string} id
   * @property {string=} placeId
   * @property {string} name
   * @property {string} slug
   * @property {Category} category
   * @property {Category=} subcategory
   * @property {number} lat
   * @property {number} lng
   * @property {string=} thumbnail
   * @property {string=} description
   * @property {HTMLElement=} cardElement
   */

  /**
   * @typedef {Object} RouteSummary
   * @property {string} duration
   * @property {string} distance
   * @property {boolean} isFallback
   * @property {string} label
   */

  /**
   * @typedef {Object} PageState
   * @property {Category | ''} activeCategory
   * @property {Category | ''} activeSubcategory
   * @property {string | null} selectedPlaceId
   * @property {boolean} mobile
   */

  var DEFAULT_HOTEL = { id: 'hotel', name: 'Amu', lat: 33.2785833, lng: 131.5030278 };
  var DEFAULT_STATION = { id: 'beppu-station', name: '\u5225\u5e9c\u99c5', lat: 33.2793000, lng: 131.5003073 };
  var DEFAULT_HOTEL_ICON_URL = global.AMU_HOTEL_ICON_URL || './assets/images/logo-amu.svg';
  var DEFAULT_STATION_ICON_URL = global.STATION_ICON_URL || './assets/images/icon-station.svg';
  var DEFAULT_TZ_OFFSET_MINUTES = Number.isFinite(Number(global.BEPPU_TZ_OFFSET_MINUTES))
    ? Number(global.BEPPU_TZ_OFFSET_MINUTES)
    : 540; // Asia/Tokyo (JST)

  var DEFAULT_COORD_OVERRIDES = (function () {
    var hotel = global.__BEPPU_HOTEL_COORDS;
    var station = global.__BEPPU_STATION_COORDS;
    return {
      hotel: hotel && Number.isFinite(Number(hotel.lat)) && Number.isFinite(Number(hotel.lng)) ? {
        id: DEFAULT_HOTEL.id,
        name: String(hotel.name || DEFAULT_HOTEL.name),
        lat: Number(hotel.lat),
        lng: Number(hotel.lng),
      } : DEFAULT_HOTEL,
      station: station && Number.isFinite(Number(station.lat)) && Number.isFinite(Number(station.lng)) ? {
        id: DEFAULT_STATION.id,
        name: String(station.name || DEFAULT_STATION.name),
        lat: Number(station.lat),
        lng: Number(station.lng),
      } : DEFAULT_STATION,
    };
  })();

  function toNumber(value) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function normalizeCategory(value, fallback) {
    if (!value) return fallback;
    var raw = String(value).trim().toLowerCase();
    var text = String(value).toLowerCase();
    var map = {
      '昼食': '昼食',
      lunch: '昼食',
      lunches: '昼食',
      '朝食': '朝食',
      breakfast: '朝食',
      morning: '朝食',
      '夕食': '夕食',
      dinner: '夕食',
      'お酒': 'お酒',
      drinks: 'お酒',
      alcohol: 'お酒',
      bar: 'お酒',
      'izakaya': 'お酒',
      '喫茶': '喫茶',
      cafe: '喫茶',
      coffee: '喫茶',
      'お買いもの': 'お買いもの',
      shopping: 'お買いもの',
      retail: 'お買いもの',
      store: 'お買いもの',
      '\u6563\u6b69': '散歩',
      walk: '散歩',
      walkable: '散歩',
      walk: '散歩',
      '駐車場': '駐車場',
      parking: '駐車場',
      '温泉': '温泉',
      onsen: '温泉',
      'all': '',
      'すべて': '',
    };

    if (map[raw]) return map[raw];
    if (text.indexOf('温泉') >= 0 || text.indexOf('onsen') >= 0) return '温泉';
    if (text.indexOf('駐車') >= 0 || text.indexOf('parking') >= 0) return '駐車場';
    if (text.indexOf('散歩') >= 0 || text.indexOf('walk') >= 0) return '散歩';
    if (text.indexOf('喫茶') >= 0 || text.indexOf('カフェ') >= 0 || text.indexOf('coffee') >= 0 || text.indexOf('珈琲') >= 0) return '喫茶';
    if (text.indexOf('お買いもの') >= 0 || text.indexOf('買い物') >= 0 || text.indexOf('shop') >= 0 || text.indexOf('store') >= 0 || text.indexOf('shopping') >= 0 || text.indexOf('retail') >= 0) return 'お買いもの';
    if (text.indexOf('夜') >= 0 || text.indexOf('夕食') >= 0 || text.indexOf('dinner') >= 0) return '夕食';
    if (text.indexOf('朝食') >= 0 || text.indexOf('breakfast') >= 0 || text.indexOf('morning') >= 0 || text.indexOf('モーニング') >= 0) return '朝食';
    if (text.indexOf('酒') >= 0 || text.indexOf('bar') >= 0 || text.indexOf('izakaya') >= 0 || text.indexOf('alcohol') >= 0) return 'お酒';
    if (text.indexOf('レストラン') >= 0 || text.indexOf('レストラン') >= 0 || text.indexOf('restaurant') >= 0 || text.indexOf('食堂') >= 0 || text.indexOf('食事') >= 0 || text.indexOf('食') >= 0) return '昼食';
    return fallback;
  }

  function normalizePlace(raw, index) {
    var id = String(raw.id || raw._id || raw.slug || ('place-' + index));
    var placeId = raw.placeId || raw.place_id || raw.googlePlaceId || raw.google_place_id;
    var name = String(raw.name || raw.title || raw.storeName || raw.shop_name || '\u540d\u79f0\u672a\u8a2d\u5b9a');
    var slug = String(raw.slug || id);

    var lat = toNumber(raw.lat || raw.latitude || raw['\u7def\u5ea6'] || raw.dataLat);
    var lng = toNumber(raw.lng || raw.longitude || raw['\u7d4c\u5ea6'] || raw.dataLng);
    if (lat === null || lng === null) return null;

    var category = normalizeCategory(raw.category || raw.mainCategory || raw.genre || raw.type, '昼食');
    var subcategory = normalizeCategory(raw.subcategory || raw.subCategory, '');

    var thumbnail = raw.thumbnail ? String(raw.thumbnail) : (raw.image ? String(raw.image) : '');
    var description = raw.description ? String(raw.description) : '';
    var businessHours = raw.businessHours || raw.business_hours || raw['営業時間'] || '';
    var businessHoursText = raw.businessHoursText || raw.business_hours_text || raw['営業時間_曜日'] || '';

    return {
      id: id,
      placeId: placeId ? String(placeId) : undefined,
      name: name,
      slug: slug,
      category: category,
      subcategory: subcategory,
      lat: lat,
      lng: lng,
      thumbnail: thumbnail || undefined,
      description: description || undefined,
      businessHours: businessHours || undefined,
      businessHoursText: businessHoursText || undefined,
    };
  }

  /**
   * @param {unknown} response
   * @returns {Place[]}
   */
  function mapWebflowCmsItemsToPlaces(response) {
    if (!response) return [];

    var items;
    if (Array.isArray(response)) {
      items = response;
    } else if (typeof response === 'object') {
      var payload = /** @type {Record<string, unknown>} */ (response);
      items = Array.isArray(payload.items)
        ? payload.items
        : Array.isArray(payload.data)
          ? payload.data
          : [];
    } else {
      items = [];
    }

    var results = [];
    items.forEach(function (item, idx) {
      if (!item || typeof item !== 'object') return;
      var raw = /** @type {Record<string, unknown>} */ (item);
      var source = raw.fieldData && typeof raw.fieldData === 'object'
        ? /** @type {Record<string, unknown>} */ (raw.fieldData)
        : raw;
      if (raw.id && !source.id) source.id = raw.id;
      if (raw.slug && !source.slug) source.slug = raw.slug;

      var place = normalizePlace(source, idx);
      if (place) results.push(place);
    });

    return results;
  }

  function extractPlacesFromWebflowDom(root) {
    var cards = root.querySelectorAll('.spot-item');
    var places = [];

    cards.forEach(function (card, idx) {
      var id = card.getAttribute('data-place-id') || card.getAttribute('data-id') || ('dom-place-' + idx);
      var nameEl = card.querySelector('[data-field="name"], .spot-name');
      var name = nameEl ? nameEl.textContent.trim() : (card.getAttribute('data-name') || '\u540d\u79f0\u672a\u8a2d\u5b9a');
      var slug = card.getAttribute('data-slug') || id;

      var lat = toNumber(card.getAttribute('data-lat'));
      var lng = toNumber(card.getAttribute('data-lng'));
      if (lat === null || lng === null) return;

    var category = normalizeCategory(card.getAttribute('data-category'), '昼食');
    var subcategory = normalizeCategory(card.getAttribute('data-subcategory'), '');
      var descriptionEl = card.querySelector('[data-field="description"], .spot-description');
      var imageEl = card.querySelector('img');

      places.push({
        id: id,
        placeId: card.getAttribute('data-google-place-id') || card.getAttribute('data-place-id-google') || undefined,
        name: name,
        slug: slug,
        lat: lat,
        lng: lng,
        category: category,
        subcategory: subcategory,
        emojiTag: card.getAttribute('data-emoji') || card.getAttribute('data-tag') || '🍎',
        thumbnail: imageEl ? imageEl.src : undefined,
        description: descriptionEl ? descriptionEl.textContent.trim() : undefined,
        cardElement: /** @type {HTMLElement} */ (card),
      });
    });

    return places;
  }

  function createMarkerNode(kind, label, tagText) {
    var marker = document.createElement('div');
    marker.className = 'beppu-marker beppu-marker--' + kind;

    var dot = document.createElement('div');
    dot.className = 'beppu-marker__dot';
    if (kind === 'hotel') {
      var hotelIcon = document.createElement('img');
      hotelIcon.className = 'beppu-marker__hotel-icon';
      hotelIcon.src = DEFAULT_HOTEL_ICON_URL;
      hotelIcon.alt = 'Amu Symbol';
      dot.appendChild(hotelIcon);
    }
    if (kind === 'station') {
      var stationIcon = document.createElement('img');
      stationIcon.className = 'beppu-marker__station-icon';
      stationIcon.src = DEFAULT_STATION_ICON_URL;
      stationIcon.alt = 'Station';
      dot.appendChild(stationIcon);
    }
    if (kind === 'place') {
      var icon = document.createElement('span');
      icon.className = 'beppu-marker__icon';
      icon.textContent = tagText || '';
      dot.appendChild(icon);
    }
    marker.appendChild(dot);

    var text = document.createElement('span');
    text.className = 'beppu-marker__label';
    text.textContent = kind === 'place' ? (tagText || '') : (tagText || label);
    marker.appendChild(text);

    return marker;
  }

  function updateRouteChip(container, summary) {
    var labelEl = container.querySelector('[data-route-summary]');
    if (labelEl) {
      labelEl.textContent = summary.label;
    } else {
      container.textContent = summary.label;
    }
    container.classList.toggle('is-fallback', summary.isFallback);
  }

  function createRouteBadgeNode(durationText, travelMode) {
    var el = document.createElement('div');
    el.className = 'beppu-route-badge';
    var icon = travelMode === 'DRIVING' ? '🚗' : '🚶';
    el.textContent = icon + ' ' + (durationText || '--');
    return el;
  }

  function createPlacePreviewNode(place) {
    var wrap = document.createElement('div');
    wrap.className = 'beppu-place-preview';

    if (place && place.thumbnail) {
      var img = document.createElement('img');
      img.className = 'beppu-place-preview__thumb';
      img.src = String(place.thumbnail);
      img.alt = place.name || '';
      wrap.appendChild(img);
    }

    var name = document.createElement('span');
    name.className = 'beppu-place-preview__name';
    name.textContent = place && place.name ? place.name : '店舗';
    wrap.appendChild(name);

    if (place && place.openStatusText) {
      var status = document.createElement('span');
      status.className = 'beppu-place-preview__status' + (place.openStatusClass ? (' ' + place.openStatusClass) : '');
      status.textContent = place.openStatusText;
      wrap.appendChild(status);
    }

    return wrap;
  }

  function resolvePreviewThumbnail(place, card) {
    if (card && typeof card.querySelector === 'function') {
      var img = card.querySelector('img');
      if (img && img.src) return img.src;
    }
    return place && place.thumbnail ? String(place.thumbnail) : '';
  }

  function formatDurationJa(seconds) {
    if (!Number.isFinite(seconds) || seconds === null) return '--';
    var mins = Math.max(1, Math.round(seconds / 60));
    if (mins >= 60) {
      var h = Math.floor(mins / 60);
      var m = mins % 60;
      return m > 0 ? (h + '\u6642\u9593' + m + '\u5206') : (h + '\u6642\u9593');
    }
    return mins + '\u5206';
  }

  function formatDistanceJa(meters) {
    if (!Number.isFinite(meters) || meters === null) return '--';
    if (meters >= 1000) {
      return (Math.round((meters / 1000) * 10) / 10) + 'km';
    }
    return Math.round(meters) + 'm';
  }

  function parsePeriodTimeToMinutes(value) {
    var text = String(value || '');
    if (!/^\d{4}$/.test(text)) return null;
    var hh = Number(text.slice(0, 2));
    var mm = Number(text.slice(2, 4));
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    return hh * 60 + mm;
  }

  function parseClockTimeToMinutes(value) {
    var text = String(value || '').trim();
    var m = text.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    var hh = Number(m[1]);
    var mm = Number(m[2]);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    if (hh < 0 || hh > 24 || mm < 0 || mm > 59) return null;
    if (hh === 24 && mm !== 0) return null;
    return hh * 60 + mm;
  }

  function getLocalDateWithOffsetMinutes(offsetMinutes, fallbackOffsetMinutes) {
    var now = new Date();
    var fallbackOffset = Number.isFinite(Number(fallbackOffsetMinutes))
      ? Number(fallbackOffsetMinutes)
      : DEFAULT_TZ_OFFSET_MINUTES;
    // Beppu-specific app: always use fixed JST fallback to avoid API offset drift.
    // now.getTime() is already UTC-based epoch milliseconds.
    var resolvedOffset = fallbackOffset;
    var localMs = now.getTime() + resolvedOffset * 60000;
    return new Date(localMs);
  }

  function getMinutesUntilNextOpen(periods, utcOffsetMinutes, fallbackOffsetMinutes) {
    if (!Array.isArray(periods) || periods.length === 0) return null;
    var localNow = getLocalDateWithOffsetMinutes(utcOffsetMinutes, fallbackOffsetMinutes);
    var nowDay = localNow.getUTCDay();
    var nowMinutes = localNow.getUTCHours() * 60 + localNow.getUTCMinutes();
    var best = null;

    periods.forEach(function (period) {
      if (!period || !period.open) return;
      var openDay = Number(period.open.day);
      var openMinutes = parsePeriodTimeToMinutes(period.open.time);
      if (!Number.isFinite(openDay) || openMinutes === null) return;
      var dayDelta = (openDay - nowDay + 7) % 7;
      var totalDelta = dayDelta * 1440 + (openMinutes - nowMinutes);
      if (totalDelta <= 0) {
        totalDelta += 10080;
        dayDelta += 7;
      }
      if (!best || totalDelta < best.minutes) {
        best = {
          minutes: totalDelta,
          dayOffset: dayDelta,
          openDay: openDay,
          openMinutes: openMinutes,
        };
      }
    });

    return best;
  }

  function formatUntilOpenText(minutes) {
    if (!Number.isFinite(minutes) || minutes === null) return '';
    var total = Math.max(1, Math.round(minutes));
    if (total < 60) return '\u3042\u3068' + total + '\u5206\u3067\u55b6\u696d';
    var h = Math.floor(total / 60);
    var m = total % 60;
    if (m === 0) return '\u3042\u3068' + h + '\u6642\u9593\u3067\u55b6\u696d';
    return '\u3042\u3068' + h + '\u6642\u9593' + m + '\u5206\u3067\u55b6\u696d';
  }

  function formatMinutesToClockText(minutes) {
    if (!Number.isFinite(minutes)) return '';
    var m = Math.max(0, Math.floor(minutes));
    var hh = Math.floor(m / 60) % 24;
    var mm = m % 60;
    return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  }

  function formatClosedStatusText(nextOpenInfo) {
    if (!nextOpenInfo || !Number.isFinite(nextOpenInfo.minutes)) return '\u55b6\u696d\u6642\u9593\u5916';
    if (nextOpenInfo.minutes >= 180 && Number.isFinite(nextOpenInfo.openMinutes)) {
      var dayNames = ['\u65e5', '\u6708', '\u706b', '\u6c34', '\u6728', '\u91d1', '\u571f'];
      var clock = formatMinutesToClockText(nextOpenInfo.openMinutes);
      if (nextOpenInfo.dayOffset === 0) {
        return '\u55b6\u696d\u6642\u9593\u5916\u30fb\u672c\u65e5' + clock + '\u301c';
      }
      var dayLabel = Number.isFinite(nextOpenInfo.openDay) ? (dayNames[nextOpenInfo.openDay] + '\u66dc\u65e5') : '\u6b21\u56de';
      return '\u55b6\u696d\u6642\u9593\u5916\u30fb' + dayLabel + clock + '\u301c';
    }
    var suffix = formatUntilOpenText(nextOpenInfo.minutes);
    return suffix ? ('\u55b6\u696d\u6642\u9593\u5916\u30fb' + suffix) : '\u55b6\u696d\u6642\u9593\u5916';
  }

  function parseBusinessHoursMap(value) {
    if (!value) return null;
    var source = value;
    if (typeof source === 'string') {
      var text = source.trim();
      if (!text) return null;
      try {
        source = JSON.parse(text);
      } catch (error) {
        return null;
      }
    }
    if (!source || typeof source !== 'object') return null;
    return source;
  }

  function getOpenStatusFromBusinessHours(hoursMap, fallbackOffsetMinutes) {
    var map = parseBusinessHoursMap(hoursMap);
    if (!map) return null;

    var dayKeys = ['\u65e5', '\u6708', '\u706b', '\u6c34', '\u6728', '\u91d1', '\u571f'];
    var localNow = getLocalDateWithOffsetMinutes(null, fallbackOffsetMinutes);
    var nowDay = localNow.getUTCDay();
    var nowMinutes = localNow.getUTCHours() * 60 + localNow.getUTCMinutes();
    var prevDay = (nowDay + 6) % 7;

    function getEntries(dayIndex) {
      var key = dayKeys[dayIndex];
      var raw = map[key];
      if (!Array.isArray(raw)) return [];
      return raw
        .map(function (entry) {
          if (!entry || typeof entry !== 'object') return null;
          var openText = entry.open;
          var closeText = entry.close;
          var openM = parseClockTimeToMinutes(openText);
          var closeM = parseClockTimeToMinutes(closeText);
          if (openM === null || closeM === null) return null;
          return { open: openM, close: closeM, closeText: String(closeText || '') };
        })
        .filter(Boolean);
    }

    var prevEntries = getEntries(prevDay);
    var todayEntries = getEntries(nowDay);
    var isOpen = false;

    prevEntries.forEach(function (entry) {
      if (isOpen) return;
      if (entry.close > 0 && entry.open > entry.close && nowMinutes < entry.close) {
        isOpen = true;
      }
    });

    todayEntries.forEach(function (entry) {
      if (isOpen) return;
      if (entry.open === 0 && entry.close === 1440) {
        isOpen = true;
        return;
      }
      if (entry.open < entry.close) {
        if (nowMinutes >= entry.open && nowMinutes < entry.close) isOpen = true;
        return;
      }
      if (entry.open > entry.close && nowMinutes >= entry.open) {
        isOpen = true;
      }
    });

    if (isOpen) {
      return { text: '\u55b6\u696d\u4e2d', className: 'is-open' };
    }

    var candidates = [];
    todayEntries.forEach(function (entry) {
      if (nowMinutes < entry.open) {
        candidates.push({
          minutes: entry.open - nowMinutes,
          dayOffset: 0,
          openDay: nowDay,
          openMinutes: entry.open,
        });
      }
    });

    for (var dayOffset = 1; dayOffset <= 7; dayOffset += 1) {
      var dayEntries = getEntries((nowDay + dayOffset) % 7);
      dayEntries.forEach(function (entry) {
        candidates.push({
          minutes: dayOffset * 1440 + entry.open - nowMinutes,
          dayOffset: dayOffset,
          openDay: (nowDay + dayOffset) % 7,
          openMinutes: entry.open,
        });
      });
    }

    if (!candidates.length) {
      return { text: '\u55b6\u696d\u6642\u9593\u60c5\u5831\u306a\u3057', className: 'is-unknown' };
    }

    var nextOpenInfo = candidates.reduce(function (best, cur) {
      if (!best || cur.minutes < best.minutes) return cur;
      return best;
    }, null);
    return { text: formatClosedStatusText(nextOpenInfo), className: 'is-closed' };
  }

  function getOpenStatusCacheKey(place) {
    if (!place) return '';
    var inferredPlaceId = place.placeId || (/^ChIJ/.test(String(place.id || '')) ? String(place.id) : '');
    return inferredPlaceId || ('latlng:' + place.lat + ',' + place.lng + ':' + place.name);
  }

  function getRouteMidpoint(route) {
    if (!route || !Array.isArray(route.overview_path) || route.overview_path.length === 0) return null;
    var points = route.overview_path;
    var mid = Math.floor((points.length - 1) / 2);
    var p = points[mid];
    if (!p) return null;
    if (typeof p.lat === 'function' && typeof p.lng === 'function') {
      return { lat: p.lat(), lng: p.lng() };
    }
    if (Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
      return { lat: p.lat, lng: p.lng };
    }
    return null;
  }

  function shouldSkipFitForBounds(map, targetBounds, marginRatio) {
    if (!map || !targetBounds || targetBounds.isEmpty()) return false;
    var current = map.getBounds();
    if (!current || current.isEmpty()) return false;

    var ne = targetBounds.getNorthEast();
    var sw = targetBounds.getSouthWest();
    if (!ne || !sw) return false;

    if (!current.contains(ne) || !current.contains(sw)) return false;

    var curNe = current.getNorthEast();
    var curSw = current.getSouthWest();
    var latSpan = curNe.lat() - curSw.lat();
    var lngSpan = curNe.lng() - curSw.lng();
    if (latSpan <= 0 || lngSpan <= 0) return false;

    var targetLatSpan = ne.lat() - sw.lat();
    var targetLngSpan = ne.lng() - sw.lng();

    var ratio = Number.isFinite(marginRatio) ? marginRatio : 0.82;
    return targetLatSpan <= latSpan * ratio && targetLngSpan <= lngSpan * ratio;
  }

  function buildRouteSummary(from, to, duration, distance, modeLabel) {
    var resolvedMode = modeLabel || '\u5f92\u6b69';
    return {
      duration: duration,
      distance: distance,
      isFallback: false,
      modeLabel: resolvedMode,
      label: from + '\u2192' + to + ' ' + resolvedMode + duration + '\uff08\u7d04' + distance + '\uff09',
    };
  }

  function fallbackRouteSummary(fallbackLabel) {
    return {
      duration: '--',
      distance: '--',
      isFallback: true,
      label: fallbackLabel,
    };
  }

  function idleRouteSummary(idleLabel) {
    return {
      duration: '--',
      distance: '--',
      isFallback: false,
      label: idleLabel,
    };
  }

  function toLatLngLiteral(position) {
    if (!position) return null;
    if (typeof position.lat === 'function' && typeof position.lng === 'function') {
      return { lat: position.lat(), lng: position.lng() };
    }
    if (typeof position.lat === 'number' && typeof position.lng === 'number') {
      return { lat: position.lat, lng: position.lng };
    }
    return null;
  }

  function isFiniteCoord(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng);
  }

  function distanceMeters(lat1, lng1, lat2, lng2) {
    var toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad;
    var dLng = (lng2 - lng1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return 6371000 * c;
  }

  /**
   * @typedef {Object} BeppuMapModuleOptions
   * @property {HTMLElement} mapElement
   * @property {HTMLElement} listElement
   * @property {HTMLElement} routeChipElement
   * @property {Place[]} places
   * @property {{lat:number,lng:number,name:string}=} hotel
   * @property {{lat:number,lng:number,name:string}=} station
   * @property {number=} zoom
   * @property {number=} adaptiveNearDistanceMeters
   * @property {number=} adaptiveZoomStep
   * @property {number=} adaptiveZoomMax
   * @property {number=} walkToDriveThresholdMinutes
   * @property {number=} defaultTimezoneOffsetMinutes
   * @property {string=} idleRouteMessage
   * @property {string=} fallbackMessage
   * @property {(placeId:string|null)=>void=} onPlaceSelected
   */

  function BeppuMapModule(options) {
    this.options = options;
    this.map = null;
    this.hotelMarker = null;
    this.stationMarker = null;
    this.placeMarkers = new Map();
    this.placeCards = new Map();
    this.placeById = new Map();
    this.activePlaceId = null;
    this.visiblePlaceIds = null;
    this.directionsService = null;
    this.directionsRenderer = null;
    this.previewDirectionsRenderer = null;
    this.previewRoutePolyline = null;
    this.placesService = null;
    this.AdvancedMarkerElement = null;
    this.routeBadgeMarker = null;
    this.placePreviewElement = null;
    this._routeFitMinZoom = Number.isFinite(options.routeFitMinZoom) ? options.routeFitMinZoom : 13;
    this._routeFitMaxZoom = Number.isFinite(options.routeFitMaxZoom) ? options.routeFitMaxZoom : 18;
    this._routeFitPadding = Number.isFinite(options.routeFitPadding) ? options.routeFitPadding : 56;
    this._routeFitSkipRatio = Number.isFinite(options.routeFitSkipRatio) ? options.routeFitSkipRatio : 0.82;
    this._adaptiveNearDistanceMeters = Number.isFinite(options.adaptiveNearDistanceMeters) ? options.adaptiveNearDistanceMeters : 1200;
    this._adaptiveZoomStep = Number.isFinite(options.adaptiveZoomStep) ? options.adaptiveZoomStep : 0.8;
    this._adaptiveZoomMax = Number.isFinite(options.adaptiveZoomMax) ? options.adaptiveZoomMax : 18;
    this._walkToDriveThresholdMinutes = Number.isFinite(options.walkToDriveThresholdMinutes) ? options.walkToDriveThresholdMinutes : 20;
    this._defaultTimezoneOffsetMinutes = Number.isFinite(options.defaultTimezoneOffsetMinutes) ? options.defaultTimezoneOffsetMinutes : DEFAULT_TZ_OFFSET_MINUTES;
    this._nearStreak = 0;
    this._lastSelectionZoom = null;
    this._lastSelectedPlaceId = null;
    this._routeRequestId = 0;
    this._hoverRouteRequestId = 0;
    this._hoverPreviewPlaceId = null;
    this._routePolylineActive = {
      strokeColor: '#202020',
      strokeOpacity: 0.95,
      strokeWeight: 6,
      zIndex: 120,
    };
    this._routePolylinePreview = {
      strokeColor: '#202020',
      strokeOpacity: 0.2,
      strokeWeight: 4,
      zIndex: 80,
    };
    this._openStatusCache = new Map();
    this._openStatusTimerId = null;
    this._openStatusIntervalId = null;
    this._markerBaseZIndexById = new Map();
    this._disablePlaceCollisionCulling = options.disablePlaceCollisionCulling !== false;

    this.hotel = {
      name: options.hotel && options.hotel.name ? options.hotel.name : DEFAULT_HOTEL.name,
      lat: options.hotel && options.hotel.lat ? options.hotel.lat : DEFAULT_COORD_OVERRIDES.hotel.lat,
      lng: options.hotel && options.hotel.lng ? options.hotel.lng : DEFAULT_COORD_OVERRIDES.hotel.lng,
    };

    this.station = {
      name: options.station && options.station.name ? options.station.name : DEFAULT_STATION.name,
      lat: options.station && options.station.lat ? options.station.lat : DEFAULT_COORD_OVERRIDES.station.lat,
      lng: options.station && options.station.lng ? options.station.lng : DEFAULT_COORD_OVERRIDES.station.lng,
    };

    this.zoom = typeof options.zoom === 'number' ? options.zoom : 16.5;
    this.idleRouteMessage = options.idleRouteMessage || '店舗を選択するとルートを表示します。';
    this.fallbackMessage = options.fallbackMessage || '\u5f92\u6b69\u30eb\u30fc\u30c8\u3092\u53d6\u5f97\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f\u3002\u6642\u9593\u3092\u304a\u3044\u3066\u518d\u5ea6\u304a\u8a66\u3057\u304f\u3060\u3055\u3044\u3002';
    this.routeChipElement = options.routeChipElement;
  }

  BeppuMapModule.prototype.setRoutePolylinePreview = function setRoutePolylinePreview(isPreview) {
    if (!this.directionsRenderer) return;
    var style = isPreview ? this._routePolylinePreview : this._routePolylineActive;
    this.directionsRenderer.setOptions({
      polylineOptions: {
        strokeColor: style.strokeColor,
        strokeOpacity: style.strokeOpacity,
        strokeWeight: style.strokeWeight,
      },
    });
  };

  BeppuMapModule.prototype.clearPreviewDirections = function clearPreviewDirections() {
    if (this.previewDirectionsRenderer) {
      this.previewDirectionsRenderer.set('directions', null);
    }
    if (this.previewRoutePolyline) {
      this.previewRoutePolyline.setPath([]);
      this.previewRoutePolyline.setMap(null);
    }
  };

  BeppuMapModule.prototype.getCollisionBehavior = function getCollisionBehavior(name) {
    if (!google || !google.maps || !google.maps.CollisionBehavior) return null;
    return google.maps.CollisionBehavior[name] || null;
  };

  BeppuMapModule.prototype.applyActiveMarkerPriority = function applyActiveMarkerPriority(activePlaceId) {
    var self = this;
    var required = this.getCollisionBehavior('REQUIRED_AND_HIDES_OPTIONAL')
      || this.getCollisionBehavior('REQUIRED');
    var optional = this.getCollisionBehavior('OPTIONAL_AND_HIDES_LOWER_PRIORITY');

    this.placeMarkers.forEach(function (marker, id) {
      if (!marker) return;
      var baseZ = self._markerBaseZIndexById.get(id);
      if (!Number.isFinite(baseZ)) baseZ = 1;
      var isActive = !!activePlaceId && id === activePlaceId;
      marker.zIndex = isActive ? 1000000 : baseZ;
      if (!self._disablePlaceCollisionCulling && required && optional) {
        marker.collisionBehavior = isActive ? required : optional;
      }
    });
  };

  BeppuMapModule.prototype.init = async function init() {
    var mapsLib = await google.maps.importLibrary('maps');
    var markerLib = await google.maps.importLibrary('marker');
    var AdvancedMarkerElement = markerLib.AdvancedMarkerElement;
    this.AdvancedMarkerElement = AdvancedMarkerElement;

    var mapOptions = {
      center: { lat: this.hotel.lat, lng: this.hotel.lng },
      zoom: this.zoom,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      zoomControl: true,
      clickableIcons: false,
      gestureHandling: 'cooperative',
      styles: [
        // Base tone: soft, low-contrast grayscale to match page UI.
        { elementType: 'geometry', stylers: [{ color: '#f3f4f6' }] },
        { elementType: 'labels.text.fill', stylers: [{ color: '#6b7280' }] },
        { elementType: 'labels.text.stroke', stylers: [{ color: '#f3f4f6' }] },

        // Keep street names visible and readable.
        { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#dfe3ea' }] },
        { featureType: 'road.arterial', elementType: 'labels.text.fill', stylers: [{ color: '#616875' }] },
        { featureType: 'road.local', elementType: 'labels.text.fill', stylers: [{ color: '#6b7280' }] },

        // Water / landscape tuned to neutral palette.
        { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#d8e1ea' }] },
        { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#f6f7f9' }] },

        // Hide POI entirely (icons + labels + geometry).
        { featureType: 'poi', stylers: [{ visibility: 'off' }] },
        { featureType: 'poi.business', stylers: [{ visibility: 'off' }] },
        { featureType: 'poi.attraction', stylers: [{ visibility: 'off' }] },
        { featureType: 'poi.government', stylers: [{ visibility: 'off' }] },
        { featureType: 'poi.medical', stylers: [{ visibility: 'off' }] },
        { featureType: 'poi.place_of_worship', stylers: [{ visibility: 'off' }] },
        { featureType: 'poi.school', stylers: [{ visibility: 'off' }] },
        { featureType: 'poi.sports_complex', stylers: [{ visibility: 'off' }] },
        { featureType: 'transit', stylers: [{ visibility: 'off' }] },
        { featureType: 'transit.station', stylers: [{ visibility: 'off' }] },
      ],
    };
    // AdvancedMarkerElement warns when mapId is missing.
    mapOptions.mapId = global.GOOGLE_MAP_ID || 'DEMO_MAP_ID';

    this.map = new mapsLib.Map(this.options.mapElement, mapOptions);
    if (google.maps.places && google.maps.places.PlacesService) {
      this.placesService = new google.maps.places.PlacesService(this.map);
    }

    this.directionsService = new google.maps.DirectionsService();
    this.directionsRenderer = new google.maps.DirectionsRenderer({
      map: this.map,
      suppressMarkers: true,
      preserveViewport: true,
      polylineOptions: this._routePolylineActive,
    });

    this.previewDirectionsRenderer = new google.maps.DirectionsRenderer({
      map: this.map,
      suppressMarkers: true,
      preserveViewport: true,
      polylineOptions: this._routePolylinePreview,
    });

    this.previewRoutePolyline = new google.maps.Polyline({
      strokeColor: this._routePolylinePreview.strokeColor,
      strokeOpacity: this._routePolylinePreview.strokeOpacity,
      strokeWeight: this._routePolylinePreview.strokeWeight,
      zIndex: this._routePolylinePreview.zIndex,
      geodesic: true,
      clickable: false,
      map: null,
    });

    this.stationMarker = new AdvancedMarkerElement({
      map: this.map,
      position: { lat: this.station.lat, lng: this.station.lng },
      title: this.station.name,
      content: createMarkerNode('station', '\u99c5'),
    });

    this.hotelMarker = new AdvancedMarkerElement({
      map: this.map,
      position: { lat: this.hotel.lat, lng: this.hotel.lng },
      title: this.hotel.name,
      content: createMarkerNode('hotel', 'HOTEL'),
    });

    this.renderPlaces(this.options.places || [], AdvancedMarkerElement);
    this.bindCardEvents();
    this.refreshOpenStatuses(true);
    this.startOpenStatusAutoRefresh();

    this.directionsRenderer.set('directions', null);
    this.clearRouteBadge();
    updateRouteChip(this.routeChipElement, idleRouteSummary(this.idleRouteMessage));
  };

  BeppuMapModule.prototype.setRouteBadge = function setRouteBadge(position, durationText, travelMode) {
    if (!this.map || !this.AdvancedMarkerElement || !position) return;
    if (this.routeBadgeMarker) {
      this.routeBadgeMarker.map = null;
      this.routeBadgeMarker = null;
    }
    this.routeBadgeMarker = new this.AdvancedMarkerElement({
      map: this.map,
      position: position,
      content: createRouteBadgeNode(durationText, travelMode),
      title: (travelMode === 'DRIVING' ? '\u8eca ' : '\u5f92\u6b69 ') + (durationText || '--'),
    });
  };

  BeppuMapModule.prototype.clearRouteBadge = function clearRouteBadge() {
    if (!this.routeBadgeMarker) return;
    this.routeBadgeMarker.map = null;
    this.routeBadgeMarker = null;
  };

  BeppuMapModule.prototype.setPlacePreview = function setPlacePreview(place) {
    if (!place || !this.routeChipElement) return;
    this.clearPlacePreview();
    var preview = createPlacePreviewNode(place);
    preview.classList.add('beppu-place-preview--in-chip');
    this.routeChipElement.insertBefore(preview, this.routeChipElement.firstChild);
    this.routeChipElement.classList.add('has-preview');
    this.placePreviewElement = preview;
  };

  BeppuMapModule.prototype.getOpenStatusForPlace = function getOpenStatusForPlace(place, options) {
    var self = this;
    if (!place) return Promise.resolve({ text: '\u55b6\u696d\u6642\u9593\u60c5\u5831\u306a\u3057', className: 'is-unknown' });
    var forceRefresh = !!(options && options.forceRefresh);
    var cacheKey = getOpenStatusCacheKey(place);
    if (forceRefresh && cacheKey) {
      this._openStatusCache.delete(cacheKey);
    }
    if (this._openStatusCache.has(cacheKey)) return Promise.resolve(this._openStatusCache.get(cacheKey));

    var resolveAndCache = function (status) {
      self._openStatusCache.set(cacheKey, status);
      return status;
    };

    var csvStatus = getOpenStatusFromBusinessHours(place.businessHours, self._defaultTimezoneOffsetMinutes);
    if (csvStatus) {
      return Promise.resolve(resolveAndCache(csvStatus));
    }
    if (!this.placesService) return Promise.resolve(resolveAndCache({ text: '\u55b6\u696d\u6642\u9593\u60c5\u5831\u306a\u3057', className: 'is-unknown' }));

    return new Promise(function (resolve) {
      var finalize = function (status) {
        resolve(resolveAndCache(status));
      };

      var handleDetails = function (details, detailsStatus) {
        if (detailsStatus !== google.maps.places.PlacesServiceStatus.OK || !details) {
          finalize({ text: '\u55b6\u696d\u6642\u9593\u60c5\u5831\u306a\u3057', className: 'is-unknown' });
          return;
        }
        var openNow = details.opening_hours && typeof details.opening_hours.open_now === 'boolean'
          ? details.opening_hours.open_now
          : null;
        if (openNow === true) {
          finalize({ text: '\u55b6\u696d\u4e2d', className: 'is-open' });
          return;
        }
        if (openNow === false) {
          var nextOpenInfo = getMinutesUntilNextOpen(
            details.opening_hours && details.opening_hours.periods,
            details.utc_offset_minutes,
            self._defaultTimezoneOffsetMinutes
          );
          finalize({ text: formatClosedStatusText(nextOpenInfo), className: 'is-closed' });
          return;
        }
        finalize({ text: '\u55b6\u696d\u6642\u9593\u60c5\u5831\u306a\u3057', className: 'is-unknown' });
      };

      var inferredPlaceId = place.placeId || (/^ChIJ/.test(String(place.id || '')) ? String(place.id) : '');
      if (inferredPlaceId && /^ChIJ/.test(String(inferredPlaceId))) {
        self.placesService.getDetails(
            {
              placeId: String(inferredPlaceId),
              fields: ['opening_hours', 'utc_offset_minutes'],
            },
            handleDetails
          );
        return;
      }

      self.placesService.findPlaceFromQuery(
        {
          query: place.name + ' 別府',
          fields: ['place_id'],
          locationBias: {
            radius: 500,
            center: { lat: place.lat, lng: place.lng },
          },
        },
        function (results, findStatus) {
          if (findStatus !== google.maps.places.PlacesServiceStatus.OK || !results || !results[0] || !results[0].place_id) {
            finalize({ text: '\u55b6\u696d\u6642\u9593\u60c5\u5831\u306a\u3057', className: 'is-unknown' });
            return;
          }
          self.placesService.getDetails(
            {
              placeId: results[0].place_id,
              fields: ['opening_hours', 'utc_offset_minutes'],
            },
            handleDetails
          );
        }
      );
    });
  };

  BeppuMapModule.prototype.applyOpenStatusToPreview = function applyOpenStatusToPreview(status) {
    if (!this.placePreviewElement) return;
    var statusEl = this.placePreviewElement.querySelector('.beppu-place-preview__status');
    if (!statusEl) return;
    statusEl.textContent = status && status.text ? status.text : '\u55b6\u696d\u6642\u9593\u60c5\u5831\u306a\u3057';
    statusEl.classList.remove('is-open', 'is-closed', 'is-unknown');
    statusEl.classList.add(status && status.className ? status.className : 'is-unknown');
  };

  BeppuMapModule.prototype.refreshOpenStatuses = function refreshOpenStatuses(forceRefresh) {
    var self = this;
    var tasks = [];
    this.placeById.forEach(function (place, placeId) {
      if (!place) return;
      if (self.visiblePlaceIds && !self.visiblePlaceIds.has(placeId)) return;
      tasks.push(
        self.getOpenStatusForPlace(place, { forceRefresh: !!forceRefresh }).then(function (status) {
          self.applyOpenStatusToCard(placeId, status);
          if (self.activePlaceId === placeId) {
            self.applyOpenStatusToPreview(status);
          }
        })["catch"](function () {
          self.applyOpenStatusToCard(placeId, { text: '\u55b6\u696d\u6642\u9593\u60c5\u5831\u306a\u3057', className: 'is-unknown' });
          if (self.activePlaceId === placeId) {
            self.applyOpenStatusToPreview({ text: '\u55b6\u696d\u6642\u9593\u60c5\u5831\u306a\u3057', className: 'is-unknown' });
          }
        })
      );
    });
    return Promise.allSettled(tasks);
  };

  BeppuMapModule.prototype.startOpenStatusAutoRefresh = function startOpenStatusAutoRefresh() {
    var self = this;
    if (this._openStatusTimerId) {
      clearTimeout(this._openStatusTimerId);
      this._openStatusTimerId = null;
    }
    if (this._openStatusIntervalId) {
      clearInterval(this._openStatusIntervalId);
      this._openStatusIntervalId = null;
    }
    var now = new Date();
    var msToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    if (msToNextMinute < 250) msToNextMinute += 60000;
    this._openStatusTimerId = setTimeout(function () {
      self.refreshOpenStatuses(true);
      self._openStatusIntervalId = setInterval(function () {
        self.refreshOpenStatuses(true);
      }, 60000);
    }, msToNextMinute);
  };

  BeppuMapModule.prototype.clearPlacePreview = function clearPlacePreview() {
    if (this.routeChipElement) {
      this.routeChipElement.classList.remove('has-preview');
    }
    if (!this.placePreviewElement) return;
    if (this.placePreviewElement.parentNode) {
      this.placePreviewElement.parentNode.removeChild(this.placePreviewElement);
    }
    this.placePreviewElement = null;
  };

  BeppuMapModule.prototype.applyOpenStatusToCard = function applyOpenStatusToCard(placeId, status) {
    var card = this.placeCards.get(placeId);
    if (!card) return;
    var statusEl = card.querySelector('.spot-open-status');
    if (!statusEl) return;
    statusEl.textContent = status && status.text ? status.text : '\u55b6\u696d\u6642\u9593\u60c5\u5831\u306a\u3057';
    statusEl.classList.remove('is-open', 'is-closed', 'is-unknown');
    statusEl.classList.add(status && status.className ? status.className : 'is-unknown');
  };

  BeppuMapModule.prototype.renderPlaces = function renderPlaces(places, AdvancedMarkerElement) {
    var self = this;
    var collisionBehavior = null;
    if (google.maps && google.maps.CollisionBehavior) {
      if (self._disablePlaceCollisionCulling) {
        collisionBehavior = google.maps.CollisionBehavior.REQUIRED_AND_HIDES_OPTIONAL
          || google.maps.CollisionBehavior.REQUIRED
          || null;
      } else {
        collisionBehavior = google.maps.CollisionBehavior.OPTIONAL_AND_HIDES_LOWER_PRIORITY
          || null;
      }
    }

    places.forEach(function (place) {
      self.placeById.set(place.id, place);
      var markerNode = createMarkerNode('place', place.name, place.emojiTag || '');
      markerNode.dataset.placeId = place.id;

      var markerOptions = {
        map: self.map,
        position: { lat: place.lat, lng: place.lng },
        title: place.name,
        content: markerNode,
        zIndex: Math.max(1, 100000 - Math.round(distanceMeters(self.hotel.lat, self.hotel.lng, place.lat, place.lng))),
      };
      if (collisionBehavior) {
        markerOptions.collisionBehavior = collisionBehavior;
      }
      var marker = new AdvancedMarkerElement(markerOptions);
      self._markerBaseZIndexById.set(place.id, markerOptions.zIndex);

      if (typeof marker.addEventListener === 'function') {
        marker.addEventListener('gmp-click', function () {
          self.selectPlace(place.id);
        });
      } else {
        marker.addListener('click', function () {
          self.selectPlace(place.id);
        });
      }

      self.placeMarkers.set(place.id, marker);

      var card = place.cardElement || self.options.listElement.querySelector('[data-place-id="' + place.id + '"]');
      if (card) {
        self.placeCards.set(place.id, card);
        card.dataset.placeId = place.id;
      }
    });
  };

  BeppuMapModule.prototype.bindCardEvents = function bindCardEvents() {
    var self = this;
    var listElement = self.options.listElement;

    if (listElement && !self._listDelegateBound) {
      var delegateHandler = function delegateHandler(event) {
        var target = event.target;
        if (!(target instanceof Element)) return;

        var card = target.closest('.spot-item');
        if (!card || !listElement.contains(card)) return;

        var placeId = card.getAttribute('data-place-id');
        if (!placeId) return;

        event.preventDefault();
        self.selectPlace(placeId);
      };

      listElement.addEventListener('click', delegateHandler);
      listElement.addEventListener('touchend', delegateHandler, { passive: false });
      self._listDelegateBound = true;
      self._listDelegateHandler = delegateHandler;
    }

  };

  BeppuMapModule.prototype.fitBoundsToPoints = function fitBoundsToPoints(bounds, padding, minZoom, maxZoom) {
    if (!this.map || !bounds || bounds.isEmpty()) return;
    this.map.fitBounds(bounds, {
      left: padding,
      right: padding,
      top: padding,
      bottom: padding,
    });

    var zoom = this.map.getZoom();
    if (Number.isFinite(zoom)) {
      var nextZoom = zoom;
      if (Number.isFinite(minZoom)) {
        nextZoom = Math.max(nextZoom, minZoom);
      }
      if (Number.isFinite(maxZoom)) {
        nextZoom = Math.min(nextZoom, maxZoom);
      }
      nextZoom = Math.max(0, Math.min(22, nextZoom));
      if (nextZoom !== zoom) {
        this.map.setZoom(nextZoom);
      }
    }
  };

  BeppuMapModule.prototype.fitToPlaceIds = function fitToPlaceIds(placeIds, options) {
    if (!this.map || !google || !google.maps) return;

    var set = new Set(placeIds || []);
    var includeHotelStation = !options || options.includeHotelStation !== false;
    var maxDistanceFromHotelMeters = Number.isFinite(options && options.maxDistanceFromHotelMeters)
      ? Number(options.maxDistanceFromHotelMeters)
      : null;
    var bounds = new google.maps.LatLngBounds();
    var hasPoint = false;

    var addPoint = function (lat, lng) {
      if (!isFiniteCoord(lat, lng)) return;
      bounds.extend({ lat: lat, lng: lng });
      hasPoint = true;
    };

    if (includeHotelStation) {
      addPoint(this.hotel.lat, this.hotel.lng);
      addPoint(this.station.lat, this.station.lng);
    }

    var self = this;
    this.placeMarkers.forEach(function (marker, id) {
      if (!set.size || !set.has(id)) return;
      if (!marker || marker.map !== self.map) return;
      var position = toLatLngLiteral(marker.position);
      if (!position) return;
      if (Number.isFinite(maxDistanceFromHotelMeters)) {
        var dHotel = distanceMeters(self.hotel.lat, self.hotel.lng, position.lat, position.lng);
        if (dHotel > maxDistanceFromHotelMeters) return;
      }
      addPoint(position.lat, position.lng);
    });

    if (!hasPoint) {
      addPoint(this.hotel.lat, this.hotel.lng);
      addPoint(this.station.lat, this.station.lng);
    }

    this.fitBoundsToPoints(
      bounds,
      Number.isFinite(options && options.padding) ? options.padding : this._routeFitPadding,
      Number.isFinite(options && options.minZoom) ? options.minZoom : this._routeFitMinZoom,
      Number.isFinite(options && options.maxZoom) ? options.maxZoom : this._routeFitMaxZoom
    );
  };

  BeppuMapModule.prototype.setPlaceVisibility = function setPlaceVisibility(visiblePlaceIds) {
    this._nearStreak = 0;
    this._lastSelectedPlaceId = null;
    this._lastSelectionZoom = this.map && typeof this.map.getZoom === 'function' ? this.map.getZoom() : null;

    var visibleSet = new Set(visiblePlaceIds || []);
    this.visiblePlaceIds = visibleSet;

    var self = this;
    this.placeMarkers.forEach(function (marker, id) {
      var visible = visibleSet.size === 0 ? false : visibleSet.has(id);
      marker.map = visible ? self.map : null;
      var card = self.placeCards.get(id);
      if (card) card.classList.toggle('is-hidden', !visible);
    });

    if (this.activePlaceId && !visibleSet.has(this.activePlaceId)) {
      this.clearSelection();
    }
    this.applyActiveMarkerPriority(this.activePlaceId);
    this.refreshOpenStatuses(true);

  };

  BeppuMapModule.prototype.clearSelection = async function clearSelection() {
    this._hoverPreviewPlaceId = null;
    this._hoverRouteRequestId += 1;
    this.setRoutePolylinePreview(false);
    this.clearPreviewDirections();
    this.activePlaceId = null;
    this._nearStreak = 0;
    this._lastSelectedPlaceId = null;
    this._lastSelectionZoom = this.map && typeof this.map.getZoom === 'function' ? this.map.getZoom() : null;
    this.clearPlacePreview();

    this.placeMarkers.forEach(function (marker) {
      if (!(marker.content instanceof HTMLElement)) return;
      marker.content.classList.remove('is-active');
      marker.content.classList.remove('is-route-focus');
      marker.content.classList.remove('is-dim');
      marker.content.classList.remove('is-hover-preview');
    });
    this.placeCards.forEach(function (card) {
      card.classList.remove('is-active');
    });
    if (this.hotelMarker && this.hotelMarker.content instanceof HTMLElement) {
      this.hotelMarker.content.classList.remove('is-route-focus');
      this.hotelMarker.content.classList.remove('is-dim');
    }
    if (this.stationMarker && this.stationMarker.content instanceof HTMLElement) {
      this.stationMarker.content.classList.remove('is-dim');
      this.stationMarker.content.classList.remove('is-route-focus');
    }

    if (typeof this.options.onPlaceSelected === 'function') {
      this.options.onPlaceSelected(null);
    }

    this.directionsRenderer.set('directions', null);
    this.clearRouteBadge();
    updateRouteChip(this.routeChipElement, idleRouteSummary(this.idleRouteMessage));
    this.applyActiveMarkerPriority(null);
  };

  BeppuMapModule.prototype.applyHoverPreviewMarker = function applyHoverPreviewMarker() {
    var hoverPlaceId = this._hoverPreviewPlaceId;
    var activePlaceId = this.activePlaceId;
    this.placeMarkers.forEach(function (marker, id) {
      if (!(marker.content instanceof HTMLElement)) return;
      var shouldHighlight = !!hoverPlaceId && id === hoverPlaceId && id !== activePlaceId;
      marker.content.classList.toggle('is-hover-preview', shouldHighlight);
    });
  };

  BeppuMapModule.prototype.previewPlaceRoute = async function previewPlaceRoute(placeId) {
    if (!this.placeById.has(placeId)) return;
    if (this.visiblePlaceIds && !this.visiblePlaceIds.has(placeId)) return;
    if (this.activePlaceId && this.activePlaceId === placeId) {
      this.clearPreviewRoute();
      return;
    }

    this._hoverPreviewPlaceId = placeId;
    this._hoverRouteRequestId += 1;
    this.applyHoverPreviewMarker();

    var place = this.placeById.get(placeId);
    if (!place) {
      this.clearPreviewRoute();
      return;
    }

    var summary = await this.drawPreviewRoute(
      { lat: this.hotel.lat, lng: this.hotel.lng, name: this.hotel.name },
      { lat: place.lat, lng: place.lng, name: place.name },
      placeId
    );
    if (this._hoverPreviewPlaceId !== placeId || (summary && summary.ignored)) return;
  };

  BeppuMapModule.prototype.clearPreviewRoute = function clearPreviewRoute() {
    this._hoverPreviewPlaceId = null;
    this._hoverRouteRequestId += 1;
    this.clearPreviewDirections();
    this.applyHoverPreviewMarker();
  };

  BeppuMapModule.prototype.selectPlace = async function selectPlace(placeId) {
    if (!this.placeMarkers.has(placeId)) return;
    if (this.visiblePlaceIds && !this.visiblePlaceIds.has(placeId)) return;
    this._hoverPreviewPlaceId = null;
    this._hoverRouteRequestId += 1;
    this.setRoutePolylinePreview(false);
    this.clearPreviewDirections();

    var currentZoom = this.map && typeof this.map.getZoom === 'function' ? this.map.getZoom() : null;
    if (Number.isFinite(currentZoom) && Number.isFinite(this._lastSelectionZoom) && currentZoom < this._lastSelectionZoom) {
      this._nearStreak = 0;
      this._lastSelectedPlaceId = null;
    }

    var previousPlace = this._lastSelectedPlaceId ? this.placeById.get(this._lastSelectedPlaceId) : null;
    var nextPlace = this.placeById.get(placeId);
    if (previousPlace && nextPlace) {
      var d = distanceMeters(previousPlace.lat, previousPlace.lng, nextPlace.lat, nextPlace.lng);
      if (d <= this._adaptiveNearDistanceMeters) {
        this._nearStreak += 1;
      } else {
        this._nearStreak = 1;
      }
    } else {
      this._nearStreak = 1;
    }

    this.activePlaceId = placeId;

    this.placeMarkers.forEach(function (marker, id) {
      if (!(marker.content instanceof HTMLElement)) return;
      marker.content.classList.toggle('is-active', id === placeId);
      marker.content.classList.toggle('is-route-focus', id === placeId);
      marker.content.classList.toggle('is-dim', id !== placeId);
      marker.content.classList.remove('is-hover-preview');
      if (id === placeId) {
        marker.content.classList.remove('is-pop');
        // restart animation on every selection
        marker.content.offsetWidth;
        marker.content.classList.add('is-pop');
        if (marker.content.__popTimerId) {
          clearTimeout(marker.content.__popTimerId);
        }
        marker.content.__popTimerId = setTimeout(function () {
          if (marker.content instanceof HTMLElement) {
            marker.content.classList.remove('is-pop');
          }
        }, 460);
      }
    });

    this.placeCards.forEach(function (card, id) {
      card.classList.toggle('is-active', id === placeId);
    });
    this.applyActiveMarkerPriority(placeId);

    var activeCard = this.placeCards.get(placeId);
    if (activeCard && typeof activeCard.scrollIntoView === 'function') {
      activeCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    if (this.hotelMarker && this.hotelMarker.content instanceof HTMLElement) {
      this.hotelMarker.content.classList.add('is-route-focus');
      this.hotelMarker.content.classList.remove('is-dim');
    }
    if (this.stationMarker && this.stationMarker.content instanceof HTMLElement) {
      this.stationMarker.content.classList.remove('is-dim');
      this.stationMarker.content.classList.remove('is-route-focus');
    }

    if (typeof this.options.onPlaceSelected === 'function') {
      this.options.onPlaceSelected(placeId);
    }

    var place = nextPlace || this.placeById.get(placeId);
    if (!place) return;

    var summary = await this.drawRoute(
      { lat: this.hotel.lat, lng: this.hotel.lng, name: this.hotel.name },
      { lat: place.lat, lng: place.lng, name: place.name },
      place.id
    );

    if (this.activePlaceId !== placeId || (summary && summary.ignored)) return;

    updateRouteChip(this.routeChipElement, summary.summary || summary);
    if (summary && summary.summary && summary.summary.isFallback) {
      this.clearPlacePreview();
    } else {
      var previewPlace = {
        id: place.id,
        name: place.name,
        lat: place.lat,
        lng: place.lng,
        thumbnail: resolvePreviewThumbnail(place, activeCard),
        openStatusText: '\u55b6\u696d\u6642\u9593\u78ba\u8a8d\u4e2d...',
        openStatusClass: 'is-unknown',
      };
      this.setPlacePreview(previewPlace);
      this.applyOpenStatusToCard(place.id, { text: '\u55b6\u696d\u6642\u9593\u78ba\u8a8d\u4e2d...', className: 'is-unknown' });
      var self = this;
      this.getOpenStatusForPlace(place).then(function (status) {
        if (self.activePlaceId !== place.id) return;
        previewPlace.openStatusText = status.text;
        previewPlace.openStatusClass = status.className;
        self.setPlacePreview(previewPlace);
        self.applyOpenStatusToCard(place.id, status);
      })["catch"](function () {
        if (self.activePlaceId !== place.id) return;
        previewPlace.openStatusText = '\u55b6\u696d\u6642\u9593\u60c5\u5831\u306a\u3057';
        previewPlace.openStatusClass = 'is-unknown';
        self.setPlacePreview(previewPlace);
        self.applyOpenStatusToCard(place.id, { text: '\u55b6\u696d\u6642\u9593\u60c5\u5831\u306a\u3057', className: 'is-unknown' });
      });
    }
    var appliedAdaptiveZoom = false;
    if (this._nearStreak >= 1 && this.map && google && google.maps) {
      var adaptiveBounds = new google.maps.LatLngBounds();
      adaptiveBounds.extend({ lat: this.hotel.lat, lng: this.hotel.lng });
      adaptiveBounds.extend({ lat: place.lat, lng: place.lng });
      this.fitBoundsToPoints(
        adaptiveBounds,
        this._routeFitPadding,
        this._routeFitMinZoom,
        Math.min(this._routeFitMaxZoom, this._adaptiveZoomMax)
      );
      appliedAdaptiveZoom = true;
    }

    if (!appliedAdaptiveZoom && summary && summary.routeBounds && !shouldSkipFitForBounds(this.map, summary.routeBounds, this._routeFitSkipRatio)) {
      this.fitBoundsToPoints(summary.routeBounds, this._routeFitPadding, this._routeFitMinZoom, this._routeFitMaxZoom);
    }

    this._lastSelectedPlaceId = placeId;
    this._lastSelectionZoom = this.map && typeof this.map.getZoom === 'function' ? this.map.getZoom() : null;
  };

  BeppuMapModule.prototype.drawRoute = function drawRoute(origin, destination, targetPlaceId) {
    var self = this;
    var requestId = ++this._routeRequestId;

    return new Promise(function (resolve) {
      var isStaleRequest = function isStaleRequest() {
        if (requestId !== self._routeRequestId) return true;
        if (targetPlaceId && self.activePlaceId !== targetPlaceId) return true;
        return false;
      };

      var applyResolvedRoute = function applyResolvedRoute(resolvedResult, mode, modeLabel) {
        if (isStaleRequest()) {
          resolve({ ignored: true });
          return;
        }
        var route = resolvedResult.routes[0];
        var leg = route.legs[0];
        var duration = leg.duration && typeof leg.duration.value === 'number'
          ? formatDurationJa(leg.duration.value)
          : '--';
        var distance = leg.distance && typeof leg.distance.value === 'number'
          ? formatDistanceJa(leg.distance.value)
          : '--';
        self.directionsRenderer.setDirections(resolvedResult);
        self.setRouteBadge(getRouteMidpoint(route), duration, mode);
        resolve({
          summary: buildRouteSummary(origin.name, destination.name, duration, distance, modeLabel),
          routeBounds: route.bounds || null,
        });
      };

      self.directionsService.route(
        {
          origin: { lat: origin.lat, lng: origin.lng },
          destination: { lat: destination.lat, lng: destination.lng },
          travelMode: google.maps.TravelMode.WALKING,
          provideRouteAlternatives: false,
        },
        function (result, status) {
          if (isStaleRequest()) {
            resolve({ ignored: true });
            return;
          }
          if (status === 'OK' && result && result.routes && result.routes[0] && result.routes[0].legs[0]) {
            var walkLeg = result.routes[0].legs[0];
            var walkDurationSec = walkLeg.duration && typeof walkLeg.duration.value === 'number'
              ? walkLeg.duration.value
              : null;
            var shouldUseDriving = Number.isFinite(walkDurationSec)
              && (walkDurationSec / 60) > self._walkToDriveThresholdMinutes;

            if (shouldUseDriving) {
              self.directionsService.route(
                {
                  origin: { lat: origin.lat, lng: origin.lng },
                  destination: { lat: destination.lat, lng: destination.lng },
                  travelMode: google.maps.TravelMode.DRIVING,
                  provideRouteAlternatives: false,
                },
                function (driveResult, driveStatus) {
                  if (isStaleRequest()) {
                    resolve({ ignored: true });
                    return;
                  }
                  if (driveStatus === 'OK' && driveResult && driveResult.routes && driveResult.routes[0] && driveResult.routes[0].legs[0]) {
                    applyResolvedRoute(driveResult, 'DRIVING', '\u8eca\u3067');
                    return;
                  }
                  applyResolvedRoute(result, 'WALKING', '\u5f92\u6b69');
                }
              );
              return;
            }

            applyResolvedRoute(result, 'WALKING', '\u5f92\u6b69');
            return;
          }

          if (isStaleRequest()) {
            resolve({ ignored: true });
            return;
          }
          self.directionsRenderer.set('directions', null);
          self.clearRouteBadge();
          resolve({
            summary: fallbackRouteSummary(self.fallbackMessage),
            routeBounds: null,
          });
        }
      );
    });
  };

  BeppuMapModule.prototype.drawPreviewRoute = function drawPreviewRoute(origin, destination, targetPlaceId) {
    var self = this;
    var requestId = ++this._hoverRouteRequestId;

    return new Promise(function (resolve) {
      var isStaleRequest = function isStaleRequest() {
        if (requestId !== self._hoverRouteRequestId) return true;
        if (!targetPlaceId || self._hoverPreviewPlaceId !== targetPlaceId) return true;
        return false;
      };

      var applyResolvedRoute = function applyResolvedRoute(resolvedResult) {
        if (isStaleRequest()) {
          resolve({ ignored: true });
          return;
        }
        if (!self.previewRoutePolyline) {
          resolve({ ignored: true });
          return;
        }
        var route = resolvedResult && resolvedResult.routes && resolvedResult.routes[0];
        var path = route && Array.isArray(route.overview_path) ? route.overview_path : null;
        if (!path || !path.length) {
          self.clearPreviewDirections();
          resolve({ ok: false });
          return;
        }
        self.previewRoutePolyline.setPath(path);
        self.previewRoutePolyline.setMap(self.map);
        resolve({ ok: true });
      };

      self.directionsService.route(
        {
          origin: { lat: origin.lat, lng: origin.lng },
          destination: { lat: destination.lat, lng: destination.lng },
          travelMode: google.maps.TravelMode.WALKING,
          provideRouteAlternatives: false,
        },
        function (result, status) {
          if (isStaleRequest()) {
            resolve({ ignored: true });
            return;
          }
          if (status === 'OK' && result && result.routes && result.routes[0] && result.routes[0].legs[0]) {
            var walkLeg = result.routes[0].legs[0];
            var walkDurationSec = walkLeg.duration && typeof walkLeg.duration.value === 'number'
              ? walkLeg.duration.value
              : null;
            var shouldUseDriving = Number.isFinite(walkDurationSec)
              && (walkDurationSec / 60) > self._walkToDriveThresholdMinutes;

            if (shouldUseDriving) {
              self.directionsService.route(
                {
                  origin: { lat: origin.lat, lng: origin.lng },
                  destination: { lat: destination.lat, lng: destination.lng },
                  travelMode: google.maps.TravelMode.DRIVING,
                  provideRouteAlternatives: false,
                },
                function (driveResult, driveStatus) {
                  if (isStaleRequest()) {
                    resolve({ ignored: true });
                    return;
                  }
                  if (driveStatus === 'OK' && driveResult && driveResult.routes && driveResult.routes[0] && driveResult.routes[0].legs[0]) {
                    applyResolvedRoute(driveResult);
                    return;
                  }
                  applyResolvedRoute(result);
                }
              );
              return;
            }

            applyResolvedRoute(result);
            return;
          }

          if (isStaleRequest()) {
            resolve({ ignored: true });
            return;
          }
          self.clearPreviewDirections();
          resolve({ ok: false });
        }
      );
    });
  };

  global.BeppuMapModule = BeppuMapModule;
  global.mapWebflowCmsItemsToPlaces = mapWebflowCmsItemsToPlaces;
  global.extractPlacesFromWebflowDom = extractPlacesFromWebflowDom;
  global.normalizeCategory = normalizeCategory;
})(window);
