# Rapportörens API-kontrakt V1

Rapportören ligger i fralles plugin och läser andra förmågors HTTP-API:er.
Rapportvyn finns på `/staden/kvarter/fralle/rapport/`; rapporten hämtas från
`GET /t/fralle/report?minutes=60`. Tillåtna perioder är 15, 60 och 1440 minuter,
med 60 som standard. Det krävs inga nya paket, nycklar eller busshändelser.

## Krav på varje förmåga

Tillhandahåll `GET /t/<team>/report-data?from=<ms>&to=<ms>`.
Tider är UTC epoch-millisekunder, intervallet är **[from, to)** och högst
24 timmar. Exponera bara observerade värden. Endpointen ska vara läsande,
ha `Content-Type: application/json` och inte skapa busshändelser.

```json
{
  "schema_version": 1,
  "team": "surret",
  "capability": "Örat",
  "generated_at": 1700003600000,
  "period": {"from": 1700000000000, "to": 1700003600000},
  "coverage": {
    "from": 1700000000000,
    "to": 1700003600000,
    "complete": true,
    "note": "Alla frågehändelser i perioden finns kvar."
  },
  "metrics": [{
    "key": "questions_received",
    "label": "Inkomna frågor",
    "value": 1,
    "unit": "count",
    "scope": "period"
  }],
  "records": [{
    "question_id": 174,
    "received_at": 1700000010000,
    "answered_at": 1700000014000,
    "cancelled_at": null,
    "audience": "unknown",
    "useful": null,
    "saved_minutes": null
  }]
}
```

- `team` måste motsvara URL:ens team. `capability` beskriver förmågan.
  `generated_at` är tid för källans faktiska sammanställning, inte bara en
  proxyhämtning. Rapportören tillåter fem sekunders klockskillnad; efter två
  minuter märks data som äldre.
- `period` återger exakt det begärda intervallet. `coverage` beskriver den
  verkliga datatäckningen. Okända gränser är `null`. `complete: true` kräver
  stöd för hela perioden, inklusive källans uppdateringstid.
  En senaste-N-buffer, tappade utskick eller omstart utan återställning
  får inte beskrivas som fullständig historik. Förklara begränsningen i `note`.
- Varje mått har unik ASCII-nyckel (gemener, siffror, punkt, bindestreck,
  understreck), begriplig `label`, ändligt tal eller `null`, `unit` och `scope`.
  `scope` är `period`, `snapshot`, `lifetime` eller `retained`.
  Nuläge, livstidsräknare och begränsat historikurval får inte maskeras som
  totalsiffror för vald period. Latens/andelar bör ha `sample_size`
  (icke-negativt heltal eller `null` när okänt).
- `records` är valfritt. Ange **råa fråga.ny-händelsens id** som `question_id`,
  inte inläggs-id, trigger-id, utkast-id eller slutligt svars-id.
  `received_at` är **fråga.ny-händelsens `ts`**, inte originalinläggets
  tid eller den egna förmågans hördtid. Slututfallets tid är den gemensamma
  `svar.klart`-händelsens `ts`, respektive Köns sparade återkallningstid.
  Saknas den kanoniska tiden: ange `null`, inte en lokal observationstid.
  Tider är heltal eller `null`; slututfall får inte föregå en känd ankomst.
  Samma rot kan finnas hos flera förmågor och räknas ändå bara en gång.
  En förmåga som bara känner ett utfall kan ange `received_at: null`;
  utfallet används först när det går att koppla till en känd ankomst.
- `audience` är uttrycklig klassificering: `human`, `agent`, `test` eller
  `unknown`. Gissa inte utifrån namn. Klassificeringen är uppgiven av
  källan, inte verifierad identitet.
- `useful` är uttrycklig användarfeedback (`true`, `false` eller `null`).
  `saved_minutes` är uttryckligen rapporterad, ändlig, icke-negativ tid
  eller `null`. Uppskattning i text, godkänd granskning, snabbhet eller
  antal svar räknas inte automatiskt som nytta eller sparad tid.
  Rapportörens nyttosiffror avser bara poster märkta `human`; annan
  feedback redovisas separat som ej kopplad till en mänsklig frågare.
- Fel ska ha 4xx/5xx och ett tydligt JSON-fel. Okända mått är **null, inte 0**.
  Ett lyckat tomt resultat betyder faktiskt tomt urval; det får inte användas
  som ersättning för misslyckad lagring eller insamling.
- Max 256 KiB per svar, 100 mått och 500 frågeposter per källa.
  Behövs större historik: leverera aggregat och märk frågeurvalet som
  begränsat; begär en kontraktsutökning i stället för tyst trunkering.

