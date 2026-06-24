<!-- client/components/readers/StorytellerReader.vue -->
<template>
  <div class="w-full h-full relative">
    <!-- z-10 keeps this below Reader.vue's close (✕) button (z-20) so it stays clickable -->
    <div v-if="error" class="absolute inset-0 flex flex-col items-center justify-center text-center px-8 z-10">
      <p class="text-lg mb-4">{{ error }}</p>
      <ui-btn small @click="$emit('readNormally')">{{ $strings.ButtonRead }}</ui-btn>
    </div>

    <div v-if="loading && !error" class="absolute inset-0 flex items-center justify-center z-10">
      <widgets-loading-spinner />
    </div>

    <div id="readalong-viewer" class="w-full" :style="{ height: viewerHeight + 'px' }" />

    <!-- RSVP: single-word view layered over the paginated text, advanced by the audio clock -->
    <div v-if="rsvp && !error" class="absolute top-0 left-0 right-0 flex items-center justify-center bg-bg select-none" :style="{ height: viewerHeight + 'px', zIndex: 5 }">
      <span class="text-5xl md:text-7xl font-semibold tracking-wide">{{ rsvpWord }}</span>
    </div>

    <!-- controls -->
    <div v-show="!error" class="absolute bottom-0 left-0 right-0 h-12 bg-bg flex items-center px-4 gap-3 z-10 border-t border-white/10">
      <button :aria-label="playing ? 'Pause' : 'Play'" @click="togglePlay">
        <span class="material-symbols fill text-3xl">{{ playing ? 'pause' : 'play_arrow' }}</span>
      </button>
      <button :aria-label="rsvp ? 'Show text' : 'Speed read (one word)'" @click="rsvp = !rsvp">
        <span class="material-symbols text-2xl" :class="rsvp ? 'fill text-warning' : ''">bolt</span>
      </button>
      <label v-if="rsvp" class="flex items-center gap-1 text-xs whitespace-nowrap" title="Read-ahead: how far the word leads the audio (seconds)">
        <span class="material-symbols text-base">timer</span>
        <input type="number" step="0.05" min="-0.5" max="1.5" v-model.number="rsvpLead" class="bg-primary text-xs rounded px-1 w-14" />
        <span>s</span>
      </label>
      <span class="text-xs tabular-nums">{{ timeLabel }}</span>
      <input type="range" class="flex-grow" min="0" :max="audioDuration || 0" step="0.1" :value="audioTime" @input="onScrub" />
      <select v-model.number="rate" class="bg-primary text-sm rounded px-1" @change="applyRate">
        <option v-for="r in [0.75, 1, 1.25, 1.5, 1.75, 2]" :key="r" :value="r">{{ r }}x</option>
      </select>
    </div>

    <audio ref="audio" class="hidden" @timeupdate="onTimeUpdate" @ended="onAudioEnded" @loadedmetadata="onAudioMeta" @play="playing = true" @pause="playing = false" />
  </div>
</template>

<script>
import ePub from 'epubjs'
import { parseSmil, rsvpWordIndex } from './storytellerSmil'

