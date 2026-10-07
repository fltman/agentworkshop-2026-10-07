# Fralle · Kön

Kön prioriterar inkommande frågor och föreslår mottagarteams för Kollegan.
Backend: `board/plugins/fralle/index.js`. Ruta:
`board/public/staden/kvarter/fralle/`. Inga npm-paket eller externa AI-anrop.

## Kontrakt

Vi lyssnar på andra teams `fråga.ny`. `nyttolast.fråga` behövs.
Vi sparar frågan och skickar **en** `fråga.prioriterad`, med `orsak` satt
till frågehändelsens id och exempelvis följande nyttolast:

```json
{
  "fråga_id": 100,
  "fråga": "Vem bygger minnet?",
  "frågare": "anna",
  "inlägg": 99,
  "kanal": "torget",
  "prioritet": 50,
  "köplats": 1,
  "mottagare": ["holminator"],
  "routning": [{
    "team": "holminator",
    "förmåga": "Minnet",
    "källinlägg": 81,
    "motivering": "Teamet har anmält Minnet i #bygge; frågans ord matchar förmågan."
  }],
  "motivering": "Normal prioritet; äldre frågor får högre prioritet med tiden."
}
```

Detta är vägledning, **inte en central spärr eller exklusiv tilldelning**.
`mottagare` är teamnamn så Lotsen kan återanvända fördelningen;
`routning` innehåller källor och motiveringar. Status-API:ts köposter
visar samma detaljer i sitt `mottagare`-fält.
Minnet och Rösten får fortsätta lyssna direkt på `fråga.ny`. Bussen äger
kedjedjupet och sina trafikgränser; Kön kringgår dem inte.

`svar.klart` avslutar en fråga genom `nyttolast.fråga_id`, orsakskedjan,
eller ett entydigt `nyttolast.inlägg`. Rösten bör skicka `fråga_id` även
när kedjan behöver starta om eller den ursprungliga frågan är äldre än
bussens senaste 500 händelser. Att avsluta en fråga skickar ingen ny händelse.

## Prioritering och matchning

Normal basprioritet är 50. Orden akut, bråttom, blockerad, urgent, blocked
eller stuck ger 80. `styrka` används inte för att blanda ihop säkerhet
med prioritet. Frågare grupperas i **en fråga per frågare och varv**:
`A1, A2, A3, B1, C1` blir `A1, B1, C1, A2, A3`.
Den som senast fått svar väntar bakom andra aktiva frågare. Turhistoriken
uppdateras först vid `svar.klart` och sparas över omstarter, så upprepade
omläsningar eller nya frågor från samma frågare inte återställer turen.
Nya frågare utan turhistorik går före dem som nyligen fått svar; sinsemellan
ordnas de efter sin äldsta väntande fråga.

**Inom varje frågares kö** ger varje hel vänteminut två extra poäng,
högst 99. Lika prioritet sorteras på äldsta tidsstämpel, sedan händelse-id.
En brådskande fråga går alltså före frågarens egna vanliga frågor, inte
före andra frågares tur.
Händelsens prioritet/köplats är en ögonblicksbild; `GET /t/fralle/status`
ger aktuell ordning. Inga timers skickar upprepade prioriteringar.

Frågarens namn kommer från Örats `nyttolast.frågare`, annars originalets
`inlägg` bland senaste 500 inläggen. Saknas båda grupperas frågan i en
gemensam ”okänd frågare”-kö. Namn jämförs skiftlägesokänsligt men å, ä och
ö bevaras. Detta är rättvis turordning efter angivna namn, inte verifierad
identitet eller skydd mot namnbyten. Den totala kapacitetsgränsen är
fortfarande gemensam för alla frågare.

Mottagare kommer från de senaste 500 inläggen i `#bygge`, där teamet
självt inleder med exempelvis ”Team fralle tar förmågan Kön” eller
”Vi tar förmågan Minnet”. Anmälan får också inleda en senare mening,
exempelvis ”Vi backar från Granskaren. Vi tar Mötet i stället.”
Senaste förmåga per team gäller; mellan två team som anmält samma
förmåga vinner den tidigaste kvarvarande anmälan.
Direkta teamomnämnanden prioriteras; annars matchas frågans ord mot
förmågan. Högst två mottagare föreslås. Okänd fråga hänvisas till
anmälda Lotsen, om den finns; annars blir mottagarlistan tom.
Detta är enkel textmatchning, inte en auktoritativ ägarförteckning.

## Lagring och fel

`queue.json` i pluginets `dataDir` sparas atomiskt och återläses vid
omstart. Äldre version 1 migreras med bibehållna frågor och frågarnamn från
de originalinlägg som finns kvar. Turhistorik behålls för frågare med
väntande eller någon av de senaste 20 besvarade frågorna.
Upp till 100 väntande frågor, 20 besvarade frågor, 500 behandlade
fråge-id:n och 20 fel sparas. Vid full kö avvisas nya frågor med en
loggrad och ett synligt fel; väntande frågor kastas inte bort.
Frågetext i utdata begränsas till 300 tecken för bussens textgräns.

Avvisade bussutskick, saknad frågetext och maxdjup visas som fel i rutan.
En sparad fråga ligger kvar även om prioriteringen inte kunde skickas.
Ingen automatisk omsändning görs. Skadad eller otillgänglig lagring ger
503 från `/status`, inte en tom, till synes fungerande kö.
Efter omstart läses också senaste bussens `svar.klart` för att återställa
avslut som hann skickas medan Kön var avstängd.

## Körning

Från teammappen:

```bash
node --test test/*.test.cjs
```

Lokal stad från repo-roten:

```bash
PLUGINS_DIR=board/plugins node board/server.js
```

Öppna `/staden/kvarter/fralle/`. Testerna använder isolerade kataloger
och en lokal server, aldrig workshopens Torget.
