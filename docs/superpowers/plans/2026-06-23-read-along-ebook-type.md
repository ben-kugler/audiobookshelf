# Read-Along Ebook Type Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Treat a `*.readaloud.epub` / `*.readalong.epub` / `* (readaloud).epub` as a distinct **read-along** supplementary ebook so the primary ebook is never touched and the Read-Along button targets the read-along file.

**Architecture:** Detect read-along ebooks by filename in the scanner; carry an `isReadAlong` flag on the `LibraryFile` (so it survives serialization to the client); the item page's Read-Along button opens the flagged file by `ino` (Reader.vue already supports supplementary-ebook fileId); the import-hook generator registers the synced EPUB as a read-along supplementary file instead of swapping `ebookFile`.

**Tech Stack:** Node server (Sequelize models, Mocha/Chai tests under `test/server/`), Vue 2 / Nuxt 2 client.

## Global Constraints

- Additive, merge-friendly: small localized edits to existing files; no refactors.
- Server tests live under `test/server/` and run from repo root via `npx mocha <path>` (config `{recursive:true}`). The repo has **no ESLint**; use `node --check` for server syntax.
- The primary ebook (`Book.ebookFile`) must never be changed by this feature.
- Read-along detection is by filename, case-insensitive: an `.epub` whose name contains `readaloud` or `readalong`.
- Do NOT `git add -A` — stage only each task's named files.
- Reader.vue is intentionally NOT modified (it already derives `ebookFormat` from a supplementary file's extension).

---

## File Structure

**New files**
- `server/utils/readAlong.js` — `isReadAlongEbookFilename(filename)` (pure).
- `test/server/utils/readAlong.test.js` — unit test.
- `test/server/objects/LibraryFile.test.js` — round-trip test for the new field.

**Modified files**
- `server/objects/files/LibraryFile.js` — carry `isReadAlong`.
- `server/scanner/BookScanner.js` — exclude read-along from primary; flag read-along files.
- `client/pages/item/_id/index.vue` — `readAlongFile` computed; button + `openReadAlong` target it.
- `client/components/tables/EbookFilesTableRow.vue` — "Read-along" badge.
- `client/strings/en-us.json` — `LabelReadAlong`.
- `server/utils/storytellerSync.js` — register read-along supplementary instead of swapping `ebookFile`.

---

### Task 1: `isReadAlongEbookFilename` helper (pure, TDD)

**Files:**
- Create: `server/utils/readAlong.js`
- Test: `test/server/utils/readAlong.test.js`

**Interfaces:**
- Produces: `isReadAlongEbookFilename(filename: string) => boolean` — true for an `.epub` whose (lower-cased) filename contains `readaloud` or `readalong`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/server/utils/readAlong.test.js
const { expect } = require('chai')
const { isReadAlongEbookFilename } = require('../../../server/utils/readAlong')

describe('isReadAlongEbookFilename', () => {
  it('matches our generated .readalong.epub', () => {
    expect(isReadAlongEbookFilename('Some Book.readalong.epub')).to.equal(true)
  })
  it('matches Storyteller (readaloud).epub', () => {
    expect(isReadAlongEbookFilename('Some Book (readaloud).epub')).to.equal(true)
  })
  it('matches .readaloud.epub', () => {
    expect(isReadAlongEbookFilename('Some Book.readaloud.epub')).to.equal(true)
  })
  it('is case-insensitive', () => {
    expect(isReadAlongEbookFilename('BOOK (READALOUD).EPUB')).to.equal(true)
  })
  it('does not match a plain epub', () => {
    expect(isReadAlongEbookFilename('Some Book.epub')).to.equal(false)
  })
  it('does not match a non-epub even if it contains readalong', () => {
    expect(isReadAlongEbookFilename('readalong-notes.txt')).to.equal(false)
  })
  it('handles null/undefined', () => {
    expect(isReadAlongEbookFilename(null)).to.equal(false)
    expect(isReadAlongEbookFilename(undefined)).to.equal(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/server/utils/readAlong.test.js`
Expected: FAIL — cannot find module `../../../server/utils/readAlong`.

- [ ] **Step 3: Write the implementation**

```javascript
// server/utils/readAlong.js
/**
 * Identify a read-along ebook by filename. Matches our generated
 * "<base>.readalong.epub" and Storyteller's "<title> (readaloud).epub"
 * (and ".readaloud.epub"). Case-insensitive; .epub only.
 *
 * ponytail: filename heuristic (no EPUB/zip parsing). A real book whose
 * title literally contains "readalong"/"readaloud" would false-positive;
 * acceptable for v1.
 *
 * @param {string} filename
 * @returns {boolean}
 */
function isReadAlongEbookFilename(filename) {
  if (!filename) return false
  const lower = String(filename).toLowerCase()
  if (!lower.endsWith('.epub')) return false
  return lower.includes('readaloud') || lower.includes('readalong')
}

module.exports = { isReadAlongEbookFilename }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx mocha test/server/utils/readAlong.test.js`
Expected: PASS (7 passing).

- [ ] **Step 5: Commit**

```bash
git add server/utils/readAlong.js test/server/utils/readAlong.test.js
git commit -m "feat: add read-along ebook filename detection"
```

---

### Task 2: Carry `isReadAlong` on LibraryFile

**Files:**
- Modify: `server/objects/files/LibraryFile.js:6-36`
- Test: `test/server/objects/LibraryFile.test.js`

**Interfaces:**
- Produces: `LibraryFile` instances expose `isReadAlong` (default `null`), and `toJSON()` includes `isReadAlong`. This is required because `LibraryItem.getLibraryFilesJson()` routes every file through `new LibraryFile(lf).toJSON()` — a raw key would be dropped before reaching the client.

- [ ] **Step 1: Write the failing test**

```javascript
// test/server/objects/LibraryFile.test.js
const { expect } = require('chai')
const LibraryFile = require('../../../server/objects/files/LibraryFile')

describe('LibraryFile isReadAlong', () => {
  it('defaults isReadAlong to null', () => {
    const lf = new LibraryFile({ ino: '1', metadata: { filename: 'a.epub', ext: '.epub', path: '/a.epub', relPath: '/a.epub' } })
    expect(lf.isReadAlong).to.equal(null)
    expect(lf.toJSON()).to.have.property('isReadAlong', null)
  })
  it('preserves isReadAlong through construct + toJSON', () => {
    const lf = new LibraryFile({ ino: '1', isReadAlong: true, metadata: { filename: 'a.readalong.epub', ext: '.epub', path: '/a.readalong.epub', relPath: '/a.readalong.epub' } })
    expect(lf.isReadAlong).to.equal(true)
    expect(lf.toJSON().isReadAlong).to.equal(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/server/objects/LibraryFile.test.js`
Expected: FAIL — `isReadAlong` is undefined (not on the instance / not in toJSON).

- [ ] **Step 3: Edit LibraryFile.js**

In `server/objects/files/LibraryFile.js`, add the field in three places.

Constructor (after `this.isSupplementary = null`):
```javascript
    this.isSupplementary = null
    this.isReadAlong = null
```

`construct(file)` (after the `isSupplementary` line):
```javascript
    this.isSupplementary = file.isSupplementary === undefined ? null : file.isSupplementary
    this.isReadAlong = file.isReadAlong === undefined ? null : file.isReadAlong
```

`toJSON()` (add the key):
```javascript
  toJSON() {
    return {
      ino: this.ino,
      metadata: this.metadata.toJSON(),
      isSupplementary: this.isSupplementary,
      isReadAlong: this.isReadAlong,
      addedAt: this.addedAt,
      updatedAt: this.updatedAt,
      fileType: this.fileType
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx mocha test/server/objects/LibraryFile.test.js`
Expected: PASS (2 passing).

- [ ] **Step 5: Commit**

```bash
git add server/objects/files/LibraryFile.js test/server/objects/LibraryFile.test.js
git commit -m "feat: carry isReadAlong on LibraryFile"
```

---

### Task 3: Scanner — exclude read-along from primary and flag it

**Files:**
- Modify: `server/scanner/BookScanner.js` (imports; `rescanLibraryItemMedia` ~199-200 and ~410-422; `scanNewBookLibraryItem` ~450 and ~535-539)

**Interfaces:**
- Consumes: `isReadAlongEbookFilename` (Task 1); `LibraryFile.isReadAlong` (Task 2).
- Produces: ebook `libraryFiles` carry `isReadAlong = true` when the filename matches; read-along files are never selected as the primary `ebookFile` unless they are the only ebook present.

- [ ] **Step 1: Add the import**

At the top of `server/scanner/BookScanner.js`, with the other `require`s, add:
```javascript
const { isReadAlongEbookFilename } = require('../utils/readAlong')
```

- [ ] **Step 2: Existing-item primary selection — exclude read-along (lines ~197-207)**

Replace the block:
```javascript
    // Check if ebook is not set and ebooks were found
    if (!media.ebookFile && !librarySettings.audiobooksOnly && libraryItemData.ebookLibraryFiles.length) {
      // Prefer to use an epub ebook then fallback to the first ebook found
      let ebookLibraryFile = libraryItemData.ebookLibraryFiles.find((lf) => lf.metadata.ext.slice(1).toLowerCase() === 'epub')
      if (!ebookLibraryFile) ebookLibraryFile = libraryItemData.ebookLibraryFiles[0]
      ebookLibraryFile = ebookLibraryFile.toJSON()
```
with:
```javascript
    // Check if ebook is not set and ebooks were found
    if (!media.ebookFile && !librarySettings.audiobooksOnly && libraryItemData.ebookLibraryFiles.length) {
      // Prefer a non-read-along ebook (prefer epub); fall back to read-along only if it is the only ebook
      const nonReadAlong = libraryItemData.ebookLibraryFiles.filter((lf) => !isReadAlongEbookFilename(lf.metadata.filename))
      const pool = nonReadAlong.length ? nonReadAlong : libraryItemData.ebookLibraryFiles
      let ebookLibraryFile = pool.find((lf) => lf.metadata.ext.slice(1).toLowerCase() === 'epub')
      if (!ebookLibraryFile) ebookLibraryFile = pool[0]
      ebookLibraryFile = ebookLibraryFile.toJSON()
```

- [ ] **Step 3: Existing-item supplementary loop — also set isReadAlong (lines ~409-422)**

Replace:
```javascript
    // Check/update the isSupplementary flag on libraryFiles for the LibraryItem
    for (const libraryFile of existingLibraryItem.libraryFiles) {
      if (globals.SupportedEbookTypes.includes(libraryFile.metadata.ext.slice(1).toLowerCase())) {
        if (media.ebookFile && libraryFile.ino === media.ebookFile.ino) {
          if (libraryFile.isSupplementary !== false) {
            libraryFile.isSupplementary = false
            libraryItemUpdated = true
          }
        } else if (libraryFile.isSupplementary !== true) {
          libraryFile.isSupplementary = true
          libraryItemUpdated = true
        }
      }
    }
```
with:
```javascript
    // Check/update the isSupplementary + isReadAlong flags on libraryFiles for the LibraryItem
    for (const libraryFile of existingLibraryItem.libraryFiles) {
      if (globals.SupportedEbookTypes.includes(libraryFile.metadata.ext.slice(1).toLowerCase())) {
        if (media.ebookFile && libraryFile.ino === media.ebookFile.ino) {
          if (libraryFile.isSupplementary !== false) {
            libraryFile.isSupplementary = false
            libraryItemUpdated = true
          }
        } else if (libraryFile.isSupplementary !== true) {
          libraryFile.isSupplementary = true
          libraryItemUpdated = true
        }
        const isReadAlong = isReadAlongEbookFilename(libraryFile.metadata.filename)
        if (libraryFile.isReadAlong !== isReadAlong) {
          libraryFile.isReadAlong = isReadAlong
          libraryItemUpdated = true
        }
      }
    }
```

- [ ] **Step 4: New-item primary selection — exclude read-along (line ~450)**

Replace:
```javascript
    // Find ebook file (prefer epub)
    let ebookLibraryFile = librarySettings.audiobooksOnly ? null : libraryItemData.ebookLibraryFiles.find((lf) => lf.metadata.ext.slice(1).toLowerCase() === 'epub') || libraryItemData.ebookLibraryFiles[0]
```
with:
```javascript
    // Find ebook file (prefer a non-read-along epub; fall back to read-along only if it is the only ebook)
    let ebookLibraryFile = null
    if (!librarySettings.audiobooksOnly && libraryItemData.ebookLibraryFiles.length) {
      const nonReadAlong = libraryItemData.ebookLibraryFiles.filter((lf) => !isReadAlongEbookFilename(lf.metadata.filename))
      const pool = nonReadAlong.length ? nonReadAlong : libraryItemData.ebookLibraryFiles
      ebookLibraryFile = pool.find((lf) => lf.metadata.ext.slice(1).toLowerCase() === 'epub') || pool[0]
    }
```

- [ ] **Step 5: New-item supplementary loop — also set isReadAlong (lines ~534-539)**

Replace:
```javascript
    // Set isSupplementary flag on ebook library files
    for (const libraryFile of libraryItemObj.libraryFiles) {
      if (globals.SupportedEbookTypes.includes(libraryFile.metadata.ext.slice(1).toLowerCase())) {
        libraryFile.isSupplementary = libraryFile.ino !== ebookLibraryFile?.ino
      }
    }
```
with:
```javascript
    // Set isSupplementary + isReadAlong flags on ebook library files
    for (const libraryFile of libraryItemObj.libraryFiles) {
      if (globals.SupportedEbookTypes.includes(libraryFile.metadata.ext.slice(1).toLowerCase())) {
        libraryFile.isSupplementary = libraryFile.ino !== ebookLibraryFile?.ino
        libraryFile.isReadAlong = isReadAlongEbookFilename(libraryFile.metadata.filename)
      }
    }
```

- [ ] **Step 6: Syntax check**

Run: `node --check server/scanner/BookScanner.js`
Expected: no output (valid).

- [ ] **Step 7: Commit**

```bash
git add server/scanner/BookScanner.js
git commit -m "feat: detect read-along ebooks during scan, keep them out of primary"
```

---

### Task 4: Client — Read-Along button targets the read-along file + badge

**Files:**
- Modify: `client/pages/item/_id/index.vue` (`showReadAlongButton` ~244-247, `openReadAlong` ~512-514, add `readAlongFile` computed near `ebookFiles` ~312)
- Modify: `client/components/tables/EbookFilesTableRow.vue:1-5,52-54`
- Modify: `client/strings/en-us.json`

**Interfaces:**
- Consumes: `libraryFiles[*].isReadAlong` (Tasks 2/3); the store `showEReader` mutation already accepts `{ mode, fileId }`; Reader.vue already loads a supplementary ebook by `fileId`.

- [ ] **Step 1: Add `readAlongFile` computed and update the button gate**

In `client/pages/item/_id/index.vue`, add a computed next to `ebookFiles()` (~line 314):
```javascript
    readAlongFile() {
      return this.ebookFiles.find((lf) => lf.isReadAlong) || null
    },
```

Replace `showReadAlongButton()` (~244-247):
```javascript
    showReadAlongButton() {
      const ef = this.ebookFile
      return ef && ef.ebookFormat === 'epub'
    },
```
with:
```javascript
    showReadAlongButton() {
      return !!this.readAlongFile
    },
```

- [ ] **Step 2: Open the read-along file by id**

Replace `openReadAlong()` (~512-514):
```javascript
    openReadAlong() {
      this.$store.commit('showEReader', { libraryItem: this.libraryItem, keepProgress: true, mode: 'readalong' })
    },
```
with:
```javascript
    openReadAlong() {
      this.$store.commit('showEReader', { libraryItem: this.libraryItem, keepProgress: true, mode: 'readalong', fileId: this.readAlongFile?.ino })
    },
```

- [ ] **Step 3: Add the "Read-along" badge to the files table row**

In `client/components/tables/EbookFilesTableRow.vue`, replace the first `<td>` (lines 3-5):
```html
    <td class="px-4">
      {{ showFullPath ? file.metadata.path : file.metadata.relPath }} <ui-tooltip :text="$strings.LabelPrimaryEbook" class="inline-block"><span v-if="isPrimary" class="material-symbols text-success align-text-bottom">check_circle</span></ui-tooltip>
    </td>
```
with:
```html
    <td class="px-4">
      {{ showFullPath ? file.metadata.path : file.metadata.relPath }} <ui-tooltip :text="$strings.LabelPrimaryEbook" class="inline-block"><span v-if="isPrimary" class="material-symbols text-success align-text-bottom">check_circle</span></ui-tooltip>
      <span v-if="isReadAlong" class="inline-block ml-1 px-1.5 py-0.5 rounded text-xs bg-warning/20 text-warning align-middle">{{ $strings.LabelReadAlong }}</span>
    </td>
```

Add an `isReadAlong` computed next to `isPrimary` (lines 52-54):
```javascript
    isPrimary() {
      return !this.file.isSupplementary
    },
    isReadAlong() {
      return !!this.file.isReadAlong
    },
```

- [ ] **Step 4: Add the string**

In `client/strings/en-us.json`, add (alphabetical near other `LabelRead*` keys):
```json
  "LabelReadAlong": "Read-along",
```

- [ ] **Step 5: Verify**

Run: `node -e "JSON.parse(require('fs').readFileSync('client/strings/en-us.json','utf8')); console.log('json OK')"`
Expected: `json OK`. Read back the two `.vue` edits to confirm they are well-formed (button gate, computed, badge).

- [ ] **Step 6: Commit**

```bash
git add client/pages/item/_id/index.vue client/components/tables/EbookFilesTableRow.vue client/strings/en-us.json
git commit -m "feat: Read-Along button targets read-along ebook + table badge"
```

---

### Task 5: Generation hook registers read-along instead of swapping ebookFile

**Files:**
- Modify: `server/utils/storytellerSync.js:64-97`

**Interfaces:**
- Consumes: `LibraryFile.isReadAlong` (Task 2).
- Produces: `generateReadAlong` adds the synced EPUB as a `libraryFiles` entry with `isSupplementary: true, isReadAlong: true` and leaves `media.ebookFile` untouched.

- [ ] **Step 1: Replace the ebookFile-swap + libraryFiles block**

In `server/utils/storytellerSync.js`, replace everything from the `const stat = await fs.promises.stat(destPath)` line through `await libraryItem.save()` (lines ~64-97) with:

```javascript
  // Register the synced EPUB as a read-along supplementary file.
  // The primary ebook (media.ebookFile) is intentionally left untouched.
  const newLF = new LibraryFile()
  await newLF.setDataFromPath(destPath, relPath)
  const readAlongEntry = { ...newLF.toJSON(), isSupplementary: true, isReadAlong: true }

  // Replace any stale entry for the same path, then append.
  libraryItem.libraryFiles = [...libraryItem.libraryFiles.filter((lf) => lf.metadata?.path !== readAlongEntry.metadata.path), readAlongEntry]
  libraryItem.changed('libraryFiles', true)
  await libraryItem.save()
```

The lines that compute `relPath` (the `folder`/`folderPath`/`relPath` block) stay as-is above this. Delete the now-unused `const stat`, `const filename`, `const ext`, and the entire `libraryItem.media.ebookFile = {...}` / `libraryItem.media.changed('ebookFile', true)` block, and the old `newLF` append block that set `isSupplementary: false`.

The final tail of `generateReadAlong` should read:
```javascript
  await client.downloadSynced(bookUuid, tmpPath)
  await fs.promises.rename(tmpPath, destPath)

  // compute relPath relative to the library folder (same convention as importExecutor.js:64-68)
  const folder = library.libraryFolders?.find((f) => f.id === libraryItem.libraryFolderId)
  const folderPath = folder?.path || ''
  const relPath = destPath.startsWith(folderPath) ? destPath.replace(folderPath, '') : '/' + Path.basename(destPath)

  // Register the synced EPUB as a read-along supplementary file.
  // The primary ebook (media.ebookFile) is intentionally left untouched.
  const newLF = new LibraryFile()
  await newLF.setDataFromPath(destPath, relPath)
  const readAlongEntry = { ...newLF.toJSON(), isSupplementary: true, isReadAlong: true }

  libraryItem.libraryFiles = [...libraryItem.libraryFiles.filter((lf) => lf.metadata?.path !== readAlongEntry.metadata.path), readAlongEntry]
  libraryItem.changed('libraryFiles', true)
  await libraryItem.save()

  SocketAuthority.libraryItemEmitter('item_updated', libraryItem)
  Logger.info(`[Storyteller] Read-along generated for "${libraryItem.media.title}" → ${destPath}`)
}
```

(The `fs` import is still used by `downloadSynced`/`rename`; keep it.)

- [ ] **Step 2: Syntax + require check**

Run:
```bash
node --check server/utils/storytellerSync.js
node -e "require('./server/utils/storytellerSync'); console.log('require OK')"
```
Expected: no syntax error; `require OK`.

- [ ] **Step 3: Sanity — existing Storyteller client test still passes**

Run: `npx mocha test/server/utils/storytellerClient.test.js`
Expected: 9 passing.

- [ ] **Step 4: Commit**

```bash
git add server/utils/storytellerSync.js
git commit -m "feat: generation registers read-along supplementary instead of swapping ebook"
```

---

## Self-Review

**Spec coverage:**
- Detection by filename pattern → Task 1. ✅
- `isReadAlong` survives serialization → Task 2 (LibraryFile field). ✅
- Scanner: exclude from primary + flag → Task 3. ✅
- Read-Along button targets the flagged file; primary ebook untouched → Task 4 (+ Reader.vue already supports fileId). ✅
- "Read-along" badge in files table → Task 4. ✅
- Generation registers read-along instead of swapping ebookFile → Task 5. ✅
- Edge case (read-along is the only ebook → not dropped) → Task 3 `pool` fallback. ✅
- Unit test for the pure helper → Task 1. ✅

**Placeholder scan:** No TBD/placeholder steps; every code step shows the code.

**Type consistency:** `isReadAlong` (boolean/null) used identically across LibraryFile (Task 2), scanner (Task 3), client `lf.isReadAlong` (Task 4), and generation (Task 5). `readAlongFile` computed name consistent in Task 4. `isReadAlongEbookFilename` signature consistent between Task 1 and Task 3.

## Notes for the implementer

- Reader.vue is deliberately untouched: `Reader.vue:246-259` already returns the supplementary libraryFile for a passed `fileId` and derives `ebookFormat` from its extension, so `componentName()` resolves to `readers-storyteller-reader` for the read-along epub.
- The generated filename in `storytellerSync.js` is `<base>.readalong.epub`; Storyteller's manual output is `<title> (readaloud).epub`. Task 1's helper matches both spellings.