## Ansvar och mått som efterfrågas

| Team / förmåga | Efterfrågad information |
|---|---|
| surret / Örat | Inflöde, dubbletter, ursprungliga fråga-id:n, ankomst och uttrycklig avsändarklass |
| fralle / Kön | Aktiva frågor, kösteg, väntetider, utan-framsteg, återförsök och återkallningar |
| mikael / Rösten | Slutliga svar, fråga-id, publiceringstid, ogranskade/felaktiga utskick; feedback om sådan samlas in |
| heimlen / Granskaren | Godkända/underkända, beslutsurval, latensurval och storlek |
| team-martin / Pulsen | Aktivitet/tempo och tryck med verkliga fönster och definitioner |
| holminator / Minnet | Uppslag, träffar, uteblivet underlag och fel, gärna kopplade till fråga-id |
| marcuslind / Mötet | Sammanfattningar, fråga-id, tid och antal källinlägg |
| tomhol / Stämningen | Uttryckliga textsignaler och tidsfönster, inte personers känslor |
| leif / Översättaren | Språk, översättningsantal, period kontra livstid och fel |
| farzad / Nyfikenheten | Agentfrågor och utfall, med Örats verkliga rot-id när känt |
| babtist / Lotsen och Kursen | Lotsningar, uppslag, underlagsbrist och hämtningsfel |
| Övriga registrerade plugins | Egna observerade aktiviteter/mått med samma kontrakt |

Ingen förmåga behöver hitta på feedback eller leverera ett mått den inte
observerar. Rapportera `null` och förklara luckan. Varje team äger sin
implementation och måste bekräfta sin endpoint; fralle ändrar inte deras filer.
Kraven har skickats i Torgets #bygge, inlägg 675 och 677.
Kön särredovisar parkerade frågor som snapshot: de är bevarade öppna frågor,
inte svar, återkallningar eller bekräftade misslyckanden.

## Övergång från befintliga API:er

Rapportören läser `/api/plugins` och upptäcker registrerade förmågor.
Den försöker först kontraktet ovan. Enbart vid **404** kan följande
befintliga, verifierade API:er användas som uttryckligt märkt `legacy`:

| Team | Äldre API |
|---|---|
| surret | `/fragor` |
| mikael | `/status` |
| heimlen | `/metrics` |
| team-martin | `/puls` |
| holminator | `/tidslinje` |
| marcuslind | `/sammanfattningar` |
| tomhol | `/status` |
| leif | `/status` |
| farzad | `/state` |
| babtist | `/forslag` |

Alla sökvägar är under `/t/<team>`. Standardiserade API-fel, felaktiga
versioner, trasig JSON eller falsk täckning ersätts **inte** med gamla API:er.
Äldre datakällor har okänd generationstid och ofullständig täckning.
Röstens svar utan rot-id summeras inte med Örats/Köns frågor.
Granskarens medel från ett separat urval används inte som global median.
Leifs livstidsräknare visas som livstid, inte som vald period.

## Rapportörens resultat

Rapporten visar observerade unika frågor **inkomna i perioden**, deras
daterade svar/återkallningar och antal utan observerat slututfall. Det
sistnämnda är inte ett bevis för att frågan misslyckats. Endast kända
ankomster kan ingå i kohorten; okopplade utfall visas separat.
Median och p95 beräknas på unika matchade rötter, inte medelvärden av medel.
Konflikter mellan källor redovisas och används inte som säkra värden.
En rapport med konflikter kan inte märkas som fullständig, även om varje
källa påstår full täckning. Kombinerade utfall före ankomst är också konflikter.
Tidslinjens svar gäller periodens inkomna frågekohort, inte alla äldre
frågor som råkat få svar under perioden.

Varje källa har URL, hämtningstid, API-läge, täckning och synliga fel.
Det går att få en delvis fungerande rapport när en källa saknas.
Alla källor otillgängliga ger 503 med en strukturerad rapport och okända
värden, inte friska nollor. Råa frågeposter vidarebefordras inte i
sammanställningen; de finns hos respektive källas API.

Insamlingen använder serverns egna socket-adress och port, aldrig en
klients Host-header eller URL. Redirects nekas, varje HTTP-anrop har
tre sekunders timeout och storleksgräns. Källor läses parallellt,
samtidiga rapportanrop samordnas och resultat cachas tio sekunder.
Andra teams busshändelser ogiltigförklarar cache utan att starta någon
insamling, pollingtimer eller busspost i bakgrunden.
