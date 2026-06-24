# Read-Along as a Supplementary Ebook Type

**Date:** 2026-06-23
**Branch:** reorganize-files
**Status:** Approved design
**Builds on:** `2026-06-23-storyteller-read-along-design.md`

## Goal

Make the synced read-along EPUB a distinct **supplementary ebook type** rather
than replacing the book's primary ebook. A book can then carry, at once:

- a **primary ebook** (`Book.epub`) → the existing **Read** button,
- a **read-along ebook** (`*.readaloud.epub` / `* (readaloud).epub`) → the
  **Read-Along** button,
- other supplementary ebooks → unchanged.

The primary ebook is never altered. The Read-Along button targets the
read-along file specifically.

## Motivation

The original design swapped `Book.ebookFile` to point at the synced EPUB. That
loses the plain ebook and fights ABS's sticky-`ebookFile` scan behavior — a
manually-produced `(readaloud).epub` lands as *supplementary* and the
Read-Along button (which read `ebookFile`) kept opening the original (no media
overlays). Treating read-along as its own supplementary type fixes both: the
plain ebook stays primary, and Read-Along always finds the right file.

## Key facts (from code)

- `BookScanner.js` selects the primary ebook preferring `epub`, else the first
  ebook file (`~444-450` new items, `~196-207` existing). `ebookFile` is
  **sticky** across rescans — a new ebook in the folder becomes supplementary,
  not primary.
- Supplementary ebooks are marked in `libraryFiles` with
  `isSupplementary = (ino !== primary.ino)` (`~534-539`, `~410-422`).
- `GET /api/items/:id/ebook/:fileid` already serves any ebook `libraryFile` by
  ino, including supplementary ones (`LibraryItemController.getEBookFile`).
- `StorytellerReader.vue` already accepts a `fileId` prop and loads
  `/api/items/:id/ebook/:fileId`.
- The item page renders `tables-ebook-files-table` when `ebookFiles.length`
  (`item/_id/index.vue:142`); each row has a context menu
  (`EbookFilesTableRow.vue`).

## Detection — filename pattern

A read-along ebook is identified by filename, not by parsing the EPUB:

```
isReadAlongEbookFilename(filename):
  lower = filename.toLowerCase()
  return lower.endsWith('.readaloud.epub') || /\(readaloud\)\.epub$/.test(lower)
```

Covers our generated `<base>.readaloud.epub` and Storyteller's
`<title> (readaloud).epub`. No EPUB/zip I/O added to scans.

## Architecture / components

### Scanner — `server/scanner/BookScanner.js`
1. Add `isReadAlongEbookFilename(filename)` (module-local helper or in
   `globals`/`fileUtils`).
2. **Primary-ebook selection** (both new-item and existing-item branches):
   exclude read-along files from the primary candidate set, so a `(readaloud)`
   epub can never be chosen as the primary ebook. Prefer a non-read-along
   `epub`, else first non-read-along ebook.
3. **Supplementary marking loop**: in addition to `isSupplementary`, set
   `libraryFile.isReadAlong = isReadAlongEbookFilename(libraryFile.metadata.filename)`
   on ebook library files. This persists in the `libraryFiles` JSON and reaches
   the client.

### Client — item page `client/pages/item/_id/index.vue`
- `readAlongFile()` computed: `libraryFiles.find(lf => lf.isEBookFile && lf.isReadAlong)`.
- `showReadAlongButton()` → `!!readAlongFile`.
- `openReadAlong()` → `showEReader({ libraryItem, keepProgress: true, mode: 'readalong', fileId: readAlongFile.ino })`.

### Client — reader dispatch `client/components/readers/Reader.vue`
- In read-along mode, render `readers-storyteller-reader` based on the
  read-along file being an epub, independent of whether the *primary* ebook is
  epub (so audiobook-only items with only a read-along epub still work). The
  reader receives the read-along `fileId` (already plumbed via `ereaderFileId`).

### Generation hook — `server/utils/storytellerSync.js`
- `generateReadAlong` no longer swaps `media.ebookFile`. It writes
  `<base>.readaloud.epub` and registers it as a `libraryFiles` entry with
  `isSupplementary: true, isReadAlong: true`, leaving the primary ebook intact.
  (Build the `LibraryFile` the same way as before; just set the flags and do not
  touch `media.ebookFile`.)

### UI — `client/components/tables/EbookFilesTable.vue` / `EbookFilesTableRow.vue`
- Show a small **"Read-along"** badge on the row where `isReadAlong` is true, so
  the new type is visible. No new row action required (detection is automatic).

### Strings — `client/strings/en-us.json`
- One label, e.g. `LabelReadAlong: "Read-along"` for the badge.

## Data flow

```
scan: Book (readaloud).epub
   └─ BookScanner: not chosen as primary; libraryFile.isReadAlong = true, isSupplementary = true
        └─ libraryFiles (JSON) → client
             └─ item page: readAlongFile = that file
                  └─ Read-Along button → showEReader(mode:'readalong', fileId: readAlongFile.ino)
                       └─ StorytellerReader loads /api/items/:id/ebook/:fileId (the read-along epub)
                            └─ media overlays → synced highlighting
```

Generation path:
```
import match → generateReadAlong → write <base>.readaloud.epub
   → add libraryFiles entry { isSupplementary:true, isReadAlong:true }  (ebookFile untouched)
   → save → socket item_updated
```

## Edge cases

- **Audiobook-only item with just a read-along epub** (no primary ebook):
  Read-Along works (loads by `fileId`); the normal Read button stays hidden.
- **`(readaloud).epub` present but no plain ebook**: read-along works, Read
  hidden; primary-selection exclusion leaves `ebookFile` null, which is fine.
- **Both a plain epub and a read-along epub**: plain stays primary (Read),
  read-along drives Read-Along.
- **Rescan**: `isReadAlong` is recomputed from the filename each scan — stable.

## Out of scope

- Manual "set as read-along" UI action (detection is automatic; could add
  later).
- Media-overlay-based detection (filename pattern chosen for cost).

## Testing

- Unit-test `isReadAlongEbookFilename` (the one piece of pure logic):
  `.readaloud.epub` → true, `(readaloud).epub` → true, `book.epub` → false,
  case-insensitive. Server Mocha test under `test/server/`.
- Manual: a folder with `book.epub` + `book (readaloud).epub` → scan → item
  shows both, Read opens plain, Read-Along opens the synced one.
