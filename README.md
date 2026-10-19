# FT8TW-Webserial

This is a self-hosted mirror of [FT8TW](https://ft8tw.bv6lc.com/) (by Dan Lee / BV6LC) with a set of decode-table usability changes applied on top, built by AI5II.

Hi Dan — per our earlier conversation, here's the fork so you can see exactly what changed and why. Thanks again for the OK to modify and share back.

## What's in this repo

- **Base commit**: a pristine, unmodified crawl of the app as served at `ft8tw.bv6lc.com` (nothing rewritten — every asset reference in the app is already a relative path, so it runs as-is from any host).
- **13 commits on top**, each one a self-contained change, in the order they were made. Commit messages explain the what and why for each. High-level summary:
  - Removed the per-row dial-frequency column (redundant with the top bar) and switched decode rows from the two-line "card" layout to a single line per decode.
  - Removed the signal-strength bar icon next to dB (just the number remains).
  - Decode count is now a true unbounded tally; a band change clears the list instead of only the manual Clear button doing that.
  - Several rounds of column-width fixes so the message column reliably fits the full 22-character standard FT8 message (compound callsigns/grid locators/signal reports) on one line, on both desktop and phone widths, without wrapping or horizontal scroll.
  - A typography pass: smaller font for the metadata columns (S./dB/Δt/Hz), larger font for the message itself, so the decoded text is the visual focus.
  - ADIF import for the QSO Log tab (it had no import at all before), built to handle real-world-sized logs (tested against a real 54,503-record import) without freezing the tab — chunked IndexedDB writes with explicit yields instead of one giant blocking pass.
  - Fixed the "worked station" strikethrough/exclusion logic to key off callsign+band+mode instead of callsign alone (same convention your own PSK Reporter dedup already uses), so working someone on 20m FT8 no longer hides them on 40m or FT4. Also added a separate Control-tab option to hide already-worked stations from the decode list entirely — left your existing "Show worked stations" setting (Calling tab) untouched.

Each commit applies cleanly in sequence (`git log --oneline` to see them all); happy to answer questions about any of them or adjust anything that doesn't fit how you'd want it done in your own source tree.

## `patches/`

The same changes, also as raw unified diffs (`01-...patch` through `13-...patch`, same order as the commits). If it's easier to pull one directly into your own source tree rather than reading it off a commit, these apply with `patch -p1 < patches/NN-name.patch` or `git apply patches/NN-name.patch` (run from the relevant directory in your tree — paths inside are relative to the app root, e.g. `js/cards/ui.mjs`, `css/cards.css`). They're generated from, and kept in sync with, the same local mirror this repo is built from.

## How this mirror works

Not part of the actual changes, just FYI: this repo is generated from a local self-hosting setup (`crawl.py`, a custom ES-module-graph crawler, since plain `wget --mirror` can't see `.mjs` `import` statements or the `new URL(..., import.meta.url)` calls the WASM loaders use). The decode-table changes above are applied as patches on top of a fresh crawl every time it re-syncs with your live site, so local changes survive you shipping new features upstream.
