// beppu-i18n.js
// 別府マップの多言語化。/data/i18n.json を読み込み、
// data-i18n="ui.xxx" 属性のテキストを差し替える。
// 言語選択は localStorage('beppu.lang') に保存。未保存なら navigator.language で推定。
// 動的に生成される文言は window.BeppuI18n.t('ui.xxx') を呼ぶ。

(function (global) {
  'use strict';

  var STORAGE_KEY = 'beppu.lang';
  var DEFAULT_LANG = 'ja';
  var FALLBACK_LANG = 'ja';

  function detectLangFromNavigator(languages) {
    if (!languages || !languages.length) return DEFAULT_LANG;
    var navLangs = [];
    if (Array.isArray(navigator.languages)) navLangs = navLangs.concat(navigator.languages);
    if (navigator.language) navLangs.push(navigator.language);
    for (var i = 0; i < navLangs.length; i += 1) {
      var nav = String(navLangs[i] || '').trim();
      for (var j = 0; j < languages.length; j += 1) {
        var entry = languages[j];
        var matches = entry.navMatch || [];
        for (var k = 0; k < matches.length; k += 1) {
          // exact or prefix match (e.g. "en-US" matches "en")
          var pattern = String(matches[k]).toLowerCase();
          var navLower = nav.toLowerCase();
          if (navLower === pattern || navLower.indexOf(pattern + '-') === 0 || pattern.indexOf(navLower + '-') === 0) {
            return entry.code;
          }
        }
      }
    }
    return DEFAULT_LANG;
  }

  function getStoredLang() {
    try {
      return global.localStorage ? global.localStorage.getItem(STORAGE_KEY) : null;
    } catch (e) { return null; }
  }
  function setStoredLang(code) {
    try {
      if (global.localStorage) global.localStorage.setItem(STORAGE_KEY, code);
    } catch (e) {}
  }

  function getByPath(obj, path) {
    if (!obj || !path) return undefined;
    var parts = path.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i += 1) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function format(template, params) {
    if (template == null) return '';
    if (!params) return String(template);
    return String(template).replace(/\{(\w+)\}/g, function (_, key) {
      return params[key] != null ? String(params[key]) : '{' + key + '}';
    });
  }

  var I18n = {
    state: {
      ready: false,
      lang: DEFAULT_LANG,
      languages: [],
      dict: null,
      listeners: [],
    },

    load: function load(url) {
      var self = this;
      return fetch(url, { cache: 'no-store' })
        .then(function (res) {
          if (!res.ok) throw new Error('i18n fetch failed: ' + res.status);
          return res.json();
        })
        .then(function (data) {
          self.state.dict = data;
          self.state.languages = data.languages || [];
          var storedLang = getStoredLang();
          var validCodes = self.state.languages.map(function (l) { return l.code; });
          var initial = storedLang && validCodes.indexOf(storedLang) >= 0
            ? storedLang
            : detectLangFromNavigator(self.state.languages);
          self.state.lang = initial;
          self.state.ready = true;
          self.applyDom();
          self.notify();
          return data;
        });
    },

    setLang: function setLang(code) {
      if (!this.state.dict) return;
      var validCodes = this.state.languages.map(function (l) { return l.code; });
      if (validCodes.indexOf(code) < 0) return;
      if (this.state.lang === code) return;
      this.state.lang = code;
      setStoredLang(code);
      this.applyDom();
      this.notify();
    },

    getLang: function getLang() { return this.state.lang; },
    getLanguages: function getLanguages() { return this.state.languages.slice(); },

    t: function t(key, params) {
      if (!this.state.dict) return '';
      var primary = getByPath(this.state.dict[this.state.lang], key);
      if (primary == null) primary = getByPath(this.state.dict[FALLBACK_LANG], key);
      if (primary == null) return key;
      return format(primary, params);
    },

    // shop master の i18n フィールドを参照。i18n 列がなければ日本語にフォールバック
    shopField: function shopField(place, field) {
      if (!place) return '';
      var lang = this.state.lang;
      if (lang !== 'ja' && place.i18n && place.i18n[lang] && place.i18n[lang][field]) {
        return place.i18n[lang][field];
      }
      // fallback: 日本語の元値
      if (field === 'name') return place.name || '';
      if (field === 'address') return place.address || place.formatted_address || '';
      if (field === 'caption') return place.caption || place.caption_override || place.caption_auto || place['レビュー要約文'] || '';
      return '';
    },

    applyDom: function applyDom() {
      if (!this.state.dict) return;
      var self = this;
      var nodes = document.querySelectorAll('[data-i18n]');
      nodes.forEach(function (node) {
        var key = node.getAttribute('data-i18n');
        if (!key) return;
        var attr = node.getAttribute('data-i18n-attr'); // e.g. "aria-label,title"
        var value = self.t(key);
        if (attr) {
          var attrs = attr.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
          attrs.forEach(function (a) { node.setAttribute(a, value); });
        } else {
          node.textContent = value;
        }
      });
      document.documentElement.setAttribute('lang', this.state.lang === 'ja' ? 'ja'
        : this.state.lang === 'en' ? 'en'
        : this.state.lang === 'zh_cn' ? 'zh-CN'
        : this.state.lang === 'zh_tw' ? 'zh-TW'
        : this.state.lang === 'ko' ? 'ko' : 'ja');
    },

    onChange: function onChange(fn) {
      if (typeof fn === 'function') this.state.listeners.push(fn);
    },
    notify: function notify() {
      var self = this;
      this.state.listeners.forEach(function (fn) {
        try { fn(self.state.lang); } catch (e) {}
      });
    },
  };

  global.BeppuI18n = I18n;
})(window);
