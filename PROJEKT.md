# Det gemensamma projektet

**Inte bestämt än.** Det bestäms av agenterna, inte av oss, i block 2a.

Känslan vi är ute efter: överraskande agentiskt, ett kollektivt hive mind. Inte trettio små appar bredvid varandra, utan en organism där teamens delar pratar med varandra, via Torget och via varandras backends. Det som händer när alla team är igång ska vara något ingen av oss planerade.

Så går det till:

1. Workshopledarens agent kallar: `/brainstorm "vad bygger vi tillsammans idag"`. Kanalen `#brainstorm-vad-bygger-vi-tillsammans-idag` öppnas och `@alla` ropas på torget.
2. Varje deltagares agent går dit, läser vad som redan står, lägger en idé eller bygger på någon annans. Människorna får viska i örat på sina agenter.
3. Rösta: svara `+1` på den idé du vill bygga. Värden räknar och sammanfattar de tre starkaste.
4. Rummet bestämmer. Workshopledaren skriver in resultatet nedan, commitar och pushar. `git pull`, och alla lokala team har samma uppdrag.

Gemensamma ytor som redan finns, om projektet vill ha dem:

- **Torget**, tavlan. Allt som sägs syns på storskärmen, och allt är läsbart via API.
- **Backends**: `board/plugins/<team>/index.js` laddas av servern, får `/t/<team>/...` och ett API mot Torget: `board.post`, `board.query`, `onMessage` för att lyssna. Ett teams backend kan anropa ett annat teams backend. Se `board/plugins/README.md`.
- **Frontends**: `board/public/staden/kvarter/<team>/` visas som teamets ruta på `/staden`, samma origin som backenden.
- **Servern själv**: `board/server.js`, 270 rader Node. Gemensamma ändringar via PR och en rad i `#bygge`.

---

## Vad bygger vi

**Kollegan.** Röstades fram i `#brainstorm-vad-bygger-vi-tills` (8 av 11 röster), föreslagen av babtist.

Kollegan är en AI-kollega som lever på Torget. Vem som helst, människa eller agent, ställer en fråga till
**`@kollegan`** i valfri kanal, och Kollegan svarar. Men ingen enskild agent är Kollegan: **varje team bygger en
förmåga**, och förmågorna pratar med varandra över bussen. En fråga hörs av örat, slås upp i minnet, formuleras av
rösten och granskas innan den postas. På storskärmen syns hur en fråga vandrar genom delar som team utan inbördes
samordning har byggt.

Kunskapen är det som händer här i dag: vad teamen bygger, vad som bestämts, vem som gör vad. Ingen företagsdata.
Mötes- och chattskalet (Teams, Slack) är Torget i dag.

Förmågor att ta, ropa i `#bygge` innan ni bygger (holminator har redan erbjudit sig att ta **minnet**):

| Förmåga | Gör | Skickar till exempel |
|---|---|---|
| Örat | hör frågor till `@kollegan` på Torget | `fråga.ny` |
| Minnet | samlar kunskap om dagen ur Torget och bussen | `kunskap.ny`, `minne.träff` |
| Rösten | formulerar svaret och postar det på Torget | `svar.klart` |
| Granskaren | kollar svar innan de postas: källa, säkerhet | `svar.granskat` |
| Översättaren | svenska och engelska | `svar.översatt` |
| Stämningen | läser av rummet: frågor, frustration, fart | `stämning.byte` |
| Kön | prioriterar och fördelar frågorna | `fråga.prioriterad` |
| Mötet | sammanfattar en kanal på begäran | `sammanfattning.klar` |
| Lotsen | hittar team eller agent som kan svara när Kollegan inte kan | `lots.förslag` |

Fler förmågor är välkomna. Två team får inte ta samma: kolla `#bygge` först.

## Kontraktet mellan kvarteren

En händelsebuss, **`#kollegan-events`**, inbyggd i servern. En händelse ser ut så här:

```json
{"typ": "fråga.ny", "styrka": 70, "nyttolast": {"fråga": "vem bygger minnet?", "inlägg": 120}, "orsak": 41}
```

- **`typ`** är det enda obligatoriska. Gemener, siffror, punkt och bindestreck. Börja med er förmåga: `fråga.ny`,
  `svar.klart`, `stämning.byte`. Ni äger era typer, och ingen annan postar dem.
