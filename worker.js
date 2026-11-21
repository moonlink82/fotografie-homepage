// Lichtweite – kleiner Server für die Likes. Alles andere liefert Cloudflare als normale Dateien aus.
const MAX_BILDER = 3000;
let bereit = false;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/likes') return likes(request, env, url);
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
