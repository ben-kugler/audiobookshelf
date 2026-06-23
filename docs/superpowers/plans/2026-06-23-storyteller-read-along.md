# Storyteller Read-Along Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Storyteller read-along to this Audiobookshelf fork — generate a synced media-overlay EPUB at import time by delegating alignment to a Storyteller server, and play it back with a new "Read-Along" button that highlights the current sentence in time with the narration.

**Architecture:** Two halves. (1) Playback: a new `StorytellerReader.vue` reuses `epub.js` to render the EPUB, reads its EPUB 3 Media Overlay (SMIL) data, plays the embedded audio, and highlights/auto-pages in sync. (2) Generation: after the existing import-folder match attaches an ebook to an audiobook, a fire-and-forget `TaskManager` job calls a Storyteller server (shared-filesystem path import → process → poll → download synced EPUB) and swaps the result in as the book's `ebookFile`. Everything is additive except small, localized edits to existing files.

**Tech Stack:** Vue 2 / Nuxt 2 client, `epub.js` 0.3.88, Node.js server (Sequelize models, native `fetch`), Storyteller v2 REST API.

## Global Constraints

- **Limited spread on existing code** — feature is additive (new files); existing files get only small localized edits. Merge-friendliness with upstream is a first-class requirement.
- **Never reimplement alignment** — Whisper/forced-alignment is delegated to Storyteller. ABS only orchestrates and consumes.
- **Generation is non-destructive** — on any Storyteller failure, the original `ebookFile` is left untouched.
- **Combo button: detail page only** in v1 (not bookshelf cards).
- **No new server routes** — playback reuses `GET /api/items/:id/ebook/:fileid?`.
- Mark deliberate v1 simplifications with `ponytail:` comments.
- Storyteller v2 API base path is `/api/v2`; the aligned-EPUB download uses the (deprecated but functional) `GET /api/books/:bookId/synced`.

---

## File Structure

**New files**
- `client/components/readers/storytellerSmil.js` — pure `parseSmil(xml)` → timeline. Unit-tested.
- `client/components/readers/StorytellerReader.vue` — the read-along player.
- `client/components/readers/__tests__/storytellerSmil.spec.js` — unit test (Jest; client already uses Jest).
- `server/utils/storytellerClient.js` — thin Storyteller v2 REST client. Response-parsing unit-tested.
- `server/utils/storytellerSync.js` — `generateReadAlong(libraryItem, library, task)` orchestration.
- `server/test/utils/storytellerClient.test.js` — unit test (Mocha/Chai; server already uses these).

**Modified files (small)**
- `server/models/Library.js` — add `storyteller` settings block.
- `server/controllers/ImportController.js` — post-import generation hook.
- `client/components/modals/libraries/LibrarySettings.vue` — settings UI.
- `client/store/index.js` — `showEReader` accepts `mode`.
- `client/components/readers/Reader.vue` — render read-along reader when `mode === 'readalong'`.
- `client/pages/item/_id/index.vue` — "Read-Along" button + `openReadAlong()`.
- `client/strings/en-us.json` — UI + task strings.

---

## Storyteller v2 API contract (observed from source — confirm exact JSON field names on first live run)

- **Auth:** `POST {url}/api/token` with `application/x-www-form-urlencoded` body `username`, `password`. Returns the token (string, or object containing it). Use as `Authorization: Bearer <token>` on subsequent calls. The Storyteller user needs `bookCreate`, `bookProcess`, `bookDownload` permissions.
- **Create by path (shared volume):** `POST {url}/api/v2/books` JSON `{ paths: string[], importMode: "reference", epub2Strategy: "backup-and-convert" }`. `paths` = the ebook `.epub` plus the audio file(s); **all audio files must be in one directory**. Server mints a book UUID and scans. If an epub is EPUB2 and `epub2Strategy` is omitted it returns `{ epub2Detected: true, paths }` — we always pass `"backup-and-convert"` to avoid that round-trip.
- **Process (align):** `POST {url}/api/v2/books/:bookId/process` (no body needed). Begins transcription + alignment.
- **Poll:** `GET {url}/api/v2/books/:bookId` → book object. Completion signal: `book.readaloud?.filepath` becomes truthy (the aligned EPUB exists). Poll with an overall timeout.
- **Download aligned EPUB:** `GET {url}/api/books/:bookId/synced` → streams the aligned EPUB (supports range). Stream to a temp file, then move into the ABS item folder.

`ponytail:` poll-by-`readaloud.filepath` with a timeout instead of consuming the `/api/v2/books/events` SSE stream — upgrade to SSE for live progress if needed.

---

### Task 1: SMIL parser (pure, TDD)

**Files:**
- Create: `client/components/readers/storytellerSmil.js`
- Test: `client/components/readers/__tests__/storytellerSmil.spec.js`

**Interfaces:**
- Produces: `parseSmil(xmlString) => Array<{ textSrc: string, audioSrc: string, clipBegin: number, clipEnd: number }>` — `textSrc`/`audioSrc` are the raw `src` attribute values (relative to the SMIL file); `clipBegin`/`clipEnd` are seconds. Also exports `parseClock(value) => number`.

- [ ] **Step 1: Write the failing test**

