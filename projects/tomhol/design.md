# Stämningen: första versionen

## Syfte och omfattning

Stämningen hjälper workshopdeltagarna och Kollegan att se observerade
språksignaler per kanal. Den bedömer inte personers känslor.
Svenska och engelska hanteras med transparenta regler för frågor, uttryckliga
hinder, uppskattning och uttryckt omtanke. Källinlägg och matchade formuleringar visas.
Ironi, citat, negationer och sammanhang kan ge felaktiga eller uteblivna träffar.
Inga externa modeller, företagsdata eller personprofiler används.

## Antaganden

- Cirka 30 team; senaste 20 inläggen per kanal inom 10 minuter.
- Rutan hämtar status var femte sekund; nätverk och uteblivna Puls-händelser
  kan fördröja nya bedömningar.
- Ingen egen historik på disk. Omstart tömmer visningsstatus.
- Team tomhol äger backend, ruta och regelordlista.
- Ingen separat tillgänglighetsgaranti utöver workshopserverns.

## Beslutslogg

1. Regelbaserade språksignaler valdes framför extern AI och manuell bedömning:
   transparent, testbart och utan nya dataåtkomstbehov.
2. Händelsestyrd bedömning valdes framför bedömning av varje inlägg eller bara
   på begäran: synlig koppling mellan teamen, utan utskick för varje meddelande.
3. Aktivitet hålls separat från samtalston: hög aktivitet är inte bevis på stress.
4. `styrka` utelämnas: det finns inget validerat säkerhetsmått för ordreglerna.
5. Pulsen bekräftade formatet i Torgets inlägg 123; vi svarade i 124.
   `puls.tempo` använder `nyttolast.hetaste`, `puls.tryck` använder
   `nyttolast.kanal`. Båda kommer från `team-martin`.
6. Inget utskick vid tomt underlag; uteblivna träffar betyder inte lugn.
7. Uttryckt omtanke visas med ❤️ och identifieras genom ett begränsat urval
   svenska/engelska stödfraser och hjärtan (❤/♥, med eller utan emoji-variant).
   Det beskriver uttryck, inte personers värme eller avsikt. Hjärtan kan vara
   ironiska eller betyda annat. Frågor, hinder och uppskattning visas med
   ❓, 🚧 respektive 🙌; symbolerna kompletterar textetiketterna.

## Dataflöde

Pluginet läser kanalens Torget-historik vid en giltig Puls-händelse och väljer
senaste 20 meddelandena inom 10 minuter. Varje inlägg räknas högst en gång
per kategori. Vanliga negationer före hinderuttryck filtreras.
Busskanalen används inte som samtalsunderlag.

Rutan visar bedömningen även om ett nytt bussutskick inte är möjligt.
`stämning.byte` skickas vid ändrade signalantal med `orsak` satt till Puls-id.
Nyttolasten innehåller `kanal`, `fonster {fran, till}`, `antalInlagg`,
`signaler {fragor, hinder, uppskattning, omtanke}`, `kallor {inlagg, signal, uttryck}`,
`metod` och `begransningar`. Tidsfönstret använder ISO-tider i UTC.
Pulsens femminutersfönster visas separat där det finns angivet.
Högst sex källexempel skickas för att hålla hela händelsen inom serverns
gräns på 2000 tecken. Signalantal gäller fortfarande samtliga valda inlägg.

Högst sex utskick per glidande minut, med minst tio sekunder mellan utskicken.
Begränsade ändringar bedöms igen vid nästa Puls, utan utskickstimer.
Djup fyra uppdaterar enbart rutan. Avvisade utskick loggas och visas som fel.
Högst 100 kanalbedömningar hålls i minnet.

## Leverans och kontroll

- Backend: `board/plugins/tomhol/index.js`, `GET /t/tomhol/status`.
- Ruta: `board/public/staden/kvarter/tomhol/`, säkert renderad med textContent.
- Tester: `projects/tomhol/stamningen.test.cjs`, kör med
  `node --test projects/tomhol/stamningen.test.cjs` från repo-roten.
- Ingen ändring av andra teams kod eller gemensamma serverfiler.
- Risker: begränsad ordlista, feltolkad ironi och citat, beroende av Pulsens
  händelser. Rutan visar källor, metodbegränsningar och bedömningens ålder.

## Nästa version: rullande kanalvågor

Godkänd design: en SVG-rad per kanal med senaste tio minuterna, nutid till
höger. Antal Torget-inlägg per tio sekunder ger linjär våghöjd (0–10);
värden över tio markeras med exakt antal. Samma skala används i alla kanaler.
Språksymbolerna förankras vid inläggens faktiska tid. Överlappande markörer
av samma kategori grupperas inom fasta 30-sekundersintervall; detaljer
visar varje käll-id, tid och uttryck. Kanaler sorteras alfabetiskt.

Beslut: SVG valdes framför Canvas och HTML-staplar för skalbarhet och
textbaserade detaljer. Befintliga regler delas mellan sammanfattning och
tidslinje, utan nya busshändelser. Inga personnamn eller externa tjänster.

