<template>
  <modals-modal v-model="show" name="pick-audiobook" :width="900" :height="'unset'" :processing="processing">
    <template #outer>
      <div class="absolute top-0 left-0 p-5 w-2/3 overflow-hidden">
        <p class="text-xl md:text-2xl text-white truncate">Pick audiobook to attach to</p>
      </div>
    </template>

    <div class="px-2 md:px-4 w-full text-sm pt-2 md:pt-6 pb-6 rounded-lg bg-bg shadow-lg border border-black-300 relative overflow-hidden" style="min-height: 400px; max-height: 80vh">
      <div v-if="row" class="text-xs text-gray-300 mb-3 px-1 py-2 bg-primary/30 rounded">
        <span class="text-gray-400">Importing:</span>
        <span class="font-mono break-all">{{ ebookFilename }}</span>
        <span v-if="inferredTitle" class="ml-2 text-white"> — {{ inferredTitle }}<span v-if="inferredAuthor"> by {{ inferredAuthor }}</span></span>
      </div>

      <div class="flex items-center gap-2 mb-3">
        <input v-model="search" type="text" placeholder="Filter by title or author…" class="bg-primary border border-black/20 px-3 py-2 rounded grow text-sm" @input="onSearchInput" />
        <span class="text-xs text-gray-400">{{ filteredCount }} of {{ allCount }}</span>
      </div>

      <div v-if="loading" class="text-gray-300 text-sm py-12 text-center">Loading audiobooks…</div>
      <div v-else-if="!candidates.length" class="text-gray-300 text-sm py-12 text-center">No audiobooks in this library yet.</div>
      <div v-else-if="!visible.length" class="text-gray-300 text-sm py-12 text-center">No matches for "{{ search }}".</div>

      <div v-else class="grid grid-cols-2 md:grid-cols-3 gap-3 overflow-y-auto" style="max-height: 60vh">
        <div v-for="c in visible" :key="c.id" class="bg-primary/30 rounded p-2 cursor-pointer hover:bg-primary/60 border border-transparent hover:border-warning" @click="pick(c)">
          <div class="flex items-start gap-2">
            <img :src="coverSrc(c)" alt="" class="w-16 h-24 object-cover rounded bg-bg" @error="onImgError($event)" />
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium text-white truncate" :title="c.title">{{ c.title }}</div>
              <div class="text-xs text-gray-300 truncate" :title="c.authors.join(', ')">{{ c.authors.join(', ') || '—' }}</div>
              <div v-if="c.series.length" class="text-xs text-gray-400 truncate">
                {{ c.series.map((s) => (s.sequence ? `${s.name} #${s.sequence}` : s.name)).join(', ') }}
              </div>
              <div v-if="c.hasEbook" class="text-xs text-warning mt-1">⚠ already has ebook</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </modals-modal>
</template>

<script>
export default {
  props: {
    value: Boolean,
    row: {
      type: Object,
      default: () => null
    }
  },
  data() {
    return {
      processing: false,
      loading: false,
      candidates: [],
      search: '',
      searchDebounce: null
    }
  },
  computed: {
    show: {
      get() { return this.value },
      set(v) { this.$emit('input', v) }
    },
    ebookFilename() {
      if (!this.row) return ''
      const path = this.row.originalMatch?.ebookPath || this.row.sourcePath
      return path.split('/').pop()
    },
    inferredTitle() {
      return this.row?.originalMatch?.inferredFromSource?.title || ''
    },
    inferredAuthor() {
      return this.row?.originalMatch?.inferredFromSource?.author || ''
    },
    allCount() { return this.candidates.length },
    filteredCount() { return this.visible.length },
    visible() {
      const q = this.search.trim().toLowerCase()
      if (!q) return this.candidates
      return this.candidates.filter((c) => {
        const title = (c.title || '').toLowerCase()
        const authors = c.authors.join(' ').toLowerCase()
        return title.includes(q) || authors.includes(q)
      })
    }
  },
  watch: {
    show(v) {
      if (v) this.init()
    }
  },
  methods: {
    init() {
      this.search = ''
      this.candidates = []
      this.loadCandidates()
    },
    async loadCandidates() {
      if (!this.row?.libraryId) return
      this.loading = true
      try {
        const res = await this.$axios.$get(`/api/imports/candidates?libraryId=${encodeURIComponent(this.row.libraryId)}`)
        this.candidates = res.candidates || []
      } catch (err) {
        console.error(err)
        this.$toast?.error?.('Failed to load audiobooks')
      } finally {
        this.loading = false
      }
    },
    coverSrc(c) {
      // Use the same cover endpoint the rest of the UI uses
      const token = this.$store.getters['user/getToken']
      const base = `/api/items/${c.id}/cover`
      return token ? `${base}?token=${token}` : base
    },
    onImgError(evt) {
      evt.target.style.visibility = 'hidden'
    },
    onSearchInput() {
      // Pure client-side filter; no API call needed
    },
    async pick(candidate) {
      if (!this.row || this.processing) return
      this.processing = true
      try {
        const updated = await this.$axios.$patch(`/api/imports/${this.row.id}`, { attachToLibraryItemId: candidate.id })
        // Approve immediately after picking — the spec is "pick then attach"
        const approved = await this.$axios.$post(`/api/imports/${updated.id}/approve`)
        this.$emit('updated', approved)
        if (approved.status === 'imported') {
          this.$toast?.success?.(`Attached to "${candidate.title}"`)
          this.show = false
        } else {
          this.$toast?.error?.(approved.error || 'Attach failed')
        }
      } catch (err) {
        console.error(err)
        this.$toast?.error?.(err.response?.data || 'Attach failed')
      } finally {
        this.processing = false
      }
    }
  }
}
</script>
