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
