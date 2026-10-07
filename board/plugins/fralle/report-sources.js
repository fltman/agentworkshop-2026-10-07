const PROVIDERS = [
  { team: 'fralle', capability: 'Kön', legacy: null },
  { team: 'surret', capability: 'Örat', legacy: '/fragor' },
  { team: 'mikael', capability: 'Rösten', legacy: '/status' },
  { team: 'heimlen', capability: 'Granskaren', legacy: '/metrics' },
  { team: 'team-martin', capability: 'Pulsen', legacy: '/puls' },
  { team: 'holminator', capability: 'Minnet', legacy: '/tidslinje' },
  { team: 'marcuslind', capability: 'Mötet', legacy: '/sammanfattningar' },
  { team: 'tomhol', capability: 'Stämningen', legacy: '/status' },
  { team: 'leif', capability: 'Översättaren', legacy: '/status' },
  { team: 'farzad', capability: 'Nyfikenheten', legacy: '/state' },
  { team: 'babtist', capability: 'Lotsen/Kursen', legacy: '/forslag' },
];

const metric = (key, label, value, unit = 'count', scope = 'period', sample_size) => ({
  key, label, value: Number.isFinite(value) ? value : null, unit, scope,
  ...(sample_size === undefined ? {} : { sample_size }),
});
const inPeriod = (ts, period) => Number.isFinite(ts) && ts >= period.from && ts < period.to;
function mean(values) {
  if (!values.length) return null;
  const value = values.reduce((sum, item) => sum + item / values.length, 0);
  if (!Number.isFinite(value)) throw new Error('Medelvärdet överskrider ett ändligt tal.');
  return value;
}
const record = (question_id, received_at, answered_at = null, cancelled_at = null) => ({
  question_id, received_at, answered_at, cancelled_at,
  audience: 'unknown', useful: null, saved_minutes: null,
});

function envelope(provider, period, metrics, note, records, generated_at = null) {
  return {
    schema_version: 1, team: provider.team, capability: provider.capability, generated_at, period,
    coverage: { from: null, to: null, complete: false, note },
    metrics, ...(records === undefined ? {} : { records }),
  };
}

function queueReport(data, period, now = Date.now()) {
  const retained = [...data.kö, ...data.besvarade, ...data.återkallade];
  const questions = retained.filter(item => inPeriod(item.ts, period));
  const records = retained.filter(item => inPeriod(item.ts, period) ||
    inPeriod(item.besvarad_ts, period) || inPeriod(item.återkallad_ts, period));
  return envelope(PROVIDERS[0], period, [
    metric('queue_active', 'Öppna i Kön, inklusive parkerade', data.statistik.aktiva, 'count', 'snapshot'),
    metric('queue_parked', 'Parkerade utan köplats', data.statistik.parkerade, 'count', 'snapshot'),
    metric('queue_waiting', 'Väntande i Kön', data.statistik.väntande, 'count', 'snapshot'),
    metric('queue_started', 'Påbörjade i Kön', data.statistik.påbörjade, 'count', 'snapshot'),
    metric('queue_reviewing', 'Väntar på granskning eller granskat', data.statistik.granskning, 'count', 'snapshot'),
    metric('queue_stalled', 'Utan framsteg i minst fem minuter', data.statistik.utan_framsteg, 'count', 'snapshot'),
    metric('queue_oldest_wait', 'Äldsta aktiva frågans väntetid', data.statistik.äldsta_väntetid_sek, 's', 'snapshot'),
    metric('queue_questions_observed', 'Frågor i periodens bevarade urval', questions.length),
    metric('queue_answers_observed', 'Daterade svar i periodens bevarade urval',
      data.besvarade.filter(item => inPeriod(item.besvarad_ts, period)).length),
    metric('queue_cancellations_observed', 'Återkallningar i periodens bevarade urval',
      data.återkallade.filter(item => inPeriod(item.återkallad_ts, period)).length),
    metric('queue_retries_pending', 'Schemalagda återförsök', data.kö.filter(item => item.utskick.nästa_försök !== null).length, 'count', 'snapshot'),
  ], 'Kön behåller aktiva frågor och högst 20 besvarade samt 20 återkallade. Detta är inte hela periodens inflöde; avvisade frågor ingår inte.',
  records.map(item => record(item.id, item.ts, item.besvarad_ts ?? null, item.återkallad_ts ?? null)), now);
}

