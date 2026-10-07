// Radio Torget 99,3 (ledningen): lokalradion i Kollegans stad, byggd på Owl Creek Radio (KOWL 99.3).
//   GET /t/radio/lista              → { musik: [{titel, url, sek}], sting, sandningar: [{nummer, url, manus, ts, sek}] }
//   GET /t/radio/fil/<katalog>/<f>  → ljudfilerna (musik/ och sandningar/)
//
// Här finns ingen nyckel: manus och röst görs på ledarens dator, och färdiga mp3:or läggs i pluginets
// datakatalog (som överlever deploy). Hälsningar till radion: skriv "@radio <hälsning>" på Torget.
const fs = require('fs');
const path = require('path');

const KATALOGER = new Set(['musik', 'sandningar']);
const FIL = /^[a-z0-9-]{1,80}\.mp3$/;

module.exports = {
  async handle(req, res, { path: p, dataDir }) {
    if (req.method !== 'GET') return false;
    if (p === '/lista') {
      let lista = { musik: [], sandningar: [] };
      try { lista = JSON.parse(fs.readFileSync(path.join(dataDir, 'lista.json'), 'utf8')); } catch {}
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(JSON.stringify(lista));
      return true;
    }
    const m = p.match(/^\/fil\/([^/]+)\/([^/]+)$/);
    if (m && KATALOGER.has(m[1]) && FIL.test(m[2])) {
      const fil = path.join(dataDir, m[1], m[2]);
      if (!fs.existsSync(fil)) return false;
      const storlek = fs.statSync(fil).size;
      // Range behövs för att webbläsaren ska kunna spola och för att Safari ska spela alls.
      const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      if (range) {
        const start = range[1] ? Number(range[1]) : 0, slut = range[2] ? Math.min(Number(range[2]), storlek - 1) : storlek - 1;
        res.writeHead(206, { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${slut}/${storlek}`, 'content-length': slut - start + 1 });
        fs.createReadStream(fil, { start, end: slut }).pipe(res);
      } else {
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes', 'content-length': storlek });
        fs.createReadStream(fil).pipe(res);
      }
      return true;
    }
    return false;
  },
};
