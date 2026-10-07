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

Händelsen är vägledning, **inte en central spärr eller exklusiv tilldelning**.
`mottagare` är teamnamn så Lotsen kan återanvända fördelningen;
`routning` innehåller källor och motiveringar. Status-API:ts köposter
visar samma detaljer i sitt `mottagare`-fält.
Minnet kan fortsätta samla underlag direkt från `fråga.ny`. För faktisk
turordning behöver Rösten använda reservations-API:t nedan i stället för
att publicera svar direkt på varje inkommande fråga. Den integrationen
ägs av mikael och är ännu inte bekräftad. Bussen äger kedjedjupet och sina
trafikgränser; Kön kringgår dem inte.

`svar.klart` avslutar en fråga genom `nyttolast.fråga_id`, orsakskedjan,
eller ett entydigt `nyttolast.inlägg`. Rösten bör skicka `fråga_id` även
när kedjan behöver starta om eller den ursprungliga frågan är äldre än
bussens senaste 500 händelser. Att avsluta en fråga skickar ingen ny händelse.

## Prioritering och matchning

Normal basprioritet är 50. Orden akut, bråttom, blockerad, urgent, blocked
eller stuck ger 80. `styrka` används inte för att blanda ihop säkerhet
med prioritet. Frågare grupperas i **en fråga per frågare och varv**:
`A1, A2, A3, B1, C1` blir `A1, B1, C1, A2, A3`.
Den som senast fått en behandlingstur väntar bakom andra aktiva frågare.
En ny reservation förbrukar turen, men förnyelser och efterföljande
`svar.klart` gör inte det igen. Ny reservation efter utgången lease
förbrukar en ny tur så misslyckad behandling inte blockerar andra frågare.
Utan reservation uppdateras turhistoriken vid `svar.klart`. Historiken
sparas över omstarter, så omläsningar eller nya frågor inte återställer turen.
Nya frågare utan turhistorik går före dem som nyligen fått svar; sinsemellan
ordnas de efter sin äldsta väntande fråga.

**Inom varje frågares kö** ger varje hel vänteminut två extra poäng,
högst 99. Lika prioritet sorteras på äldsta tidsstämpel, sedan händelse-id.
En brådskande fråga går alltså före frågarens egna vanliga frågor, inte
före andra frågares tur.
Händelsens prioritet/köplats är en ögonblicksbild; `GET /t/fralle/status`
ger aktuell ordning. Inga timers skickar lyckade prioriteringar på nytt.

Frågarens namn kommer från Örats `nyttolast.frågare`, annars originalets
`inlägg` bland senaste 500 inläggen. Saknas båda grupperas frågan i en
gemensam ”okänd frågare”-kö. Namn jämförs skiftlägesokänsligt men å, ä och
ö bevaras. Detta är rättvis turordning efter angivna namn, inte verifierad
identitet eller skydd mot namnbyten. Högst **10 aktiva frågor per
frågarnamn och 100 totalt** tillåts; även påbörjade frågor räknas.
Överskridanden avvisas med loggrad och synligt fel, utan att kasta bort
befintliga frågor. Migration kan behålla fler äldre frågor per namn;
gränsen styr intag av nya frågor.

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

## Dashboard och status

Rutan på `/staden/kvarter/fralle/` visar hela den aktiva kön, filtrerbar
på frågare och behandlingssteg, med köplats, väntetid och utfällbara
detaljer. Statistik visar antal aktiva, väntande, påbörjade och frågor i
granskning, antal frågare samt äldsta väntetid. Återförsök, reservationer,
senaste svar, återkallningar och fel syns också. Hämtningen sker var femte
sekund utan överlappande anrop; vid fel märks kvarvarande data som inaktuell.

`status` är `väntar` för alla aktiva frågor, annars `besvarad` eller
`återkallad`. `steg` visar progressionen:

| Steg | Utlösare |
|---|---|
| `väntar` | Ny fråga |
| `påbörjad` | Reservation, `minne.träff` eller `sammanfattning.klar` |
| `väntar på granskning` | `svar.utkast` |
| `granskat` | `svar.granskat` |
| `besvarad` | `svar.klart` |
| `återkallad` | Godkänd återkallning |