// Seconds to nudge the RSVP word ahead of the audio clock (perception + output latency).
const RSVP_LEAD = 0.2

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
      chapters: [], // [{ contentHref, audioHref, audioUrl, pars: [{ fragId, start, end }] }]
      chapterIndex: 0,
      activeFragId: null,
      playing: false,
      rate: 1,
      audioTime: 0,
      audioDuration: 0,
      error: null,
      loading: true,
      rsvp: false,
      rsvpWord: '',
      rsvpLead: RSVP_LEAD,
      rafId: null
    }
  },
  watch: {
    rsvp(on) {
      if (on) this.startRsvpLoop()
      else this.stopRsvpLoop()
    },
    rsvpLead(val) {
      localStorage.setItem('readalongRsvpLead', val)
    }
  },
  computed: {
    libraryItemId() {
      return this.libraryItem.id
    },
    ebookUrl() {
      if (this.fileId) return `/api/items/${this.libraryItemId}/ebook/${this.fileId}`
      return `/api/items/${this.libraryItemId}/ebook`
    },
    viewerHeight() {
      return window.innerHeight - 48
    },
    timeLabel() {
      return `${this.fmt(this.audioTime)} / ${this.fmt(this.audioDuration)}`
    }
  },
  methods: {
    fmt(s) {
      if (!s || isNaN(s)) return '0:00'
      const m = Math.floor(s / 60)
      const sec = Math.floor(s % 60)
      return `${m}:${sec.toString().padStart(2, '0')}`
    },
    async initEpub() {
      const customRequest = (url) => this.$axios.$get(url, { responseType: 'arraybuffer' })
      this.book = new ePub(this.ebookUrl, { openAs: 'epub', requestMethod: customRequest })
      await this.book.ready
      await this.buildChapters()
      if (!this.chapters.length) {
        this.error = this.$strings.MessageNoReadAlongData || 'No read-along data in this ebook'
        this.loading = false
        return
      }
      this.rendition = this.book.renderTo('readalong-viewer', {
        width: '100%',
        height: this.viewerHeight,
        flow: 'paginated',
        manager: 'continuous',
        spread: 'auto'
      })
      this.injectHighlightStyle()
      await this.loadChapter(0)
      this.loading = false
      // Read-Along auto-plays. Browsers may block autoplay if the click gesture
      // expired during the async load; controls stay visible so the user can press play.
      const p = this.$refs.audio && this.$refs.audio.play()
      if (p && p.catch) p.catch(() => {})
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
          audioUrl,
          pars: timeline.map((p) => ({
            fragId: p.textSrc.split('#')[1] || '',
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
      if (i < 0 || i >= this.chapters.length) {
        this.pause()
        return false
      }
      this.chapterIndex = i
      const ch = this.chapters[i]
      await this.rendition.display(ch.contentHref)
      const audio = this.$refs.audio
      audio.src = ch.audioUrl
      audio.playbackRate = this.rate
      this.activeFragId = null
      this.attachClickHandlers()
      return true
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
            par.words = (el.textContent || '').trim().split(/\s+/).filter(Boolean)
            el.style.cursor = 'pointer'
            el.onclick = () => {
              this.$refs.audio.currentTime = par.start
              this.$refs.audio.play()
            }
          }
        }
      })
    },
    onTimeUpdate() {
      const audio = this.$refs.audio
      this.audioTime = audio.currentTime
      const ch = this.chapters[this.chapterIndex]
      if (!ch) return
      const t = audio.currentTime
      const active = ch.pars.find((p) => t >= p.start && t < p.end)
      if (active && active.fragId !== this.activeFragId) this.highlight(active.fragId)
    },
    // RSVP word updates run on a rAF loop (not timeupdate, which only fires ~4x/sec
    // and lags the narration by up to 250ms).
    startRsvpLoop() {
      if (this.rafId) return
      const tick = () => {
        if (!this.rsvp) { this.rafId = null; return }
        this.updateRsvpWord()
        this.rafId = requestAnimationFrame(tick)
      }
      this.rafId = requestAnimationFrame(tick)
    },
    stopRsvpLoop() {
      if (this.rafId) {
        cancelAnimationFrame(this.rafId)
        this.rafId = null
      }
    },
    updateRsvpWord() {
      const audio = this.$refs.audio
      const ch = this.chapters[this.chapterIndex]
      if (!audio || !ch) return
      const t = audio.currentTime
      const active = ch.pars.find((p) => t >= p.start && t < p.end)
      if (active && active.words) this.rsvpWord = active.words[rsvpWordIndex(active.start, active.end, active.words, t, this.rsvpLead)] || ''
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
    onAudioEnded() {
      this.loadChapter(this.chapterIndex + 1).then((loaded) => { if (loaded) this.$refs.audio.play() })
    },
    onAudioMeta() {
      this.audioDuration = this.$refs.audio.duration
    },
    onScrub(e) {
      this.$refs.audio.currentTime = Number(e.target.value)
    },
    togglePlay() {
      this.playing ? this.pause() : this.$refs.audio.play()
    },
    pause() {
      this.$refs.audio && this.$refs.audio.pause()
    },
    applyRate() {
      this.$refs.audio.playbackRate = this.rate
    },
    injectHighlightStyle() {
      this.rendition.hooks.content.register((contents) => {
        contents.addStylesheetRules({ '.readalong-active': { 'background-color': 'rgba(255, 213, 79, 0.45)', 'border-radius': '2px' } })
      })
    }
  },
  mounted() {
    const savedLead = localStorage.getItem('readalongRsvpLead')
    if (savedLead !== null && !isNaN(parseFloat(savedLead))) this.rsvpLead = parseFloat(savedLead)
    this.initEpub().catch((e) => {
      console.error('StorytellerReader init failed', e)
      this.error = this.$strings.MessageReadAlongLoadFailed || 'Failed to load read-along'
      this.loading = false
    })
  },
  beforeDestroy() {
    this.stopRsvpLoop()
    this.pause()
    // ponytail: revoke blob URLs to free the (large) embedded audio
    for (const ch of this.chapters) {
      if (ch.audioUrl) URL.revokeObjectURL(ch.audioUrl)
    }
    if (this.book) this.book.destroy()
  }
}
</script>
