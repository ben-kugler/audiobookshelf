# Storyteller Read-Along for Audiobookshelf

**Date:** 2026-06-23
**Branch:** reorganize-files
**Status:** Approved design

## Goal

Add Storyteller-style read-along (synchronized text + audio narration) to this
Audiobookshelf fork, in two parts:

1. **Generate** — when the existing import-folder feature matches an ebook to an
   audiobook, optionally produce a synced EPUB 3 (with Media Overlays) by
   delegating the forced alignment to a Storyteller server.
2. **Play** — a third "Read-Along" button on the item detail page (alongside
   Play and Read) that opens a reader which renders the EPUB, plays its embedded
   audio, and highlights the current sentence in time.

## Constraints

- **Limited spread on existing code** so upstream merges stay easy to resolve.
  The feature is overwhelmingly additive (new files); existing files get only
  small, localized edits. This rule may be broken where unavoidable.
- **Do not reimplement Storyteller.** Forced alignment (Whisper transcription +
  fuzzy text matching) is delegated to a Storyteller server. ABS only
  orchestrates generation and consumes the result.

## Key facts (researched)

- Storyteller outputs a **single EPUB 3 file with Media Overlays (SMIL)**. The
  audio and the text↔time mapping are baked into the EPUB; no live Storyteller
  server is needed at *playback* time.
- Storyteller exposes a REST API under `/api/v2/...` with token auth (used at
  *generation* time).
- ABS renders ebooks with `epub.js` 0.3.88 (`client/components/readers/EpubReader.vue`),
  which has **no** media-overlay/audio support. The read-along reader is a new,
  separate component; `EpubReader.vue` is left untouched.
- ABS already serves ebook bytes via `GET /api/items/:id/ebook/:fileid?` — reused
  as-is by the player.
- ABS has a `TaskManager` (`server/managers/TaskManager.js`) for visible
  background jobs, and per-library `settings` on the `Library` model — both
  reused.
- The import attaches a matched ebook to an audiobook in
  `executePendingImport()` (`server/utils/importExecutor.js`), assigning
  `target.media.ebookFile`. This is the generation hook point.

## Architecture

```
GENERATION (import time)
  import folder match
    └─ executePendingImport()  [server/utils/importExecutor.js]
         └─ ebook attached as media.ebookFile
              └─ ImportController.approve(): if library.settings.storyteller.enabled
                   └─ TaskManager task → generateReadAlong()  [server/utils/storytellerSync.js]
                        ├─ auth to Storyteller
                        ├─ create book, upload epub + audio file(s)
                        ├─ trigger processing, poll until done
                        ├─ download synced media-overlay EPUB
                        ├─ write file beside the original, swap media.ebookFile + libraryFiles
                        └─ book.save(), socket emit item_updated

PLAYBACK (detail page)
  "Read-Along" button  [client/pages/item/_id/index.vue]
    └─ store.showEReader({ libraryItem, keepProgress, mode: 'readalong' })
         └─ Reader.vue: mode === 'readalong' && epub → readers-storyteller-reader
              └─ StorytellerReader.vue
                   ├─ load EPUB via GET /api/items/:id/ebook (existing endpoint)
                   ├─ read OPF from epub.js archive → manifest items with media-overlay
                   ├─ parseSmil(xml) → timeline[{ textSrc, audioSrc, clipBegin, clipEnd }]
                   ├─ extract embedded audio from archive as blob URLs
                   └─ on audio timeupdate: highlight active par in rendered iframe,
                      rendition.display(href#id) to auto-page, controls (play/pause/seek/speed)
```

## Components

### New files

- **`server/utils/storytellerSync.js`**
  - `generateReadAlong(libraryItem, library, task)` — orchestrates the Storyteller
    round-trip and swaps in the synced EPUB. Non-destructive on failure.
  - A thin REST client seam (auth, createBook, uploadAsset, process, pollStatus,
    download) so it can be exercised against a fake in tests.
- **`client/components/readers/StorytellerReader.vue`**
  - Reuses `epub.js` for rendering (same load path as `EpubReader.vue`), adds the
    SMIL + single-`<audio>` playback layer, highlight, auto-paging, and controls.