function adaptLegacy(provider, body, period) {
  const metrics = [];
  let records;
  let note = 'Äldre API utan gemensamt tids-/täckningskontrakt. Värdena gäller ett begränsat urval eller nuläge, inte säkra periodtotaler.';
  const expectArray = (value, field) => {
    if (!Array.isArray(value)) throw new Error(`Äldre API saknar listan ${field}.`);
    return value;
  };
  const during = (value, field) => {
    const items = expectArray(value, field);
    if (items.some(item => !item || !Number.isSafeInteger(item.ts) || item.ts < 0)) {
      throw new Error(`Äldre API har poster utan giltig tidsstämpel i ${field}.`);
    }
    return items.filter(item => inPeriod(item.ts, period));
  };
  switch (provider.team) {
    case 'surret': {
      const questions = during(body, 'frågor');
      metrics.push(metric('heard_questions_observed', 'Hörda poster i urvalet', questions.length));
      const linked = body.filter(item => Number.isSafeInteger(item.händelse) && item.händelse > 0);
      records = linked.map(item => {
        const root = Array.isArray(item.kedja) ? item.kedja.find(event => event.id === item.händelse &&
          event.typ === 'fråga.ny' && Number.isSafeInteger(event.ts) && event.ts >= 0) : null;
        const received = root?.ts ?? null;
        const answers = Array.isArray(item.kedja) ? item.kedja
          .filter(event => event.typ === 'svar.klart' && Number.isSafeInteger(event.ts) &&
            event.ts >= 0 && (received === null || event.ts >= received))
          .map(event => event.ts) : [];
        return record(item.händelse, received, answers.length ? Math.min(...answers) : null);
      });
      note += ` Örat visar högst 25 poster. ${body.length - linked.length} poster saknar rot-id; ` +
        `${records.filter(item => item.received_at === null).length} saknar rotens tidsstämpel. Inläggets tid används inte som frågerotens tid.`;
      break;
    }
    case 'mikael': {
      const answers = during(body?.historik, 'historik');
      const strengths = answers.map(item => item.styrka).filter(Number.isFinite);
      metrics.push(metric('voice_answers_observed', 'Svar i Röstens urval (utan rot-id)', answers.length));
      metrics.push(metric('voice_strength_mean', 'Medelstyrka i urvalet', mean(strengths), 'score', 'period', strengths.length));
      note += ' Rösten behåller 30 svar i processminne; de saknar rot-id och adderas inte till gemensamma frågetotaler.';
      break;
    }
    case 'heimlen': {
      const reviews = during(body?.granskningar, 'granskningar');
      const decisions = reviews.filter(item => typeof item.godkänt === 'boolean');
      metrics.push(metric('reviews_observed', 'Granskningar i urvalet', reviews.length));
      metrics.push(metric('reviews_approved', 'Godkända i urvalet',
        decisions.length === reviews.length ? decisions.filter(item => item.godkänt).length : null));
      metrics.push(metric('review_approval_percent', 'Godkänd andel bland kända beslut',
        decisions.length ? decisions.filter(item => item.godkänt).length / decisions.length * 100 : null,
        'percent', 'period', decisions.length));
      metrics.push(metric('review_latency_mean', 'Granskarens medellatens, bevarat processurval',
        body.metrics?.snittLatensMs, 'ms', 'retained'));
      note += ' Högst 50 granskningar behålls. Latensmedlet gäller ett separat, omstartsberoende urval och används inte som global median.';
      break;
    }
    case 'team-martin': {
      if (!body?.nu || typeof body.nu !== 'object') throw new Error('Pulsen saknar nulägesdata.');
      metrics.push(metric('pulse_messages_per_minute', 'Inlägg per minut, femminutersfönster', body.nu.mpm, 'per_minute', 'snapshot'));
      metrics.push(metric('pulse_pressure', 'Kötryck enligt Pulsen', body.nu.tryck, 'score', 'snapshot'));
      metrics.push(metric('pulse_tempo', 'Tempo enligt Pulsen', body.nu.tempo, 'score', 'snapshot'));
      metrics.push(metric('pulse_unanswered_sample', 'Äldre obesvarade i Pulsens begränsade urval',
        expectArray(body.obesvarade, 'obesvarade').length, 'count', 'snapshot'));
      note += ' Tempo gäller fem minuter; obesvarade är högst åtta poster, 90 sekunder–20 minuter gamla. Det är inte Köns fulla väntelista.';
      break;
    }
    case 'holminator': {
      const events = during(body?.senaste, 'senaste');
      metrics.push(metric('memory_events_observed', 'Busshändelser i Minnets tidslinjeurval', events.length));
      metrics.push(metric('memory_hits_observed', 'minne.träff i tidslinjeurvalet', events.filter(item => item.typ === 'minne.träff').length));
      note += ' Endast tidslinjens senaste händelser räknas; inte fulla minnesträfftotaler.';
      break;
    }
    case 'marcuslind': {
      const summaries = during(body, 'sammanfattningar');
      metrics.push(metric('meeting_summaries_observed', 'Sammanfattningar i bevarat urval', summaries.length));
      note += ' Mötet sparar högst 30 sammanfattningar. Deras tidsstämplar används utan att anta tid för ett färdigt svar.';
      break;
    }
    case 'tomhol': {
      const channels = expectArray(body?.kanaler, 'kanaler');
      for (const [index, channel] of channels.slice(0, 20).entries()) {
        for (const [key, label] of [['fragor', 'frågesignaler'], ['hinder', 'hindersignaler'],
          ['uppskattning', 'uttrycklig uppskattning'], ['omtanke', 'uttrycklig omtanke']]) {
          metrics.push(metric(`mood_${index}_${key}`, `#${channel.kanal}: ${label}`, channel.signaler?.[key], 'count', 'snapshot'));
        }
      }
      note += ' Senaste kanalfönster: tio minuter, högst 20 inlägg per kanal; högst 20 kanaler visas här. Signaler är textregler, inte känslor eller nyttobetyg.';
      break;
    }
    case 'leif': {
      if (!body?.counts || typeof body.counts !== 'object') throw new Error('Översättaren saknar språkstatistik.');
      metrics.push(metric('translations_sv', 'Översättningar till svenska, sparad livstid', body.counts.sv, 'count', 'lifetime'));
      metrics.push(metric('translations_en', 'Översättningar till engelska, sparad livstid', body.counts.en, 'count', 'lifetime'));
      metrics.push(metric('translations_observed', 'Översättningar i senaste historikurvalet',
        during(body.translations, 'translations').length));
      note += ' Livstidsräknarna är inte periodvärden; översättningshistoriken visar högst tio poster.';
      break;
    }
    case 'farzad': {
      const questions = during(body?.historik, 'historik');
      metrics.push(metric('curiosity_questions_observed', 'Nyfikenhetens agentfrågor i urvalet', questions.length));
      metrics.push(metric('curiosity_answers_observed', 'Urvalets agentfrågor med svar', questions.filter(item => item.svar).length));
      metrics.push(metric('curiosity_latency_mean', 'Nyfikenhetens medelsvarstid, bevarad historik',
        body.statistik?.snittSvarstidS, 's', 'retained'));
      note += ' Högst 50 agentfrågor behålls. Trigger-/händelse-id antas inte vara Örats fråga.ny-id.';
      break;
    }
    case 'babtist': {
      metrics.push(metric('routing_suggestions_observed', 'Lotsförslag i senaste urvalet', during(body, 'förslag').length));
      note += ' Högst 20 lotsförslag från senaste 300 busshändelser. Kursens uppslag/fel saknas i detta äldre API.';
      break;
    }
    default: throw new Error('Ingen adapter för det äldre API:t.');
  }
  return envelope(provider, period, metrics, note, records);
}

module.exports = { PROVIDERS, queueReport, adaptLegacy, inPeriod };
