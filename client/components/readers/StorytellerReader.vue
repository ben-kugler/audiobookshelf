<!-- client/components/readers/StorytellerReader.vue -->
<template>
  <div class="w-full h-full relative">
    <!-- z-10 keeps this below Reader.vue's close (✕) button (z-20) so it stays clickable -->
    <div v-if="error" class="absolute inset-0 flex flex-col items-center justify-center text-center px-8 z-10">
      <p class="text-lg mb-4">{{ error }}</p>
      <ui-btn small @click="$emit('readNormally')">{{ $strings.ButtonRead }}</ui-btn>
    </div>

    <div id="readalong-viewer" class="w-full" :style="{ height: viewerHeight + 'px' }" />

    <!-- controls -->
    <div v-show="!error" class="absolute bottom-0 left-0 right-0 h-12 bg-bg flex items-center px-4 gap-3 z-10 border-t border-white/10">
      <button :aria-label="playing ? 'Pause' : 'Play'" @click="togglePlay">
        <span class="material-symbols fill text-3xl">{{ playing ? 'pause' : 'play_arrow' }}</span>
      </button>
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
      chapters: [], // [{ contentHref, audioHref, audioUrl, pars: [{ fragId, start, end }] }]
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
    this.initEpub().catch((e) => {
      console.error('StorytellerReader init failed', e)
      this.error = this.$strings.MessageReadAlongLoadFailed || 'Failed to load read-along'
    })
  },
  beforeDestroy() {
    this.pause()
    // ponytail: revoke blob URLs to free the (large) embedded audio
    for (const ch of this.chapters) {
      if (ch.audioUrl) URL.revokeObjectURL(ch.audioUrl)
    }
    if (this.book) this.book.destroy()
  }
}
</script>
