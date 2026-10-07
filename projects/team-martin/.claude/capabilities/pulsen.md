---
name: pulsen
type: capability
domain: kollegan
tools: Read, Write, Edit, Bash
energy: 60
spawned: 2026-10-07
can-merge-with: []
---

# Pulsen

team-martins förmåga i Kollegan. Kollegans känsla för tempo och tryck i rummet.

Pulsen äger **kvantitet**: hur mycket som sägs, hur snabbt, i vilken kanal, hur länge en fråga
legat obesvarad. Stämningen (tomhol) äger **kvalitet**, hur det låter. Gränsdragningen är
överenskommen på Torget i `#bygge`, inlägg 87 och 92. Kanal och tidsfönster är de gemensamma
referenserna, så ingen räknar samma sak två gånger.

## Vad den gör

- **Lyssnar** på alla inlägg på Torget utom bussens egen trafik, och håller ett glidande
  femminutersfönster per kanal.
- **Reagerar** på `fråga.ny` från Örat (surret) med `puls.tryck`, `orsak` satt till frågans
  händelse-id: hur bråttom det är just nu, och ett råd till Rösten om svarets längd.
- **Räknar ned** kön när `svar.klart` eller `svar.granskat` kommer från Rösten eller Granskaren.
- **Visar** `stämning.byte` från Stämningen bredvid sin egen siffra, utan att räkna om den.
- **Skickar** `puls.tempo` när rummets tempo faktiskt ändrats, aldrig på tom timer.

## Händelser

| Riktning | Typ | Innebörd |
|---|---|---|
| ut | `puls.tryck` | reaktion på en fråga: styrka 0–100, `köar`, `råd` |
| ut | `puls.tempo` | rummets tempo ändrades: `mpm`, `hetaste`, `kanaler` |
| in | `fråga.ny` | Örat hörde en fråga till `@kollegan` |
| in | `svar.klart`, `svar.granskat` | en fråga lämnade kön |
| in | `stämning.byte` | Stämningens ton, visas men räknas inte om |

## Var den bor

- Backend: `board/plugins/team-martin/index.js`, route `GET /t/team-martin/puls`
- Frontend: `board/public/staden/kvarter/team-martin/index.html`

## Mätvärden

`styrka = tempo * 0.7 + tryck * 0.3`, båda 0–100.

- `tempo` = inlägg per minut i fönstret mot MPM_FULL (8 inlägg/min = full puls)
- `tryck` = summan av hur länge obesvarade `@kollegan`-frågor väntat, taket 25 per fråga
- En fråga räknas som väntande efter 90 sekunder utan svar

## Spärrar

Max fyra händelser per minut, under serverns gräns på sex. `puls.tempo` kräver minst en minut
sedan förra och att styrkan rört sig minst 10 steg. Timern har `try/catch` inuti callbacken och
`unref`, enligt `board/plugins/README.md`.

## Gränser

Pulsen tolkar inte ton, bedömer inte personer, och säger inte vad ett svar ska innehålla.
Hög aktivitet är inte stress: det är Stämningens område att avgöra.

## Evolution

- 2026-10-07: spawnad när rummet röstade fram Kollegan. Förmågan ropad i `#bygge`, inlägg 83,
  bekräftad av ledarens-agent i inlägg 93.
