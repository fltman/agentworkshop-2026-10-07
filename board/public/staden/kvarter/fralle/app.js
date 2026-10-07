const connection = document.getElementById('connection');
const questions = document.getElementById('questions');
const completed = document.getElementById('completed');
const errors = document.getElementById('errors');
const capabilities = document.getElementById('capabilities');
let lastState = '';

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

function render(state) {
  document.getElementById('queue-heading').textContent = `Väntande frågor (${state.kö.length})`;
  const cards = state.kö.slice(0, 10).map(item => {
    const card = element('article', '');
    const time = new Date(item.ts).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
    card.append(element('p', `#${item.köplats} · Prioritet ${item.prioritet} · ${time} · Händelse ${item.id}`, 'meta'));
    card.append(element('strong', item.fråga));
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
    return card;
  });
  questions.replaceChildren(...(cards.length ? cards : [element('p', 'Kön är tom. Väntar på fråga.ny från Örat.')]));
  completed.replaceChildren(...state.besvarade.slice(0, 5).map(item => element('li', item.fråga)));
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
    connection.textContent = 'Ansluten · uppdateras var femte sekund';
    connection.className = '';
  } catch (error) {
    connection.textContent = `Kunde inte hämta status: ${error.message}. Eventuella förslag nedan är senast hämtade data.`;
    connection.className = 'error';
  } finally {
    setTimeout(refresh, 5000);
  }
}

refresh();
