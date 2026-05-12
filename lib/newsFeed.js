'use strict';
/**
 * lib/newsFeed.js — Scraping de noticias financieras vía RSS
 * Fuentes: Yahoo Finance, Seeking Alpha, CNBC, MarketWatch
 */

var https = require('https');

// ─── Fuentes RSS disponibles ─────────────────────────────────────────────────
var RSS_SOURCES = {
  yahoo_finance: 'https://finance.yahoo.com/news/rssindex',
  seeking_alpha: 'https://seekingalpha.com/feed.xml',
  marketwatch: 'https://feeds.content.dowjones.io/public/rss/mw_topstories',
  cnbc: 'https://www.cnbc.com/id/100003114/device/rss/rss.html'
};

// ─── Keywords por categoría ──────────────────────────────────────────────────
var CATEGORY_KEYWORDS = {
  earnings: ['earnings', 'eps', 'revenue', 'beat', 'miss', 'guidance', 'profit', 'loss', 'q1', 'q2', 'q3', 'q4', 'quarterly'],
  fda: ['fda', 'approval', 'clinical trial', 'phase 3', 'phase iii', 'drug', 'therapy', 'biotech', 'pharma'],
  merger: ['merger', 'acquisition', 'acquire', 'buyout', 'takeover', 'deal', 'agreement'],
  fed: ['fed', 'fomc', 'interest rate', 'rate hike', 'rate cut', 'monetary policy', 'powell'],
  macro: ['cpi', 'inflation', 'gdp', 'unemployment', 'jobs report', 'nfp', 'recession'],
  crypto: ['bitcoin', 'crypto', 'blockchain', 'ethereum', 'btc', 'eth', 'etf', 'cryptocurrency'],
  tech: ['ai', 'artificial intelligence', 'chip', 'semiconductor', 'nvidia', 'apple', 'tesla']
};

// ─── Mapeo de símbolos por keyword ───────────────────────────────────────────
var SYMBOL_MAP = {
  apple: 'AAPL', aapl: 'AAPL',
  microsoft: 'MSFT', msft: 'MSFT',
  nvidia: 'NVDA', nvda: 'NVDA',
  tesla: 'TSLA', tsla: 'TSLA',
  amazon: 'AMZN', amzn: 'AMZN',
  google: 'GOOGL', googl: 'GOOGL', alphabet: 'GOOGL',
  meta: 'META', facebook: 'META',
  bitcoin: 'BTC-USD', btc: 'BTC-USD',
  ethereum: 'ETH-USD', eth: 'ETH-USD',
  gold: 'GC=F', 'gold futures': 'GC=F',
  oil: 'CL=F', 'crude oil': 'CL=F',
  spy: 'SPY', 's\u0026p 500': '^GSPC',
  ndx: 'NDX', nasdaq: '^IXIC',
  dji: '^DJI', dow: '^DJI'
};