`GET /t/tomhol/timeline` returnerar tidsfönster, täckningsstart, kanalernas
aktivitetsintervall och signalmarkörer. Backend läser tillbaka högst 500
inlägg vid start och följer därefter onMessage. Högst 5000 vanliga inlägg
inom tio minuter sparas i minnet; bussmeddelanden undantas. Om startens
sida eller minnestaket begränsar underlaget flyttas täckningsstarten fram.
Okända delar markeras grå, inte som noll aktivitet. Omstart återställer
bara serverns tillgängliga historik; ingen egen disklagring tillkommer.

Frontend hämtar var femte sekund och flyttar vyfönstret med monoton tid
mellan hämtningarna. Efter snapshot-tiden är området okänt tills nästa
hämtning. Vid fel behålls gammalt underlag med varning. Efter 15 sekunder
markeras det inaktuellt. Dold sida pausar animering och hämtning;
reducerad rörelse innebär endast uppdatering vid hämtning.
Hämtningsfelets orsak och åldern på senaste lyckade hämtning visas även
under animation. Statusen återgår till ansluten först efter en lyckad hämtning.

Risker: regler missar nyanser; mycket trafik kan begränsa historiken;
smala rutor kan ge täta symboler. Detaljerna bevarar källorna.
Kontroller omfattar exakt tidsplacering, skala, grupper, täckningsluckor,
sortering, säkra texter, minnestak och verklig serverintegration.

## Animationer och röst

Endast frontend; backend och `stämning.byte` är oförändrade.
- Nya markörer, jämfört med förra lyckade hämtningen, poppar in (cirka 300 ms).
  Första hämtningen sätter bara baslinjen och animerar inget.
- Kanalens högsta vågtopp i fönstret pulserar med en glöd.
- Nya ❤️-markörer (omtanke) ger ett svävande hjärta i kanalens ruta.
- Röst via webbläsarens talsyntes (Web Speech API): ”Bra jobbat, gubbar!” när nya
  markörer för uppskattning eller omtanke dyker upp. Avstängd tills användaren
  klickar 🔊 (webbläsare blockerar ljud utan klick, och rutan är gemensam),
  högst en gång per 30 sekunder. Saknas talsyntes inaktiveras knappen.
  Klicket säger frasen direkt (låser upp talsyntes i Chrome/Safari); fel visas på knappen.
- Ljus kvinnoröst: Web Speech anger inte kön, så kända svenska kvinnoröster väljs på namn
  (Alva/Klara på macOS, Hedvig på Windows), annars första svenska röst; tonhöjd 1.6.
- Reducerad rörelse stänger av alla animationer men inte den valda rösten.

Beslut: talsyntes framför ljudfil (ingen tillgång att distribuera eller
licensiera); utlösning på nya markörer framför räknarökning, eftersom antalet
i fönstret också minskar när gamla markörer rullar ut.

## Läsbar rad i stämning.byte

`nyttolast.rad` ligger först och är en mening utan JSON, till exempel
”I #bygge de senaste 10 minuterna (20 inlägg): 12 frågor, 1 hinder,
1 uppskattning och 1 uttryck av omtanke. Det är språksignaler, inte känslor.”
Minnet och Rösten föredrar `rad`; utan den citerades rå JSON som Röstens
skydd sedan klippte bort helt (team-martin, inlägg 1037).

## Skarpare signaler, trend och paus

- Automatiska svar (inlägg som börjar med `Kollegan:`, `Lotsen:`, `Örat:`, `Granskaren:`,
  `Kön:` eller `Stämningen:`) och teamets egna inlägg räknas inte i bedömningen och ger inga
  markörer i tidslinjen. De ekade frågor och gav uppblåsta frågetal (t.ex. 10 av 20 i #torget).
- Frågor: `?`, eller ett frågeord (hur, varför, vem, vilka, vilken, vad, när, how, why, who,
  what, when, where) som inleder en mening, även efter @-omnämnanden. ”när” mitt i ett påstående räknas inte.
- Hinder: även ”sitter fast”, ”kör fast”, ”går inte”, ”failar/failade”, ”kraschar/kraschade”,
  ”crashes/crashed”, ”error” och ”timeout”. Negationsfiltret gäller som tidigare.
- `#stadens-saga`, `#radio` och `#kollegan-events` bedöms aldrig och ger inga utskick.
  Tidslinjen visar fortfarande deras aktivitet.
- `rad` jämför med kanalens förra bedömning, t.ex. ”Jämfört med förra bedömningen: frågor 1→2.”
  Rutan visar `rad` överst i varje kanalkort.
- Paus: `@tomhol pausa` respektive `@tomhol fortsätt` från `tomhol` eller `ledarens-agent`.
  Pausad Stämning skickar inga `stämning.byte` men uppdaterar vyn och bekräftar i tråden.
  Pausen ligger i minnet och nollställs vid omstart. Avsändarnamn på Torget är inte verifierade.
