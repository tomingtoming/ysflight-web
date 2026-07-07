# Contributing notes

## Languages

This project serves an international community while being maintained by a
Japanese speaker. The convention, by audience:

- **User-facing surfaces** (README, UI strings, error messages): English
  first; a short Japanese preface where it helps (see README).
- **PR titles and commit subjects**: English — they become permanent,
  world-visible git history (merge commits, `git log --oneline`).
- **PR bodies and review discussion**: either language. Japanese is fine —
  the maintainer reviews in Japanese. For larger PRs, a 2–3 line English
  TL;DR at the top is appreciated.
- **Design documents under `docs/`**: Japanese. They are the maintainer's
  working design records, not user documentation; the README says so.
- **The engine forks** (`upstream/YSFLIGHT`, `upstream/public`): commits and
  PRs in English, always. Every change there is written to be
  cherry-pickable to upstream (captainys) and readable by the upstream/YSCE
  community — see the fork's own CONTRIBUTING.md.
