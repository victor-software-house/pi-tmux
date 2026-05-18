# Changelog

## 1.3.4 — 2026-05-18

### Changed

- Peer range for `@earendil-works/*` bumped from `>=0.74.0` to `>=0.75.0` to match Pi 0.75.x. No API surface changes were required; the imports used by this package are unchanged across the 0.74 → 0.75 upgrade.

## 1.3.2 — 2026-05-12

- Kept package on `@victor-software-house/pi-tmux`; patch bump to 1.3.2.
- Standardized on pnpm 11.1.1 and Node 24 LTS metadata.
- Moved Pi runtime packages to optional peers and removed same-name dev deps.
- Added private GitHub Packages publish config plus CI/release workflows.
- Regenerated lockfile after transitive Pi runtime cleanup and `@mariozechner/*` source swap.
