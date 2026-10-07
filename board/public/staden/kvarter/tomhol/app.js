const channels = document.getElementById('channels');
const connection = document.getElementById('connection');
const error = document.getElementById('error');

function line(parent, text, tag = 'p') {
  const element = document.createElement(tag);
  element.textContent = text;
  parent.append(element);
}

async function refresh() {
  try {
    const response = await fetch('/t/tomhol/status', { signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.kanaler)) throw new Error('Ogiltigt statussvar');
    channels.replaceChildren();
    connection.textContent = data.kanaler.length ? 'Ansluten. Senast hämtat ' + new Date().toLocaleTimeString('sv-SE') :
      'Väntar på puls.tempo eller puls.tryck från team-martin.';
    error.textContent = data.fel || '';
    for (const channel of data.kanaler) {
      const article = document.createElement('article');
      line(article, '#' + channel.kanal, 'h2');
      line(article, `${channel.antalInlagg === 0 ? '⏳ ' : Object.values(channel.signaler).every(n => n === 0) ? '⚪ ' : ''}${channel.status}`);
      line(article, `❓ Frågor: ${channel.signaler.fragor} · 🚧 Hinder: ${channel.signaler.hinder} · 🙌 Uppskattning: ${channel.signaler.uppskattning} · ❤️ Uttryckt omtanke: ${channel.signaler.omtanke ?? 'ej tillgängligt'}`);
      line(article, `${channel.antalInlagg} inlägg, högst 20 inom 10 minuter. Kategorier kan överlappa.`);
      line(article, `Fönster: ${new Date(channel.fonster.fran).toLocaleTimeString('sv-SE')}–${new Date(channel.fonster.till).toLocaleTimeString('sv-SE')}`);
      const age = Math.max(0, Math.floor((Date.now() - channel.uppdaterad) / 1000));
      line(article, `Bedömningens ålder: ${age} s${age > 600 ? ' – ⏳ inaktuell, inväntar ny Puls' : ''}`);
      line(article, `Utlöst av ${channel.utlosare.typ}, händelse ${channel.utlosare.id}, djup ${channel.utlosare.djup}. Utskick: ${channel.utskick}.`);
      line(article, `Aktivitet (separat): ${channel.aktivitet.nyttolast.ord || 'ej angivet'}, styrka ${channel.aktivitet.styrka ?? 'ej angivet'}. Pulsens fönster: ${channel.aktivitet.nyttolast.fönster_min ?? 'ej angivet'} min.`);
      for (const source of channel.kallor) {
        line(article, `Inlägg ${source.inlagg}: ${source.signal} – ”${source.uttryck}”`);
      }
      for (const limitation of channel.begransningar) line(article, limitation);
      channels.append(article);
    }
  } catch (err) {
    connection.textContent = 'Anslutningsfel – tidigare bedömningar kan vara inaktuella.';
    error.textContent = 'Kunde inte hämta status: ' + err.message;
  } finally {
    setTimeout(refresh, 5000);
  }
}

refresh();