- **`client/components/readers/storytellerSmil.js`**
  - `parseSmil(xml) → timeline[]` — pure function, unit-tested. The only piece of
    non-trivial logic that can fail silently.

### Modified files (small, localized)

- **`server/models/Library.js`** — add settings block:
  ```js
  storyteller: { enabled: false, url: null, token: null }
  ```
- **`server/controllers/ImportController.js`** — after `executePendingImport`
  returns `imported`, if `library.settings.storyteller.enabled`, create a
  `TaskManager` task and call `generateReadAlong` fire-and-forget (~6 lines).
- **`client/components/modals/libraries/LibrarySettings.vue`** — book-library-only
  enable toggle + Storyteller URL + token inputs.
- **`client/store/index.js`** — `showEReader` mutation accepts optional `mode`.
- **`client/components/readers/Reader.vue`** — when `mode === 'readalong'` and the
  ebook is epub, render `readers-storyteller-reader`.
- **`client/pages/item/_id/index.vue`** — "Read-Along" button (shown when an epub
  ebook exists) + `openReadAlong()` method.
- **`client/strings/en-us.json`** — button + settings + task strings.
- Register a Task action/label for the generation job (i18n key).

### Unchanged

- `EpubReader.vue` and the other readers — untouched.
- The ebook-serving endpoint — reused as-is. No new server routes.

## Data flow detail (playback)

1. Click **Read-Along** → `showEReader({ mode: 'readalong' })`.
2. `StorytellerReader` loads the EPUB (existing arraybuffer fetch).
3. Read the OPF from `book.archive`; find manifest items carrying a
   `media-overlay` attribute → their SMIL hrefs.
4. `parseSmil` turns each SMIL into an ordered timeline of
   `{ textSrc: "doc.xhtml#id", audioSrc, clipBegin, clipEnd }`.
5. Extract the embedded audio file(s) from the archive as blob URLs; one
   `<audio>` element, `src` swapped at chapter boundaries.
6. On `timeupdate`, find the active `par`, add a highlight class to that element
   inside the rendered iframe (`rendition.getContents()`), and
   `rendition.display(href#id)` when the sentence crosses into a new section.
   Tap a sentence → seek audio to its `clipBegin`.

## Error handling

- **Storyteller disabled / no URL** — generation skipped silently; ebook imports
  exactly as today.
- **Generation failure** (Storyteller down, alignment error, bad response) — the
  Task is marked failed; the **original ebook is left untouched**. Re-import
  retries. Never partially overwrites the existing ebook.
- **EPUB without media overlays** at playback — the reader shows "No read-along
  data in this ebook" and offers to open it in the normal reader. This keeps
  read-along detection out of the scanner/model (no server-side flag needed).

## Known ceilings (deliberate v1 simplifications)

Marked with `ponytail:` comments in code.

- **Large EPUBs** — synced EPUBs embed hours of audio (hundreds of MB+). Both the
  generation upload and the player's whole-file load are memory/bandwidth heavy.
  v1 accepts this. Upgrade path: streamed upload + range-request audio out of the
  zip.
- **Token in DB** — the Storyteller auth token is stored in library settings
  (server-side). Acceptable for self-hosted; flagged.
- **No listening-progress sync** — v1 keeps text-location progress locally
  (existing `keepProgress`); it does not write audiobook listening stats back to
  the server.

## Out of scope (v1)

- "Read-Along" button on bookshelf cards (detail page only for v1).
- Manual "regenerate read-along" action for already-imported items.
- In-ABS forced alignment (delegated to Storyteller, always).
- Progress/stat sync between the read-along session and ABS media progress.

## Open item to pin during planning

The exact **Storyteller v2 REST endpoints and auth flow** (create book, upload
ebook, upload audio, trigger processing, poll status, download synced EPUB). To
be confirmed against Storyteller's API reference / OpenAPI when writing the
implementation plan, rather than guessed here.

## Testing

- Unit test for `parseSmil` (SMIL XML → timeline array) — the one piece of
  silently-breakable logic.
- The Storyteller client's seam allows `generateReadAlong` to be exercised
  against a fake server response without a live Storyteller instance.
