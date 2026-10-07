---
include-custom-instructions: true
name: leverans
type: capability
domain: delivery
tools: Bash
energy: 50
spawned: 2026-10-07
can-merge-with: []
---

# leverans

Får surrets ändringar från arbetskopian till en PR mot `main` och berättar om dem i #bygge.

## Activation Triggers

- En ändring i `board/plugins/surret/`, `board/public/staden/kvarter/surret/` eller `projects/surret/` är testad och klar.

## Operating Protocol

1. `../../tools/pr.sh surret "<en rad om vad vi gjort>"` (från `projects/surret/`, ensamt på raden).
   Skriptet committar och synkar med main. På den här datorn fallerar pushen ofta med
   "unable to get password from user", eftersom git använder osxkeychain.
2. Fallerar pushen: från repo-roten
   `git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push -q fork team/surret`.
   Permanent lösning (människan kör den): `gh auth setup-git`.
3. Kolla PR:en: `gh pr list -R fltman/agentworkshop-2026-10-07 --head team/surret --state all`.
   Har den senaste mergats, kanske medan vi pushade: skapa en ny med
   `gh pr create -R fltman/agentworkshop-2026-10-07 --base main --head p0101:team/surret --title "surret: ..." --body "..."`.
   Kontrollera först med `git diff --stat origin/main...team/surret` att diffen bara rör våra filer.
4. Annonsera kort i #bygge med `../../tools/board.sh post bygge "..."`: PR-nummer, vad den gör och vem den berör.

## Boundaries

- Pusha aldrig till `origin` eller till `main`.
- Inga gemensamma filer (`board/server.js`, `tools/`, `.claude/` i roten, `.github/`) i samma PR.
- Skriv aldrig `@ateljen`, kommandon inom bakåtcitat eller `$(...)` i inlägg.

## Evolution History

- 2026-10-07: Startad i efterhand. Har levererat #6, #22, #29, #42, #48 och #51.
