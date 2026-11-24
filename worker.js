// Lichtweite – kleiner Server für die Likes. Alles andere liefert Cloudflare als normale Dateien aus.
const MAX_BILDER = 3000;
let bereit = false;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/likes') return likes(request, env, url);
    if (url.pathname.startsWith('/foto/')) return fotoSeite(request, env, url);
    return env.ASSETS.fetch(request);
  },
};

function antwort(daten, status = 200) {
  return new Response(JSON.stringify(daten), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function likes(request, env, url) {
  try {
    if (!bereit) {
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS likes (id TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0)').run();
      bereit = true;
    }
    if (request.method === 'GET') {
      const { results } = await env.DB.prepare('SELECT id, n FROM likes WHERE n > 0').all();
      const zahlen = {};
      for (const r of results) zahlen[r.id] = r.n;
      return antwort(zahlen);
    }
    if (request.method === 'POST') {
      const origin = request.headers.get('origin');
      if (origin && new URL(origin).host !== url.host) return antwort({ fehler: 'origin' }, 403);
      const body = await request.json().catch(() => null);
      const id = body && body.id, d = body && body.d;
      if (typeof id !== 'string' || !/^[a-z0-9]{4,16}$/.test(id) || (d !== 1 && d !== -1)) {
        return antwort({ fehler: 'ungueltig' }, 400);
      }
      if (d === 1) {
        const da = await env.DB.prepare('SELECT 1 FROM likes WHERE id = ?1').bind(id).first();
        if (!da) {
          const anzahl = await env.DB.prepare('SELECT COUNT(*) AS c FROM likes').first('c');
          if (anzahl >= MAX_BILDER) return antwort({ fehler: 'voll' }, 429);
        }
      }
      await env.DB.prepare(
        'INSERT INTO likes (id, n) VALUES (?1, MAX(0, ?2)) ON CONFLICT(id) DO UPDATE SET n = MAX(0, n + ?2)'
      ).bind(id, d).run();
      const n = await env.DB.prepare('SELECT n FROM likes WHERE id = ?1').bind(id).first('n');
      return antwort({ id, n: n || 0 });
    }
    return antwort({ fehler: 'methode' }, 405);
  } catch (e) {
    return antwort({ fehler: 'datenbank' }, 500);
  }
}

// ---------- Geteilte Bild-Links: /foto/<id> ----------
// Liefert die normale Startseite, aber mit Vorschau (Titel, Text, Bild) für WhatsApp, Facebook & Co.
function fnv(k) {
  let h = 0x811c9dc5;
  for (const c of k) { h ^= c.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return 'b' + h.toString(36);
}
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function fotoSeite(request, env, url) {
  const id = url.pathname.split('/')[2] || '';
  const start = new URL('/', url);
  try {
    const [seite, daten, einst] = await Promise.all([
      env.ASSETS.fetch(new Request(start)),
      env.ASSETS.fetch(new Request(new URL('/daten/fotos.json', url))).then((r) => r.json()),
      env.ASSETS.fetch(new Request(new URL('/daten/einstellungen.json', url))).then((r) => r.json()).catch(() => ({})),
    ]);
    const foto = (daten.fotos || []).find((f) => f && f.titel && fnv(f.bild || f.titel + '|' + f.datum) === id);
    if (!foto || !seite.ok) return Response.redirect(start.href, 302);

    const name = [einst.name, einst.zusatz].filter(Boolean).join(' ') || 'Lichtweite Fotografie';
    const titel = foto.titel + ' – ' + name;
    const text = String(foto.beschreibung || '').replace(/^#\s*/gm, '').replace(/\s+/g, ' ').trim();
    const kurz = text.length > 180 ? text.slice(0, 177).replace(/\s+\S*$/, '') + ' …' : text;
    const bild = foto.bild ? new URL(encodeURI(foto.bild.startsWith('/') ? foto.bild : '/' + foto.bild), url).href : '';
    const zusatz =
      '<base href="/">' +
      (bild ? `<meta property="og:image" content="${esc(bild)}"><meta name="twitter:image" content="${esc(bild)}">` : '') +
      '<meta name="twitter:card" content="summary_large_image">' +
      `<meta name="twitter:title" content="${esc(titel)}">`;

    const neu = new HTMLRewriter()
      .on('head', { element(e) { e.prepend(zusatz, { html: true }); } })
      .on('title', { element(e) { e.setInnerContent(titel); } })
      .on('meta[property="og:title"]', { element(e) { e.setAttribute('content', titel); } })
      .on('meta[property="og:description"]', { element(e) { if (kurz) e.setAttribute('content', kurz); } })
      .on('meta[name="description"]', { element(e) { if (kurz) e.setAttribute('content', kurz); } })
      .on('meta[property="og:url"]', { element(e) { e.setAttribute('content', url.origin + url.pathname); } })
      .on('meta[property="og:type"]', { element(e) { e.setAttribute('content', 'article'); } })
      .transform(seite);
    const h = new Headers(neu.headers);
    h.set('content-type', 'text/html; charset=utf-8');
    h.set('cache-control', 'public, max-age=300');
    return new Response(neu.body, { status: 200, headers: h });
  } catch (e) {
    return Response.redirect(start.href, 302);
  }
}
