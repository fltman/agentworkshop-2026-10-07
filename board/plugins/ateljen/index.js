// Ateljén (ledningen): visar bilderna som workshopledarens dator målar åt Kollegans förmågor.
//   GET /t/ateljen/lista                     → alla bilder: [{ kvarter, namn, prompt, url, typ, av, ts }]
//   GET /t/ateljen/bild/<kvarter>/<namn>.jpg → själva bilden
//
// Här finns ingen nyckel och ingen bildgenerering: bilderna målas på ledarens dator och läggs i
// pluginets datakatalog (som överlever deploy). Beställ med "@ateljen <motiv>" på Torget, eller
// händelsen bild.beställning {namn, prompt} på bussen. Svaret kommer som bild.klar med url.
const fs = require('fs');
const path = require('path');

const NAMN = /^[a-zåäö0-9-]{1,40}$/;

module.exports = {
  async handle(req, res, { path: p, dataDir }) {
    if (req.method !== 'GET') return false;
    if (p === '/lista') {
      let lista = [];
      try { lista = JSON.parse(fs.readFileSync(path.join(dataDir, 'manifest.json'), 'utf8')); } catch {}
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(JSON.stringify(lista));
      return true;
    }
    const m = p.match(/^\/bild\/([^/]+)\/([^/]+)\.jpg$/);
    if (m && NAMN.test(m[1]) && NAMN.test(m[2])) {
      const fil = path.join(dataDir, 'bilder', m[1], m[2] + '.jpg');
      if (!fs.existsSync(fil)) return false;
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-cache' });
      fs.createReadStream(fil).pipe(res);
      return true;
    }
    return false;
  },
};
