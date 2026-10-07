---
include-custom-instructions: true
name: kedjetest
type: capability
domain: testing
tools: Bash, Read, Grep
energy: 50
spawned: 2026-10-07
can-merge-with: [ora-plugin]
---

# kedjetest

Kör Kollegans hela kedja lokalt: main, valda öppna PR:er och vår arbetskopia av Örat. Ställer testfrågor och rapporterar var kedjan fungerar och var den bryter.

## Activation Triggers

- Vi ska leverera en ändring av Örat.
- Någon ber om review eller test av andras PR:er mot kedjan.
- Live-beteendet ser konstigt ut, till exempel loopar, "(osäkert)" eller tappade svar.

## Operating Protocol

Från repo-roten:

1. Hämta: `git fetch -q origin main pull/<N>/head:refs/review/pr<N>` för varje PR.
2. Bygg pluginkatalogen i en tempkatalog `$T`:
   `git archive origin/main board/plugins | tar -x -C $T`, flytta `$T/board/plugins/*` till `$T/plugins/`.
   Skriv över med PR-versioner: `git show refs/review/prN:board/plugins/<team>/index.js > $T/plugins/<team>/index.js`.
   Ersätt `surret` med vår arbetskopia.
3. Starta från `board/`: `PORT=8199 DATA_DIR=$T/data PLUGINS_DIR=$T/plugins node server.js`.
4. Seeda ett anspråk (till exempel holminator i #bygge) och ställ frågor via `POST /api/messages`:
   en vanlig fråga, en engelsk fråga, en dubblett och en "sammanfatta"-fråga. Vänta cirka 25 s.
5. Läs `/api/events?limit=60` (typ, kvarter, styrka, orsak, djup) och `/api/messages`, och sök efter fel i loggen.
6. Stoppa servern med `kill <PID>` (PID från `lsof -ti tcp:8199`), aldrig parallellt med en sista curl. Ta sedan bort `$T`.

## Rapport

Kort: kedjan rad för rad, svarstid, djup, och fynd per ägare. Fynd hos andra kommenteras på deras PR med
`gh pr comment N -R fltman/agentworkshop-2026-10-07`, och en sammanfattning går till #bygge.

## Boundaries

- Testar aldrig mot den skarpa tavlan med låtsashändelser.
- Rättar inte andras kod, utan rapporterar.

## Evolution History

- 2026-10-07: Startad i efterhand. Gjort för hand tre gånger (#9–#12, #28–#32, Örat v3).
