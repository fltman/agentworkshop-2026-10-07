const connection = document.getElementById('connection');
const questions = document.getElementById('questions');
const completed = document.getElementById('completed');
const cancelled = document.getElementById('cancelled');
const errors = document.getElementById('errors');
const capabilities = document.getElementById('capabilities');
const requesterFilter = document.getElementById('requester-filter');
const stageFilter = document.getElementById('stage-filter');
let lastState = '';
let latestState;
const expanded = new Set();
const requesterKey = name => name.normalize('NFC').toLowerCase();

function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function source(id) {
  const link = element('a', `Källinlägg ${id}`);
  link.href = `/api/messages?channel=bygge&since=${id - 1}&limit=500`;
  link.target = '_blank';
  link.rel = 'noopener';
  return link;
}

function duration(seconds) {
  return seconds < 60 ? `${seconds} sek` : `${Math.floor(seconds / 60)} min ${seconds % 60} sek`;
}

function render(state) {
  const selected = requesterFilter.value || '';
  const names = new Map(state.kö.map(item => [requesterKey(item.frågare), item.frågare]));
  const entries = [...names].sort((a, b) => a[1].localeCompare(b[1], 'sv'));
  const options = [['', 'Alla frågare'], ...entries].map(([key, name]) => {
    const option = element('option', name);
    option.value = key;
    return option;
  });
  requesterFilter.replaceChildren(...options);
  requesterFilter.value = names.has(selected) ? selected : '';
  const filtered = state.kö.filter(item =>
    (!requesterFilter.value || requesterKey(item.frågare) === requesterFilter.value) &&
    (!stageFilter.value || (stageFilter.value === 'utan-framsteg' ? item.uppmärksamhet : item.steg === stageFilter.value)));
  document.getElementById('queue-heading').textContent = `Aktiva frågor (${filtered.length} av ${state.kö.length})`;
  const stats = state.statistik;
  document.getElementById('statistics').textContent =
    `${stats.aktiva} aktiva · ${stats.väntande} väntande · ${stats.påbörjade} påbörjade · ` +
    `${stats.granskning} i granskning · ${stats.frågare} frågare · äldsta väntetid ${duration(stats.äldsta_väntetid_sek)} · ` +
    `${stats.utan_framsteg} utan framsteg i minst ${duration(stats.utan_framsteg_gräns_sek)}`;
  document.getElementById('coordination').textContent = stats.senaste_reservation
    ? 'Rösten har använt reservation. Det bevisar inte att alla svar följer Kön: Rösten måste respektera avslag och förnya före publicering.'
    : 'Rösten har ännu inte reserverat någon fråga. Köns ordning är därför fortfarande vägledande.';
  const cards = filtered.map(item => {
    const card = element('details', '', item.uppmärksamhet ? 'stalled' : '');
    card.open = expanded.has(item.id);
    card.addEventListener('toggle', () => {
      if (card.open) expanded.add(item.id);
      else expanded.delete(item.id);
    });
    const time = new Date(item.ts).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
    const warning = item.uppmärksamhet ? 'Länge utan framsteg · ' : '';
    card.append(element('summary', `${warning}#${item.köplats} · ${item.frågare} · ${item.steg} · ${duration(item.väntetid_sek)} · ${item.fråga}`));
    card.append(element('p', `Prioritet ${item.prioritet} · ${time} · Händelse ${item.id}`, 'meta'));
    card.append(element('strong', item.fråga));
    card.append(element('p', item.turförklaring));
    card.append(element('p', item.prioritetsförklaring));
    const observation = item.senaste_observation;
    if (observation) {
      const observedTime = observation.ts === null ? 'tid okänd' : new Date(observation.ts).toLocaleTimeString('sv-SE');
      const observedId = observation.id === null ? 'lokal reservation' : `händelse ${observation.id}`;
      card.append(element('p', `Senast observerat: ${observation.typ} · ${observedId} · ${observedTime}` +
        (observation.kvarter ? ` · @${observation.kvarter}` : ''), 'meta'));
    } else {
      card.append(element('p', 'Senaste observationens detaljer saknas i den äldre historiken.', 'meta'));
    }
    card.append(element('p', item.utan_framsteg_sek === null
      ? 'Tid för senaste framsteget saknas; ingen säker varningsbedömning kan göras.'
      : `${duration(item.utan_framsteg_sek)} sedan senaste framsteg.`, 'meta'));
    card.append(element('p', item.nästa_steg));
    if (item.uppmärksamhet) {
      card.append(element('p', 'Markeringen beskriver uteblivna observerade framsteg, inte ett bekräftat fel. Ingen automatisk omstart görs.', 'warning'));
    }
    for (const proposal of item.mottagare) {
      card.append(element('p', `@${proposal.team} · ${proposal.förmåga}`));
      card.append(element('p', proposal.motivering));
      card.append(source(proposal.källinlägg));
    }
    card.append(element('p', item.motivering));
    card.append(element('p', item.prioritetshändelse
      ? `Prioritering skickad i händelse ${item.prioritetshändelse}.`
      : 'Prioriteringen har inte skickats på bussen; se felmeddelandena nedan.', 'meta'));
    if (!item.mottagare.length) card.append(element('p', 'Ingen matchande förmågeanmälan hittades; frågan är kvar i kön.'));
    if (item.utskick.fel) {
      const retry = item.utskick.nästa_försök === null ? 'Inga fler automatiska återförsök.'
        : `Nästa försök om ${duration(Math.max(0, Math.ceil((item.utskick.nästa_försök - Date.now()) / 1000)))}.`;
      card.append(element('p', `${item.utskick.fel} Försök ${item.utskick.försök} av 4. ${retry}`, 'error'));
    }
    if (item.reservation) {
      card.append(element('p', `Reserverad av ${item.reservation.team} till ${new Date(item.reservation.till).toLocaleTimeString('sv-SE')}.`));
    } else if (item.steg === 'väntar') {
      card.append(element('p', `Återkalla på Torget som ${item.frågare}: @fralle återkalla ${item.id}`, 'meta'));
    }
    return card;
  });
  const activeIds = new Set(state.kö.map(item => item.id));
  for (const id of expanded) if (!activeIds.has(id)) expanded.delete(id);
  questions.replaceChildren(...(cards.length ? cards : [element('p', state.kö.length
    ? 'Inga frågor matchar filtret.' : 'Kön är tom. Väntar på fråga.ny från Örat.')]));
  completed.replaceChildren(...state.besvarade.map(item => element('li', `${item.frågare} · ${item.fråga}`)));
  cancelled.replaceChildren(...state.återkallade.map(item => element('li', `${item.frågare} · ${item.fråga}`)));
  errors.replaceChildren(...state.fel.slice(0, 5).map(item =>
    element('p', `Händelse ${item.orsak}: ${item.error}`, 'error')));
  const roles = state.förmågor.map(item => {
    const row = element('li', `${item.förmåga}: @${item.team} · `);
    row.append(source(item.källinlägg));
    return row;
  });
  capabilities.replaceChildren(...(roles.length ? roles : [element('li', 'Inga förmågeanmälningar har hittats ännu.')]));
}

async function refresh() {
  try {
    const response = await fetch('/t/fralle/status', { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const state = await response.json();
    const serialized = JSON.stringify(state);
    if (serialized !== lastState) {
      render(state);
      lastState = serialized;
    }
    latestState = state;
    connection.textContent = 'Ansluten · uppdateras var femte sekund';
    connection.className = '';
  } catch (error) {
    connection.textContent = `Kunde inte hämta status: ${error.message}. Kön nedan är senast hämtade data.`;
    connection.className = 'error';
  } finally {
    setTimeout(refresh, 5000);
  }
}

requesterFilter.addEventListener('change', () => { if (latestState) render(latestState); });
stageFilter.addEventListener('change', () => { if (latestState) render(latestState); });
refresh();