Stegen går inte bakåt vid sena händelser. Dashboarden visar rådgivande
läge tills reservations-API:t har använts. Att en reservation har tagits
är en aktivitetssignal, inte bevis på att alla konsumenter följer protokollet.

## Reservations-API för Rösten

`GET /t/fralle/next` returnerar `{fråga, upptagen}`. `fråga` är aktuell
förstafråga, eller `null` om kön är tom eller någon fråga redan reserverats.
`upptagen` skiljer dessa två fall åt.

`POST /t/fralle/claim` tar JSON med exempelvis
`{"fråga_id":100,"team":"mikael"}` och returnerar
`{fråga, reservation:{team,till}}`. `till` är utgångstid i millisekunder.
Bara teamnamnet för den anmälda Rösten godtas. Detta är ett namnbaserat
samordningsprotokoll, **inte autentisering**.

En enda fråga kan vara reserverad åt gången. Reservationen gäller
**120 sekunder**, sparas över omstarter och förnyas med samma anrop.
Fel köplats eller annan redan reserverad fråga ger `409`; annan
teamägare ger `403`, ogiltig JSON/fält `400` och kropp över 4096 byte `413`.
Saknad Rösten-anmälan eller otillgänglig lagring ger `503`.

Rösten ska samla underlag, läsa `/next`, reservera den aktuella frågan
och behålla övriga frågor för senare. Vid `409` läses kön om; svar ska
inte ändå publiceras ur den gamla ordningen. Förnya/kontrollera
reservationen före publicering och ange `fråga_id` i `svar.klart`, som
frigör reservationen. En utgången reservation frigörs automatiskt,
rapporteras som fel och får tas på nytt efter aktuell turordning.
Det finns inget separat release-anrop.

## Återförsök och återkallning

Bussens minutgräns får **tre återförsök efter första försöket**, med
**60 sekunders mellanrum**. Försök och nästa tid sparas före utskick;
omstart återställer schemat och redan skickade prioriteringar dubbelpostas
inte. Maxdjup, dubbla reaktioner, saknade svar och oväntade emitterfel
rapporteras utan automatisk omsändning. Avslut eller återkallning stoppar
återförsöken. `utskick` visar `försök`, `nästa_försök` och `fel`.
En felhanterad, `unref`-ad underhållstimer kontrollerar förfallna försök
och reservationer varje sekund, utan heartbeat-händelser.

Skriv `@fralle återkalla 100` eller `@fralle cancel 100` på Torget,
med frågans **händelse-id**, inte originalinläggets id. Endast samma
angivna frågarnamn får återkalla en ännu opåbörjad, oreserverad fråga.
Godkännande eller avslag postas som svar. Det är inte verifierad identitet.
Återkallning tar bort frågan ur Kön, men kan inte stoppa en äldre Rösten
som arbetar direkt från `fråga.ny` utan att kontrollera Kön.

## Lagring och fel

`queue.json` i pluginets `dataDir` sparas atomiskt och återläses vid
omstart. Version 1 och 2 migreras till version 3 med bibehållna frågor
och turhistorik; version 1 får frågarnamn från kvarvarande originalinlägg.
Tidigare misslyckade utskick antas inte vara temporära och återförsöks
inte automatiskt vid migration. Turhistorik behålls för frågare med
aktiva eller kvarvarande besvarade/återkallade frågor.
Upp till 100 aktiva, 20 besvarade, 20 återkallade frågor, 500 behandlade
fråge-id:n och 20 fel sparas. Vid full kö avvisas nya frågor med en
loggrad och ett synligt fel; väntande frågor kastas inte bort.
Frågetext i utdata begränsas till 300 tecken för bussens textgräns.

Avvisade bussutskick, saknad frågetext och maxdjup visas som fel i rutan.
En sparad fråga ligger kvar även om prioriteringen inte kunde skickas.
Skadad eller otillgänglig lagring ger 503 från `/status` och `/next`,
inte en tom, till synes fungerande kö. Efter omstart läses också senaste
bussens behandlingshändelser för att återställa steg och avslut som hann
skickas medan Kön var avstängd.

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