// ─── Fetch HTTP simple ─────────────────────────────────────────────────────
function fetchUrl(url) {
  return new Promise(function(resolve, reject) {
    var maxRedirects = 3;
    function doRequest(targetUrl, redirectsLeft) {
      var parsed = new URL(targetUrl);
      var options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/rss+xml, application/xml, text/xml, */*'
        },
        timeout: 15000
      };
      var req = https.request(options, function(res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          doRequest(res.headers.location, redirectsLeft - 1);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error('HTTP ' + res.statusCode + ' para ' + targetUrl));
          return;
        }
        var data = '';
        res.on('data', function(chunk) { data += chunk; });
        res.on('end', function() { resolve(data); });
      });
      req.on('error', function(err) { reject(err); });
      req.on('timeout', function() { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    }
    doRequest(url, maxRedirects);
  });
}

// ─── Parseo básico de RSS ──────────────────────────────────────────────────
function parseRss(xml) {
  var items = [];
  var itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  var match;
  while ((match = itemRegex.exec(xml)) !== null) {
    var itemXml = match[1];
    var title = extractTag(itemXml, 'title');
    var link = extractTag(itemXml, 'link');
    var description = extractTag(itemXml, 'description') || extractTag(itemXml, 'summary');
    var pubDate = extractTag(itemXml, 'pubDate');
    if (title) {
      items.push({
        headline: cleanText(title),
        summary: cleanText(description || ''),
        url: cleanText(link || ''),
        published_at: pubDate ? Math.floor(new Date(pubDate).getTime() / 1000) : Math.floor(Date.now() / 1000)
      });
    }
  }
  return items;
}

function extractTag(xml, tag) {
  var regex = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i');
  var match = xml.match(regex);
  if (!match) return null;
  var content = match[1];
  content = content.replace(/\<!\[CDATA\[([\s\S]*?)\]\]\>/g, '$1');
  return content.trim();
}

function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/\[CDATA\[([\s\S]*?)\]\]/g, '$1')
    .replace(/\<[^\u003e]+\>/g, ' ')
    .replace(/\&amp;/g, '\&')
    .replace(/\&lt;/g, '<')
    .replace(/\&gt;/g, '>')
    .replace(/\&quot;/g, '"')
    .replace(/\&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Clasificación de noticias ─────────────────────────────────────────────
function classifyNews(headline, summary) {
  var text = (headline + ' ' + summary).toLowerCase();
  var categories = [];
  var symbols = [];
  var sentiment = 0;

  for (var cat in CATEGORY_KEYWORDS) {
    var keywords = CATEGORY_KEYWORDS[cat];
    for (var i = 0; i < keywords.length; i++) {
      if (text.indexOf(keywords[i]) !== -1) {
        categories.push(cat);
        break;
      }
    }
  }

  for (var keyword in SYMBOL_MAP) {
    if (text.indexOf(keyword) !== -1) {
      var sym = SYMBOL_MAP[keyword];
      if (symbols.indexOf(sym) === -1) symbols.push(sym);
    }
  }

  var positiveWords = ['surge', 'soar', 'jump', 'rally', 'gain', 'beat', 'strong', 'bull', 'growth', 'approve', 'breakthrough', 'record'];
  var negativeWords = ['plunge', 'crash', 'drop', 'fall', 'decline', 'miss', 'weak', 'bear', 'cut', 'loss', 'delay', 'reject', 'concern'];
  var posCount = 0, negCount = 0;
  for (var i = 0; i < positiveWords.length; i++) {
    if (text.indexOf(positiveWords[i]) !== -1) posCount++;
  }
  for (var i = 0; i < negativeWords.length; i++) {
    if (text.indexOf(negativeWords[i]) !== -1) negCount++;
  }
  sentiment = posCount > negCount ? Math.min(posCount * 0.3, 1.0) : (negCount > posCount ? Math.max(-negCount * 0.3, -1.0) : 0);

  return {
    category: categories.length > 0 ? categories[0] : 'general',
    categories: categories,
    symbols: symbols,
    sentiment: sentiment
  };
}

// ─── Fetch noticias de una fuente ────────────────────────────────────────────
function fetchFromSource(sourceName, sourceUrl) {
  return fetchUrl(sourceUrl).then(function(xml) {
    var items = parseRss(xml);
    var classified = items.map(function(item) {
      var cls = classifyNews(item.headline, item.summary);
      return {
        source: sourceName,
        headline: item.headline,
        summary: item.summary,
        url: item.url,
        symbols: cls.symbols,
        sentiment: cls.sentiment,
        category: cls.category,
        categories: cls.categories,
        published_at: item.published_at
      };
    });
    return classified;
  }).catch(function(err) {
    console.log('[NewsFeed] Error en ' + sourceName + ':', err.message);
    return [];
  });
}

// ─── Fetch todas las fuentes ─────────────────────────────────────────────────
function fetchAllNews() {
  var sources = Object.keys(RSS_SOURCES);
  var promises = sources.map(function(name) {
    return fetchFromSource(name, RSS_SOURCES[name]);
  });
  return Promise.all(promises).then(function(results) {
    var all = [];
    for (var i = 0; i < results.length; i++) {
      all = all.concat(results[i]);
    }
    var seen = {};
    var unique = [];
    for (var i = 0; i < all.length; i++) {
      var key = all[i].headline.toLowerCase().substring(0, 60);
      if (!seen[key]) {
        seen[key] = true;
        unique.push(all[i]);
      }
    }
    unique.sort(function(a, b) { return b.published_at - a.published_at; });
    return unique;
  });
}

// ─── Exports ─────────────────────────────────────────────────────────────────
module.exports = {
  fetchAllNews: fetchAllNews,
  fetchFromSource: fetchFromSource,
  classifyNews: classifyNews,
  RSS_SOURCES: RSS_SOURCES,
  CATEGORY_KEYWORDS: CATEGORY_KEYWORDS,
  SYMBOL_MAP: SYMBOL_MAP
};
