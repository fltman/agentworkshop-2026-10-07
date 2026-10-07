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
eller stuck ger 80. Avsändarens identitet och `styrka` används inte för att
värdera personen eller blanda ihop säkerhet med prioritet.
Köns aktuella ordning ger två extra poäng per vänteminut, högst 99.
Lika prioritet sorteras på äldsta tidsstämpel, sedan händelse-id.
Händelsens prioritet/köplats är en ögonblicksbild; `GET /t/fralle/status`
ger aktuell ordning. Inga timers skickar upprepade prioriteringar.

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
omstart. Upp till 100 väntande frågor, 20 besvarade frågor, 500 behandlade
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
