// api/sync.js
async function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length) return JSON.parse(req.body);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-sync-pin');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
    const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    const SYNC_PIN = (process.env.SYNC_PIN || '').trim();

    const sbFetch = async (path, options = {}) => {
      const headers = {
        'apikey': SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
        ...(options.headers || {})
      };
      if (!SUPABASE_KEY.startsWith('sb_')) {
        headers['Authorization'] = `Bearer ${SUPABASE_KEY}`;
      }
      const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...options, headers });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
      return { ok: response.ok, status: response.status, data };
    };

    const { action, url, q } = req.query;

    // 1. CANLI ÜRÜN ARAMA ÖNERİLERİ (?q=...)
    if (q) {
      const query = encodeURIComponent(q.trim());
      const [suggestRes, ddgRes] = await Promise.allSettled([
        fetch(`https://suggestqueries.google.com/complete/search?client=firefox&hl=tr&q=${query}`),
        fetch(`https://duckduckgo.com/ac/?q=${query}&kl=tr-tr`)
      ]);

      let suggestions = [];
      if (suggestRes.status === 'fulfilled' && suggestRes.value.ok) {
        const data = await suggestRes.value.json();
        if (Array.isArray(data[1])) suggestions.push(...data[1]);
      }
      if (ddgRes.status === 'fulfilled' && ddgRes.value.ok) {
        const data = await ddgRes.value.json();
        if (Array.isArray(data)) suggestions.push(...data.map(item => item.phrase));
      }

      const unique = [...new Set(suggestions)].slice(0, 6);
      const items = unique.map(title => ({
        title,
        image: `https://tse2.mm.bing.net/th?q=${encodeURIComponent(title)}&w=400&h=400&c=7&rs=1&p=0`,
        searchUrl: `https://www.akakce.com/arama/?q=${encodeURIComponent(title)}`
      }));
      return res.status(200).json({ ok: true, items });
    }

    // 2. ÜRÜN LİNKİNDEN BİLGİ ÇEKME (?url=...)
    if (url) {
      let targetUrl = new URL(url).toString();
      const asinMatch = targetUrl.match(/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
      if (targetUrl.includes('amazon.') && asinMatch) {
        targetUrl = `https://${new URL(targetUrl).host}/dp/${asinMatch[1]}`;
      }

      const isBlockedText = (txt) => {
        if (!txt) return true;
        const low = txt.toLowerCase();
        return ['üzgünüz', 'güvenlik', 'robot', 'captcha', 'access denied', 'just a moment', 'amazon.com.tr', 'hepsiburada', 'trendyol'].some(k => low === k || low.includes(k));
      };

      let title = '', image = '', price = '', resolvedUrl = targetUrl;

      try {
        const mlRes = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(targetUrl)}`);
        if (mlRes.ok) {
          const mlJson = await mlRes.json();
          if (mlJson.status === 'success' && mlJson.data) {
            const d = mlJson.data;
            if (d.url) resolvedUrl = d.url;
            if (d.title && !isBlockedText(d.title)) title = d.title;
            if (d.image?.url) image = d.image.url;
            if (d.description) {
              const descPrice = d.description.match(/([\d.]+(?:,\d{2})?)\s*(?:TL|₺)/i);
              if (descPrice) price = descPrice[1];
            }
          }
        }
      } catch (_) {}

      if (!title || isBlockedText(title) || !price) {
        try {
          const jinaRes = await fetch(`https://r.jina.ai/${resolvedUrl}`, { headers: { 'Accept': 'text/plain' } });
          if (jinaRes.ok) {
            const md = await jinaRes.text();
            const titleLine = md.match(/^Title:\s*(.+)$/m);
            if (titleLine && !isBlockedText(titleLine[1].trim()) && (!title || isBlockedText(title))) {
              title = titleLine[1].trim();
            }
            if (!price && !isBlockedText(md.slice(0, 500))) {
              const mdPrice = md.match(/([\d.]{2,}(?:,\d{2})?)\s*(?:TL|₺)/i);
              if (mdPrice) price = mdPrice[1];
            }
            if (!image) {
              const imgMatch = md.match(/!\[[^\]]*\]\((https:\/\/[^)]+\.(?:jpg|jpeg|png|webp)[^)]*)\)/i);
              if (imgMatch && !imgMatch[1].includes('logo') && !imgMatch[1].includes('icon')) image = imgMatch[1];
            }
          }
        } catch (_) {}
      }

      if (!title || isBlockedText(title)) {
        try {
          const parsedUrl = new URL(resolvedUrl);
          const hbSlug = parsedUrl.pathname.match(/^\/([a-z0-9-]+?)-(?:p|pm)-[a-z0-9]+/i);
          const tySlug = parsedUrl.pathname.match(/\/([a-z0-9-]+?)-p-\d+/i);
          const slug = (hbSlug && hbSlug[1]) || (tySlug && tySlug[1]);
          if (slug) title = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        } catch (_) {}
      }

      title = title
        .replace(/^Amazon\.com\.tr\s*:\s*/i, '')
        .replace(/\s*[-|•:]\s*(Trendyol|Hepsiburada(?:\.com)?|Amazon\.com\.tr|n11|Akakçe|Çiçeksepeti|Fiyatı, Yorumları).*$/i, '')
        .trim();

      if (title && !isBlockedText(title) && !image) {
        image = `https://tse2.mm.bing.net/th?q=${encodeURIComponent(title)}&w=400&h=400&c=7&rs=1&p=0`;
      }

      let numericPrice = 0;
      if (price) {
        const cleaned = String(price).replace(/[^\d.,]/g, '').replace(/[.,]$/, '');
        if (cleaned.includes(',') && cleaned.includes('.')) numericPrice = parseFloat(cleaned.replace(/\./g, '').replace(',', '.'));
        else if (cleaned.includes(',')) numericPrice = parseFloat(cleaned.replace(',', '.'));
        else numericPrice = parseFloat(cleaned);
      }

      if (!title || isBlockedText(title)) {
        return res.status(200).json({ ok: false, error: 'Link okunamadı, ürün adını yazarak arayabilirsin.' });
      }
      return res.status(200).json({ ok: true, title, image, price: isNaN(numericPrice) ? 0 : Math.round(numericPrice) });
    }

    // 3. SUPABASE TÜM VERİLERİ ÇEKME (?action=bootstrap)
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({ ok: false, error: 'Supabase ortam değişkenleri eksik.' });
    }

    const incomingPin = (req.headers['x-sync-pin'] || '').trim();
    if (SYNC_PIN && incomingPin !== SYNC_PIN) {
      return res.status(401).json({ ok: false, error: 'Hatalı PIN.' });
    }

    if (req.method === 'GET' && action === 'bootstrap') {
      const [todayRes, planRes, canvasRes, wishRes] = await Promise.all([
        sbFetch('ceyda_today_tasks?select=*&order=position.asc'),
        sbFetch('ceyda_planned_tasks?select=*&order=plan_date.asc,start_time.asc'),
        sbFetch('ceyda_canvas_state?id=eq.main&select=*'),
        sbFetch('ceyda_wishlist_items?select=*&order=created_at.desc')
      ]);

      return res.status(200).json({
        ok: true,
        today: todayRes.ok ? todayRes.data : [],
        planned: planRes.ok ? planRes.data : [],
        canvas: (canvasRes.ok && canvasRes.data?.[0]?.strokes) ? canvasRes.data[0].strokes : [],
        wishlist: wishRes.ok ? wishRes.data : []
      });
    }

    // 4. SUPABASE VERİ KAYDETME / SİLME (POST)
    if (req.method === 'POST') {
      const body = await parseBody(req);
      const { entity, op, payload, id } = body;

      const tableMap = {
        today: 'ceyda_today_tasks',
        planned: 'ceyda_planned_tasks',
        canvas: 'ceyda_canvas_state',
        wishlist: 'ceyda_wishlist_items'
      };
      const table = tableMap[entity];
      if (!table) return res.status(400).json({ ok: false, error: 'Geçersiz tablo.' });

      if (op === 'upsert') {
        const rows = Array.isArray(payload) ? payload : [payload];
        const result = await sbFetch(`${table}?on_conflict=id`, {
          method: 'POST',
          headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify(rows)
        });
        if (!result.ok) return res.status(500).json({ ok: false, error: JSON.stringify(result.data) });
        return res.status(200).json({ ok: true, data: result.data });
      }

      if (op === 'delete' && id) {
        const result = await sbFetch(`${table}?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!result.ok) return res.status(500).json({ ok: false, error: JSON.stringify(result.data) });
        return res.status(200).json({ ok: true });
      }

      if (op === 'clear_all') {
        const result = await sbFetch(`${table}?id=neq.__none__`, { method: 'DELETE' });
        if (!result.ok) return res.status(500).json({ ok: false, error: JSON.stringify(result.data) });
        return res.status(200).json({ ok: true });
      }
    }

    return res.status(400).json({ ok: false, error: 'Geçersiz istek.' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
};