```javascript
// client/components/readers/__tests__/storytellerSmil.spec.js
import { parseSmil, parseClock } from '../storytellerSmil'

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<smil xmlns="http://www.w3.org/ns/SMIL" xmlns:epub="http://www.idpf.org/2007/ops" version="3.0">
  <body>
    <seq epub:textref="chapter1.xhtml" epub:type="chapter">
      <par><text src="chapter1.xhtml#s1"/><audio src="audio/ch1.mp4" clipBegin="0s" clipEnd="3.5s"/></par>
      <par><text src="chapter1.xhtml#s2"/><audio src="audio/ch1.mp4" clipBegin="3.5s" clipEnd="0:00:08.250"/></par>
    </seq>
  </body>
</smil>`

describe('parseClock', () => {
  it('parses seconds form', () => { expect(parseClock('3.5s')).toBe(3.5) })
  it('parses full clock form', () => { expect(parseClock('0:00:08.250')).toBe(8.25) })
  it('parses bare number as seconds', () => { expect(parseClock('12')).toBe(12) })
})

describe('parseSmil', () => {
  it('returns an ordered timeline of pars', () => {
    const timeline = parseSmil(SAMPLE)
    expect(timeline).toHaveLength(2)
    expect(timeline[0]).toEqual({ textSrc: 'chapter1.xhtml#s1', audioSrc: 'audio/ch1.mp4', clipBegin: 0, clipEnd: 3.5 })
    expect(timeline[1]).toEqual({ textSrc: 'chapter1.xhtml#s2', audioSrc: 'audio/ch1.mp4', clipBegin: 3.5, clipEnd: 8.25 })
  })
  it('returns empty array for SMIL with no pars', () => {
    expect(parseSmil('<smil><body><seq></seq></body></smil>')).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx jest storytellerSmil`
Expected: FAIL — `Cannot find module '../storytellerSmil'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// client/components/readers/storytellerSmil.js
// Parses an EPUB 3 Media Overlay (SMIL) document into an ordered timeline.
// Pure + DOM-free (uses DOMParser, available in the browser and jsdom test env).

// SMIL clock values: "3.5s", "12", "0:00:08.250", "00:03.5" → seconds
export function parseClock(value) {
  if (value == null) return 0
  const v = String(value).trim()
  if (v.endsWith('ms')) return parseFloat(v) / 1000
  if (v.endsWith('s')) return parseFloat(v)
  if (v.endsWith('min')) return parseFloat(v) * 60
  if (v.endsWith('h')) return parseFloat(v) * 3600
  if (v.includes(':')) {
    const parts = v.split(':').map(parseFloat)
    return parts.reduce((acc, n) => acc * 60 + n, 0)
  }
  return parseFloat(v) || 0
}

export function parseSmil(xmlString) {
  const doc = new DOMParser().parseFromString(xmlString, 'application/xml')
  const pars = Array.from(doc.getElementsByTagName('par'))
  const timeline = []
  for (const par of pars) {
    const text = par.getElementsByTagName('text')[0]
    const audio = par.getElementsByTagName('audio')[0]
    if (!text || !audio) continue
    timeline.push({
      textSrc: text.getAttribute('src') || '',
      audioSrc: audio.getAttribute('src') || '',
      clipBegin: parseClock(audio.getAttribute('clipBegin')),
      clipEnd: parseClock(audio.getAttribute('clipEnd'))
    })
  }
  return timeline
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx jest storytellerSmil`
Expected: PASS (5 passing).

- [ ] **Step 5: Commit**

```bash
git add client/components/readers/storytellerSmil.js client/components/readers/__tests__/storytellerSmil.spec.js
git commit -m "feat: add SMIL media-overlay parser for read-along"
```

---

### Task 2: StorytellerReader.vue (read-along player)

**Files:**
- Create: `client/components/readers/StorytellerReader.vue`
- Reference (do not modify): `client/components/readers/EpubReader.vue:95-100,315-384` (epub load pattern), `Reader.vue:26` (props passed to reader components)

**Interfaces:**
- Consumes: `parseSmil` from Task 1; props `libraryItem`, `playerOpen`, `keepProgress`, `fileId` (same props `Reader.vue` passes every reader). Loads EPUB from `/api/items/:id/ebook[/:fileId]`.
- Produces: a component registered by Nuxt as `readers-storyteller-reader` (used in Task 4).

**Behaviour:** Build an ordered list of chapters from the EPUB manifest's media-overlay refs. Each chapter = `{ contentHref, audioHref, pars: [{ fragId, start, end }] }` (v1 assumes one audio file per SMIL). Play a chapter by displaying its content doc, pointing one `<audio>` element at the chapter's audio blob, and on `timeupdate` highlighting the active par and auto-paging; on `ended`, advance to the next chapter. Tapping a sentence seeks. If the EPUB has no media overlays, show a fallback with a "Read normally" button.

- [ ] **Step 1: Create the component**

```vue
<!-- client/components/readers/StorytellerReader.vue -->
<template>
  <div class="w-full h-full relative">
    <div v-if="error" class="absolute inset-0 flex flex-col items-center justify-center text-center px-8 z-20">
      <p class="text-lg mb-4">{{ error }}</p>
      <ui-btn small @click="$emit('readNormally')">{{ $strings.ButtonRead }}</ui-btn>
    </div>

    <div id="readalong-viewer" class="w-full" :style="{ height: viewerHeight + 'px' }" />

    <!-- controls -->
    <div class="absolute bottom-0 left-0 right-0 h-12 bg-bg flex items-center px-4 gap-3 z-10 border-t border-white/10">
      <button :aria-label="playing ? 'Pause' : 'Play'" @click="togglePlay">
        <span class="material-symbols fill text-3xl">{{ playing ? 'pause' : 'play_arrow' }}</span>
      </button>
      <span class="text-xs tabular-nums">{{ timeLabel }}</span>
      <input type="range" class="flex-grow" min="0" :max="audioDuration || 0" step="0.1" :value="audioTime" @input="onScrub" />
      <select v-model.number="rate" @change="applyRate" class="bg-primary text-sm rounded px-1">
        <option v-for="r in [0.75,1,1.25,1.5,1.75,2]" :key="r" :value="r">{{ r }}x</option>
      </select>
    </div>

    <audio ref="audio" class="hidden" @timeupdate="onTimeUpdate" @ended="onAudioEnded" @loadedmetadata="onAudioMeta" @play="playing = true" @pause="playing = false" />
  </div>
</template>

<script>
import ePub from 'epubjs'
import { parseSmil } from './storytellerSmil'

export default {
  props: {
    libraryItem: { type: Object, required: true },
    playerOpen: Boolean,
    keepProgress: Boolean,
    fileId: String
  },
  data() {
    return {
      book: null,
      rendition: null,
      chapters: [],      // [{ contentHref, audioHref, audioUrl, pars: [{ fragId, start, end }] }]
      chapterIndex: 0,
      activeFragId: null,
      playing: false,
      rate: 1,
      audioTime: 0,
      audioDuration: 0,
      error: null
    }
  },
  computed: {
    libraryItemId() { return this.libraryItem.id },
    ebookUrl() {
      if (this.fileId) return `/api/items/${this.libraryItemId}/ebook/${this.fileId}`
      return `/api/items/${this.libraryItemId}/ebook`
    },
    viewerHeight() { return window.innerHeight - 48 },
    timeLabel() { return `${this.fmt(this.audioTime)} / ${this.fmt(this.audioDuration)}` }
  },
  methods: {
    fmt(s) {
      if (!s || isNaN(s)) return '0:00'
      const m = Math.floor(s / 60); const sec = Math.floor(s % 60)
      return `${m}:${sec.toString().padStart(2, '0')}`
    },
    async initEpub() {
      const customRequest = (url) => this.$axios.$get(url, { responseType: 'arraybuffer' })
      this.book = new ePub(this.ebookUrl, { openAs: 'epub', requestMethod: customRequest })
      await this.book.ready
      await this.buildChapters()
      if (!this.chapters.length) {
        this.error = this.$strings.MessageNoReadAlongData || 'No read-along data in this ebook'
        return
      }
      this.rendition = this.book.renderTo('readalong-viewer', {
        width: '100%', height: this.viewerHeight, flow: 'paginated', manager: 'continuous', spread: 'auto'
      })
      await this.loadChapter(0)
    },
    // Walk the EPUB manifest for items carrying a media-overlay (epub.js exposes `.overlay`).
    async buildChapters() {
      const manifest = this.book.packaging.manifest
      // spine order keeps chapters in reading order
      const spine = this.book.packaging.spine
      const chapters = []
      for (const spineItem of spine) {
        const item = manifest[spineItem.idref]
        if (!item || !item.overlay) continue
        const smilItem = manifest[item.overlay]
        if (!smilItem) continue
        const smilPath = this.book.path.resolve(smilItem.href)
        const smilXml = await this.book.archive.getText(smilPath)
        const timeline = parseSmil(smilXml)
        if (!timeline.length) continue
        // resolve audio relative to the SMIL file's directory
        const smilDir = smilPath.split('/').slice(0, -1).join('/')
        const audioRel = timeline[0].audioSrc
        const audioPath = this.resolveRelative(smilDir, audioRel)
        const audioUrl = await this.book.archive.createUrl(audioPath, { base64: false })
        chapters.push({
          contentHref: item.href,
          audioPath,
          audioUrl,
          pars: timeline.map((p) => ({
            fragId: (p.textSrc.split('#')[1] || ''),
            start: p.clipBegin,
            end: p.clipEnd
          }))
        })
      }
      this.chapters = chapters
    },
    resolveRelative(dir, rel) {
      const stack = dir ? dir.split('/') : []
      for (const part of rel.split('/')) {
        if (part === '..') stack.pop()
        else if (part !== '.' && part !== '') stack.push(part)
      }
      return stack.join('/')
    },
    async loadChapter(i) {
      if (i < 0 || i >= this.chapters.length) { this.pause(); return }
      this.chapterIndex = i
      const ch = this.chapters[i]
      await this.rendition.display(ch.contentHref)
      const audio = this.$refs.audio
      audio.src = ch.audioUrl
      audio.playbackRate = this.rate
      this.attachClickHandlers()
    },
    attachClickHandlers() {
      // tap a sentence to seek to it
      const contents = this.rendition.getContents()
      const ch = this.chapters[this.chapterIndex]
      contents.forEach((c) => {
        for (const par of ch.pars) {
          if (!par.fragId) continue
          const el = c.document.getElementById(par.fragId)
          if (el) {
            el.style.cursor = 'pointer'
            el.onclick = () => { this.$refs.audio.currentTime = par.start; this.$refs.audio.play() }
          }
        }
      })
    },
    onTimeUpdate() {
      const audio = this.$refs.audio
      this.audioTime = audio.currentTime
      const ch = this.chapters[this.chapterIndex]
      const t = audio.currentTime
      const active = ch.pars.find((p) => t >= p.start && t < p.end)
      if (active && active.fragId !== this.activeFragId) this.highlight(active.fragId)
    },
    highlight(fragId) {
      const contents = this.rendition.getContents()
      contents.forEach((c) => {
        if (this.activeFragId) {
          const prev = c.document.getElementById(this.activeFragId)
          if (prev) prev.classList.remove('readalong-active')
        }
        const el = c.document.getElementById(fragId)
        if (el) {
          el.classList.add('readalong-active')
          el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        }
      })
      this.activeFragId = fragId
    },
    onAudioEnded() { this.loadChapter(this.chapterIndex + 1).then(() => this.$refs.audio.play()) },
    onAudioMeta() { this.audioDuration = this.$refs.audio.duration },
    onScrub(e) { this.$refs.audio.currentTime = Number(e.target.value) },
    togglePlay() { this.playing ? this.pause() : this.$refs.audio.play() },
    pause() { this.$refs.audio && this.$refs.audio.pause() },
    applyRate() { this.$refs.audio.playbackRate = this.rate },
    injectHighlightStyle() {
      this.rendition.hooks.content.register((contents) => {
        contents.addStylesheetRules({ '.readalong-active': { 'background-color': 'rgba(255, 213, 79, 0.45)', 'border-radius': '2px' } })
      })
    }
  },
  mounted() {
    this.initEpub().catch((e) => {
      console.error('StorytellerReader init failed', e)
      this.error = this.$strings.MessageReadAlongLoadFailed || 'Failed to load read-along'
    })
    // register highlight stylesheet after rendition exists
    this.$nextTick(() => { if (this.rendition) this.injectHighlightStyle() })
  },
  beforeDestroy() {
    this.pause()
    // ponytail: revoke blob URLs to free the (large) embedded audio
    for (const ch of this.chapters) { if (ch.audioUrl) URL.revokeObjectURL(ch.audioUrl) }
    if (this.book) this.book.destroy()
  }
}
</script>
```

- [ ] **Step 2: Move the highlight-style registration before first display**

In `initEpub`, call `this.injectHighlightStyle()` immediately after `this.rendition = this.book.renderTo(...)` and **remove** the `mounted()` `$nextTick` block (the rendition doesn't exist yet in `mounted`). Final `mounted`:

```javascript
  mounted() {
    this.initEpub().catch((e) => {
      console.error('StorytellerReader init failed', e)
      this.error = this.$strings.MessageReadAlongLoadFailed || 'Failed to load read-along'
    })
  },
```

And in `initEpub`, right after `renderTo`:

```javascript
      this.injectHighlightStyle()
      await this.loadChapter(0)
```

- [ ] **Step 3: Manual verification (deferred to first synced EPUB)**

This component can't be meaningfully unit-tested without a real media-overlay EPUB. Verify manually after Task 6 produces one (or with any Storyteller-made EPUB dropped into a library item): open the item, click **Read-Along**, confirm audio plays, the current sentence highlights and scrolls, pages auto-advance, scrub/speed/tap-to-seek work, and a non-overlay EPUB shows the fallback. Note this in the commit body.

- [ ] **Step 4: Commit**

```bash
git add client/components/readers/StorytellerReader.vue
git commit -m "feat: add Storyteller read-along reader component"
```

---

### Task 3: Wire the combo button, store mode, and reader dispatch

**Files:**
- Modify: `client/store/index.js` (the `showEReader` mutation)
- Modify: `client/components/readers/Reader.vue:26,210-215`
- Modify: `client/pages/item/_id/index.vue:94-97` (button), `:500-502` (`openEbook` method area)
- Modify: `client/strings/en-us.json`

**Interfaces:**
- Consumes: `readers-storyteller-reader` component (Task 2).
- Produces: a `mode` field on the ereader store state; a `Read-Along` button calling `openReadAlong()`.

- [ ] **Step 1: Add `mode` to the `showEReader` mutation**

In `client/store/index.js`, find the `showEReader` mutation and add `mode`:

```javascript
  showEReader(state, { libraryItem, keepProgress, fileId, mode }) {
    state.selectedLibraryItem = libraryItem
    state.ereaderKeepProgress = keepProgress
    state.ereaderFileId = fileId
    state.ereaderMode = mode || 'normal'
    state.showEReader = true
  },
```

Add `ereaderMode: 'normal'` to the store `state()` object (next to the existing `showEReader: false`).

- [ ] **Step 2: Dispatch the read-along reader in Reader.vue**

In `client/components/readers/Reader.vue`, in `computed.componentName()` (around line 210), add the read-along branch **before** the epub branch:

```javascript
    componentName() {
      if (this.ereaderMode === 'readalong' && this.ebookType === 'epub') return 'readers-storyteller-reader'
      if (this.ebookType === 'epub') return 'readers-epub-reader'
      else if (this.ebookType === 'mobi') return 'readers-mobi-reader'
      else if (this.ebookType === 'pdf') return 'readers-pdf-reader'
      else if (this.ebookType === 'comic') return 'readers-comic-reader'
      return null
    },
```

Add the `ereaderMode` computed in the same component:

```javascript
    ereaderMode() { return this.$store.state.ereaderMode },
```

Handle the reader's `readNormally` fallback event — on the dynamic `<component>` tag (line 26), add `@readNormally="ereaderModeNormal"`, and add the method:

```javascript
    ereaderModeNormal() { this.$store.commit('setEreaderMode', 'normal') },
```

Add a tiny mutation in `client/store/index.js`:

```javascript
  setEreaderMode(state, mode) { state.ereaderMode = mode || 'normal' },
```

- [ ] **Step 3: Add the Read-Along button + method on the item page**

In `client/pages/item/_id/index.vue`, immediately after the existing Read button (lines 94-97), add:

```html
        <ui-btn v-if="showReadAlongButton" color="bg-warning" :padding-x="4" small class="flex items-center h-9 mr-2" @click="openReadAlong">
          <span class="material-symbols text-2xl -ml-2 pr-2 text-white" aria-hidden="true">graphic_eq</span>
          {{ $strings.ButtonReadAlong }}
        </ui-btn>
```

Add the computed near `showReadButton` (around line 236):

```javascript
    showReadAlongButton() {
      const ef = this.ebookFile
      return ef && ef.ebookFormat === 'epub'
    },
```

Add the method near `openEbook` (around line 500):

```javascript
    openReadAlong() {
      this.$store.commit('showEReader', { libraryItem: this.libraryItem, keepProgress: true, mode: 'readalong' })
    },
```

> Note: `showReadAlongButton` shows for any EPUB ebook; whether read-along data exists is detected inside the reader (graceful fallback). This keeps detection out of the scanner/model per the spec.

- [ ] **Step 4: Add strings**

In `client/strings/en-us.json`, add (keep alphabetical grouping like neighbors):

```json
  "ButtonReadAlong": "Read-Along",
  "MessageNoReadAlongData": "This ebook has no read-along (synced narration) data.",
  "MessageReadAlongLoadFailed": "Failed to load read-along.",
```

- [ ] **Step 5: Verify the client builds**

Run: `cd client && npm run lint`
Expected: no new lint errors in the touched files.

- [ ] **Step 6: Commit**

```bash
git add client/store/index.js client/components/readers/Reader.vue client/pages/item/_id/index.vue client/strings/en-us.json
git commit -m "feat: add Read-Along button and reader dispatch"
```

---

### Task 4: Library Storyteller settings (model + UI)

**Files:**
- Modify: `server/models/Library.js` (the default `settings` object, ~line 86)
- Modify: `client/components/modals/libraries/LibrarySettings.vue`
- Modify: `client/strings/en-us.json`

**Interfaces:**
- Produces: `library.settings.storyteller = { enabled: boolean, url: string|null, token: null }`. **Note:** v1 authenticates the client with `username`/`password` (Task 5), so the persisted shape is `{ enabled, url, username, password }`.

- [ ] **Step 1: Add the settings block to the model defaults**

In `server/models/Library.js`, in the default settings object (next to `autoApplyFileTemplate: false`), add:

```javascript
        storyteller: {
          enabled: false,
          url: null,
          username: null,
          password: null
        },
```

Ensure the library settings getter/`fromOld`/`toJSONForBrowser` (whichever normalizes `settings`) preserves unknown-to-old keys — if there's an explicit allowlist of setting keys, add `storyteller` to it. Search the file for `autoApplyFileTemplate` and mirror every place it appears.

- [ ] **Step 2: Add the UI**

In `client/components/modals/libraries/LibrarySettings.vue`, after the `autoApplyFileTemplate` toggle block, add (book libraries only):

```html
        <div v-if="isBookLibrary" class="py-3">
          <div class="flex items-center">
            <ui-toggle-switch v-model="storytellerEnabled" size="sm" @input="formUpdated" />
            <ui-tooltip :text="$strings.LabelSettingsStorytellerSyncHelp">
              <p class="pl-4 text-base">{{ $strings.LabelSettingsStorytellerSync }}</p>
            </ui-tooltip>
          </div>
          <div v-if="storytellerEnabled" class="pl-12 pt-2 max-w-md space-y-2">
            <ui-text-input-with-label v-model="storytellerUrl" :label="$strings.LabelSettingsStorytellerUrl" placeholder="https://storyteller.example.com" @input="formUpdated" />
            <ui-text-input-with-label v-model="storytellerUsername" :label="$strings.LabelSettingsStorytellerUsername" @input="formUpdated" />
            <ui-text-input-with-label v-model="storytellerPassword" type="password" :label="$strings.LabelSettingsStorytellerPassword" @input="formUpdated" />
          </div>
        </div>
```

Add the data fields (in `data()`):

```javascript
      storytellerEnabled: false,
      storytellerUrl: null,
      storytellerUsername: null,
      storytellerPassword: null,
```

In the method that seeds local state from incoming settings (search for where `autoApplyFileTemplate` is read, e.g. `init()`/`mounted`), add:

```javascript
      const st = this.librarySettings.storyteller || {}
      this.storytellerEnabled = !!st.enabled
      this.storytellerUrl = st.url || null
      this.storytellerUsername = st.username || null
      this.storytellerPassword = st.password || null
```

In `getLibraryData()` (the settings payload builder, ~line 171), add to the returned `settings` object:

```javascript
        storyteller: {
          enabled: !!this.storytellerEnabled,
          url: this.storytellerUrl || null,
          username: this.storytellerUsername || null,
          password: this.storytellerPassword || null
        },
```

- [ ] **Step 3: Add strings**

In `client/strings/en-us.json`:

```json
  "LabelSettingsStorytellerSync": "Generate read-along on import (Storyteller)",
  "LabelSettingsStorytellerSyncHelp": "When importing a matched ebook + audiobook, send them to a Storyteller server to generate a synced read-along EPUB. Requires a shared filesystem with Storyteller.",
  "LabelSettingsStorytellerUrl": "Storyteller server URL",
  "LabelSettingsStorytellerUsername": "Storyteller username",
  "LabelSettingsStorytellerPassword": "Storyteller password",
```

- [ ] **Step 4: Verify**

Run: `cd client && npm run lint`
Expected: no new errors. Manually open Library Settings for a book library and confirm the toggle reveals URL/username/password and saving round-trips (reopen shows saved values).

- [ ] **Step 5: Commit**

```bash
git add server/models/Library.js client/components/modals/libraries/LibrarySettings.vue client/strings/en-us.json
git commit -m "feat: add Storyteller server settings to libraries"
```

---

### Task 5: Storyteller REST client (TDD on parsing)

**Files:**
- Create: `server/utils/storytellerClient.js`
- Test: `server/test/utils/storytellerClient.test.js`

**Interfaces:**
- Produces:
  - `class StorytellerClient { constructor({ url, username, password }) }`
  - `async authenticate()` → sets `this.token`
  - `async createBookByPaths(paths)` → `bookUuid: string`
  - `async startProcessing(bookUuid)` → void
  - `async waitForAligned(bookUuid, { timeoutMs, intervalMs })` → void (resolves when `readaloud.filepath` present; throws on timeout)
  - `async downloadSynced(bookUuid, destPath)` → void (streams to `destPath`)
  - static helpers `extractToken(resp)` and `extractBookUuid(resp)` (pure — unit-tested)

- [ ] **Step 1: Write the failing test (pure parsers only)**

```javascript
// server/test/utils/storytellerClient.test.js
const chai = require('chai')
const expect = chai.expect
const { extractToken, extractBookUuid } = require('../../utils/storytellerClient')

describe('storytellerClient parsers', () => {
  describe('extractToken', () => {
    it('accepts a bare string token', () => { expect(extractToken('abc.def.ghi')).to.equal('abc.def.ghi') })
    it('accepts { token }', () => { expect(extractToken({ token: 'xyz' })).to.equal('xyz') })
    it('accepts { access_token }', () => { expect(extractToken({ access_token: 'qqq' })).to.equal('qqq') })
    it('throws on garbage', () => { expect(() => extractToken({})).to.throw() })
  })

  describe('extractBookUuid', () => {
    it('accepts { bookUuid }', () => { expect(extractBookUuid({ bookUuid: 'u1' })).to.equal('u1') })
    it('accepts { uuid }', () => { expect(extractBookUuid({ uuid: 'u2' })).to.equal('u2') })
    it('accepts { books: [{ uuid }] }', () => { expect(extractBookUuid({ books: [{ uuid: 'u3' }] })).to.equal('u3') })
    it('throws when epub2 detected', () => { expect(() => extractBookUuid({ epub2Detected: true, paths: ['x'] })).to.throw(/epub2/i) })
    it('throws on empty', () => { expect(() => extractBookUuid({})).to.throw() })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx mocha test/utils/storytellerClient.test.js`
Expected: FAIL — cannot find module `../../utils/storytellerClient`.

- [ ] **Step 3: Implement the client**

```javascript
// server/utils/storytellerClient.js
const fs = require('fs')
const { pipeline } = require('stream/promises')
const { Readable } = require('stream')
const Logger = require('../Logger')

function extractToken(resp) {
  if (typeof resp === 'string' && resp.length) return resp
  if (resp && typeof resp === 'object') {
    if (resp.token) return resp.token
    if (resp.access_token) return resp.access_token
  }
  throw new Error('Storyteller: could not parse auth token from response')
}

function extractBookUuid(resp) {
  if (resp && resp.epub2Detected) {
    throw new Error('Storyteller: EPUB2 detected and not auto-converted; pass epub2Strategy')
  }
  if (resp && typeof resp === 'object') {
    if (resp.bookUuid) return resp.bookUuid
    if (resp.uuid) return resp.uuid
    if (Array.isArray(resp.books) && resp.books[0]?.uuid) return resp.books[0].uuid
  }
  throw new Error(`Storyteller: could not parse book uuid from create response: ${JSON.stringify(resp)}`)
}

class StorytellerClient {
  constructor({ url, username, password }) {
    if (!url) throw new Error('Storyteller: url is required')
    this.baseUrl = url.replace(/\/$/, '')
    this.username = username
    this.password = password
    this.token = null
  }

  authHeaders() {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {}
  }

  async authenticate() {
    const body = new URLSearchParams({ username: this.username || '', password: this.password || '' })
    const res = await fetch(`${this.baseUrl}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    })
    if (!res.ok) throw new Error(`Storyteller auth failed: ${res.status}`)
    const data = await res.json().catch(() => null)
    this.token = extractToken(data)
  }

  async createBookByPaths(paths) {
    const res = await fetch(`${this.baseUrl}/api/v2/books`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ paths, importMode: 'reference', epub2Strategy: 'backup-and-convert' })
    })
    if (!res.ok) throw new Error(`Storyteller create failed: ${res.status}`)
    return extractBookUuid(await res.json())
  }

  async startProcessing(bookUuid) {
    const res = await fetch(`${this.baseUrl}/api/v2/books/${bookUuid}/process`, {
      method: 'POST',
      headers: this.authHeaders()
    })
    if (!res.ok) throw new Error(`Storyteller process start failed: ${res.status}`)
  }

  async getBook(bookUuid) {
    const res = await fetch(`${this.baseUrl}/api/v2/books/${bookUuid}`, { headers: this.authHeaders() })
    if (!res.ok) throw new Error(`Storyteller get book failed: ${res.status}`)
    return res.json()
  }

  async waitForAligned(bookUuid, { timeoutMs = 1000 * 60 * 60 * 24, intervalMs = 15000 } = {}) {
    const deadline = Date.now() + timeoutMs
    // ponytail: poll readaloud.filepath with a timeout; upgrade to SSE /api/v2/books/events for live progress
    while (Date.now() < deadline) {
      const book = await this.getBook(bookUuid).catch((e) => { Logger.warn(`[Storyteller] poll error: ${e.message}`); return null })
      if (book?.readaloud?.filepath) return
      await new Promise((r) => setTimeout(r, intervalMs))
    }
    throw new Error('Storyteller: alignment timed out')
  }

  async downloadSynced(bookUuid, destPath) {
    const res = await fetch(`${this.baseUrl}/api/books/${bookUuid}/synced`, { headers: this.authHeaders() })
    if (!res.ok || !res.body) throw new Error(`Storyteller download failed: ${res.status}`)
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath))
  }
}

module.exports = StorytellerClient
module.exports.StorytellerClient = StorytellerClient
module.exports.extractToken = extractToken
module.exports.extractBookUuid = extractBookUuid
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx mocha test/utils/storytellerClient.test.js`
Expected: PASS (9 passing).

- [ ] **Step 5: Commit**

```bash
git add server/utils/storytellerClient.js server/test/utils/storytellerClient.test.js
git commit -m "feat: add Storyteller v2 REST client"
```

---

### Task 6: generateReadAlong orchestration + import hook

**Files:**
- Create: `server/utils/storytellerSync.js`
- Modify: `server/controllers/ImportController.js:149-177` (the `approve` handler, after `executePendingImport` succeeds)
- Reference (do not modify): `server/utils/importExecutor.js:70-94` (how `ebookFile` + `libraryFiles` are shaped), `server/managers/TaskManager.js`

**Interfaces:**
- Consumes: `StorytellerClient` (Task 5); `TaskManager`; the imported `libraryItem` and its `library`.
- Produces: `async generateReadAlong(libraryItem, library, task)` — runs the full round-trip and swaps in the synced EPUB; resolves on success, throws on failure (leaving the original ebook intact).

- [ ] **Step 1: Implement generateReadAlong**

```javascript
// server/utils/storytellerSync.js
const fs = require('fs')
const Path = require('path')
const Logger = require('../Logger')
const StorytellerClient = require('./storytellerClient')
const SocketAuthority = require('../SocketAuthority')

// Gather the absolute paths Storyteller needs: the ebook + all audio files.
function collectPaths(libraryItem) {
  const media = libraryItem.media
  const ebookPath = media.ebookFile?.metadata?.path
  if (!ebookPath) throw new Error('No ebook file on item')
  const audioPaths = (media.audioFiles || []).map((af) => af.metadata.path).filter(Boolean)
  if (!audioPaths.length) throw new Error('No audio files on item')
  return { ebookPath, audioPaths }
}

/**
 * Generate a Storyteller read-along EPUB for an imported item and store it as the ebookFile.
 * Non-destructive: throws on any failure, leaving the original ebookFile untouched.
 */
async function generateReadAlong(libraryItem, library, task) {
  const cfg = library.settings?.storyteller || {}
  if (!cfg.enabled || !cfg.url) throw new Error('Storyteller not configured')

  const { ebookPath, audioPaths } = collectPaths(libraryItem)
  const client = new StorytellerClient({ url: cfg.url, username: cfg.username, password: cfg.password })

  if (task) { task.setData?.({ ...task.data }); }

  await client.authenticate()
  const bookUuid = await client.createBookByPaths([ebookPath, ...audioPaths])
  await client.startProcessing(bookUuid)
  await client.waitForAligned(bookUuid, {})

  // Download synced EPUB next to the original ebook, then swap it in.
  const itemDir = Path.dirname(ebookPath)
  const baseName = Path.basename(ebookPath, Path.extname(ebookPath))
  const destPath = Path.join(itemDir, `${baseName}.readaloud.epub`)
  const tmpPath = `${destPath}.tmp`
  await client.downloadSynced(bookUuid, tmpPath)
  await fs.promises.rename(tmpPath, destPath)

  const stat = await fs.promises.stat(destPath)
  const filename = Path.basename(destPath)
  const ext = '.epub'

  // Mirror the ebookFile shape from importExecutor.js
  libraryItem.media.ebookFile = {
    ino: String(stat.ino),
    ebookFormat: 'epub',
    addedAt: Date.now(),
    updatedAt: Date.now(),
    metadata: {
      filename,
      ext,
      path: destPath,
      relPath: Path.relative(libraryItem.path || itemDir, destPath),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      birthtimeMs: stat.birthtimeMs
    }
  }
  libraryItem.media.changed('ebookFile', true)
  await libraryItem.media.save()

  SocketAuthority.libraryItemEmitter?.('item_updated', libraryItem)
  Logger.info(`[Storyteller] Read-along generated for "${libraryItem.media.title}" → ${destPath}`)
}

module.exports = { generateReadAlong, collectPaths }
```

> Verify against `importExecutor.js:70-94` that `libraryItem.media.save()` (vs `libraryItem.save()`) is the correct persistence call for `ebookFile`; match exactly what the import executor does. Adjust `libraryItem.path` reference to the actual property the model uses for the item's root folder (search `relPath` usage in `importExecutor.js`).

- [ ] **Step 2: Hook into ImportController.approve**

In `server/controllers/ImportController.js`, locate where `executePendingImport(p)` returns `imported` (around line 165). After the existing success handling, add a fire-and-forget generation job:

```javascript
const result = await executePendingImport(p)
p.status = result.status
p.error = result.error
await p.save()

// Storyteller read-along generation (fire-and-forget background task)
if (result.status === 'imported' && result.libraryItemId) {
  const library = await Database.libraryModel.findByPk(p.libraryId).catch(() => null)
  if (library?.settings?.storyteller?.enabled && library.settings.storyteller.url) {
    const libraryItem = await Database.libraryItemModel.getExpandedById(result.libraryItemId).catch(() => null)
    if (libraryItem) {
      const TaskManager = require('../managers/TaskManager')
      const task = TaskManager.createAndAddTask(
        'storyteller-readalong',
        { text: 'Generating read-along', key: 'LabelTaskGeneratingReadAlong' },
        { text: `Syncing "${libraryItem.media.title}" with Storyteller`, key: 'LabelTaskGeneratingReadAlongDescription' },
        true,
        {}
      )
      const { generateReadAlong } = require('../utils/storytellerSync')
      generateReadAlong(libraryItem, library, task)
        .then(() => TaskManager.taskFinished(task))
        .catch((err) => {
          Logger.error(`[ImportController] Storyteller read-along failed: ${err.message}`)
          task.setFailed?.({ text: err.message })
          TaskManager.taskFinished(task)
        })
    }
  }
}
```

> Verify the exact accessors against the file's existing imports: `Database.libraryModel`, `Database.libraryItemModel.getExpandedById`, and that `executePendingImport` returns a `libraryItemId` (it assigns `target` — make it return `{ status, error, libraryItemId: target.id }`; update `server/utils/importExecutor.js` return statement accordingly). `createAndAddTask` signature is `(action, titleString, descriptionString, showSuccess, data)` per `TaskManager.js`.

- [ ] **Step 3: Add task strings**

In `client/strings/en-us.json`:

```json
  "LabelTaskGeneratingReadAlong": "Generating read-along",
  "LabelTaskGeneratingReadAlongDescription": "Syncing ebook and audiobook with Storyteller",
```

- [ ] **Step 4: Make executePendingImport return the item id**

In `server/utils/importExecutor.js`, change the success return (around line 95-100) from `return { status: 'imported' }` to:

```javascript
  return { status: 'imported', libraryItemId: target.id }
```

(Match the actual variable name for the target library item in that function.)

- [ ] **Step 5: Server sanity check**

Run: `cd server && npx mocha test/utils/storytellerClient.test.js`
Expected: still PASS. Then start the server and confirm it boots without errors:

Run: `npm run client && node index.js` (or the repo's dev command) — confirm no require/syntax errors from the new modules.

- [ ] **Step 6: End-to-end manual verification**

With a real Storyteller server sharing the library volume and configured in Library Settings: run an ebook↔audiobook import match, watch the `Generating read-along` task appear and finish, confirm the item's `ebookFile` becomes the `.readaloud.epub`, then open it with **Read-Along** and confirm synced highlighting. Confirm that with Storyteller misconfigured/down the import still succeeds and the task shows failed (original ebook intact).

- [ ] **Step 7: Commit**

```bash
git add server/utils/storytellerSync.js server/controllers/ImportController.js server/utils/importExecutor.js client/strings/en-us.json
git commit -m "feat: generate Storyteller read-along on import"
```

---

## Self-Review

**Spec coverage:**
- Generate-on-import → Tasks 5, 6. ✅
- Delegate alignment to Storyteller (no in-ABS alignment) → Task 5 (REST client only). ✅
- Combo "Read-Along" button on detail page → Task 3. ✅
- Read-along reader: render + embedded audio + sentence highlight + auto-page → Task 2. ✅
- Limited spread / merge-friendly → all logic in new files; existing files get localized edits (Tasks 3, 4, 6). ✅
- Non-destructive generation → Task 6 (throws, original untouched). ✅
- Graceful fallback for non-overlay EPUBs → Task 2 (`error` + `readNormally`) + Task 3 (event). ✅
- Library settings for Storyteller URL/credentials → Task 4. ✅
- Known ceilings marked with `ponytail:` → Tasks 2 (audio blob memory), 5 (poll vs SSE). ✅
- Shared-volume `importMode: "reference"` → Task 5. ✅

**Placeholder scan:** No "TBD"/"add error handling" placeholders; every code step is concrete. The explicit "verify exact field name on first live run" notes are real verification steps against an external API, not deferred implementation.

**Type consistency:** `mode`/`ereaderMode` consistent across Tasks 2–3. `generateReadAlong(libraryItem, library, task)` signature consistent between Tasks 5/6. `extractToken`/`extractBookUuid` names consistent between client and tests. `storyteller` settings shape (`{ enabled, url, username, password }`) consistent across Tasks 4 and 6.

## Open verification items (external API — confirm on first live run)

1. `POST /api/v2/books` create response field carrying the new book UUID (client tolerates `bookUuid` / `uuid` / `books[0].uuid`).
2. Token response shape from `POST /api/token` (client tolerates string / `{token}` / `{access_token}`) and that it's accepted as `Authorization: Bearer`.
3. `GET /api/v2/books/:id` returns `readaloud.filepath` once aligned (used as the completion signal).
4. ABS model persistence call for `ebookFile` (`media.save()` vs item save) — mirror `importExecutor.js` exactly.