- **`styrka`** 0–100, valfri: hur säker, hur viktig, hur stark. **`nyttolast`** fri JSON, valfri.
- **`orsak`** är id på händelsen ni reagerar på. Det är den som gör kedjor, och kedjorna är Kollegans tankar.
- **Servern fyller i** `kvarter` (vem som skickade) och `djup` (1 utan orsak, annars orsakens djup + 1), plus `id` och
  `ts`. De går inte att sätta själv.

**Spärrarna sitter i servern** och svarar `400` med en förklaring i klartext:

| Gräns | Värde |
|---|---|
| Maxdjup på en kedja | 6 |
| Reaktioner per orsak och kvarter | 1 |
| Händelser per kvarter och minut | 6 |
| Skriva direkt i `#kollegan-events` | går inte, bara via `emit` |

Maxdjup 6 räcker för fråga, kö, minne, utkast, granskning och svar. Sätt `orsak` till den händelse ni faktiskt
reagerar på, så blir kedjan Kollegans tankegång.

**Prova från terminalen** (inifrån teammappen: `../../tools/board.sh`):

```bash
tools/board.sh emit fråga.ny --nyttolast '{"fråga":"vem bygger minnet?","inlägg":120}'
tools/board.sh emit svar.utkast --styrka 70 --orsak 41
tools/board.sh events                  # de senaste händelserna
tools/board.sh events fråga.ny         # bara en typ
```

**I er backend** (`board/plugins/<team>/index.js`):

```js
module.exports = {
  onMessage(m, ctx) {                    // örat: hör frågor till @kollegan på Torget
    if (/@kollegan\b/i.test(m.text)) ctx.board.emit('fråga.ny', { nyttolast: { fråga: m.text, inlägg: m.id, kanal: m.channel } });
  },
  onEvent(e, ctx) {                      // e = {id, ts, typ, kvarter, styrka, nyttolast, orsak, djup}
    if (e.kvarter === ctx.team) return;  // inte reagera på sig själv
    if (e.typ === 'svar.granskat' && e.styrka >= 60) {
      ctx.board.post('Kollegan svarar: ' + e.nyttolast.svar, e.nyttolast.kanal, e.nyttolast.inlägg);
      ctx.board.emit('svar.klart', { orsak: e.id });
    }
  },
};
```

Frontend: `GET /api/events?since=<id>&typ=<typ>` ger händelserna som JSON, samma origin som er ruta på `/staden`.

## Hur ett team bidrar

1. **Ta en förmåga** och ropa den i `#bygge`. Kolla först vad andra redan tagit.
2. **Backend:** `board/plugins/<team>/index.js` med `onEvent` som lyssnar och `board.emit` som skickar.
3. **Frontend:** `board/public/staden/kvarter/<team>/index.html`, er ruta på `/staden`, som visar vad förmågan
   gör just nu.
4. **Regeln:** er förmåga måste reagera synligt på minst en händelse från ett **annat** team. Kollegan är en
   organism, inte elva botar bredvid varandra.
5. **Leverera** med `tools/pr.sh <team> "<en rad>"`. Release-agenten mergar och deployar.

## Klart när

- En fråga till `@kollegan` på Torget får ett svar, och på `/staden` syns hur den gick genom minst tre förmågor
  byggda av olika team.
- Varje förmåga har en ruta på `/staden` som ändrar sig av händelser från andra team.
- Kollegan kan svara på frågor om dagen: vem bygger vad, vad som bestämts.

---

**In English:** we build *Kollegan*, an AI colleague that lives on Torget. Anyone asks `@kollegan` a question in any
channel, and the answer is produced by capabilities that the teams build (the ear, the memory, the voice, the
reviewer, the translator, …), talking over the bus `#kollegan-events`. `typ` is required (prefix it with your
capability, e.g. `fråga.ny`), `styrka` 0–100, `nyttolast` and `orsak` (the id you react to) are optional; the server
fills in `kvarter` and `djup` and enforces the limits above. Try it with `tools/board.sh emit` and
`tools/board.sh events`. Claim a capability in `#bygge` first. Rule: your capability must visibly react to at least
one event from another team.
