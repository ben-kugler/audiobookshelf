<template>
  <div>
    <app-settings-content header-text="Imports" description="Ebooks dropped into a library's import folder show up here. Pick the matching audiobook to attach the ebook to it.">
      <template #header-items>
        <div class="grow" />
        <ui-btn small color="bg-primary" :loading="loading" @click="reload">Refresh</ui-btn>
      </template>

      <div class="flex flex-wrap -mx-1 mb-4">
        <div class="w-full md:w-1/2 px-1 py-1">
          <ui-dropdown v-model="libraryFilter" :items="libraryItems" label="Library" small />
        </div>
        <div class="w-full md:w-1/2 px-1 py-1">
          <ui-dropdown v-model="statusFilter" :items="statusItems" label="Show" small />
        </div>
      </div>

      <div v-if="loading" class="text-center py-6 text-gray-300 text-sm">Loading…</div>

      <div v-else-if="!rows.length" class="text-center py-6 text-gray-300">
        Nothing here. Drop an ebook into a library's import folder to get started.
      </div>

      <div v-else class="space-y-3">
        <div v-for="row in rows" :key="row.id" class="bg-primary/30 rounded-md border border-white/5 p-3 flex items-start justify-between gap-4">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
              <span :class="statusBadgeClass(row)" class="text-xs px-2 py-0.5 rounded font-medium uppercase">{{ row.status }}</span>
              <span class="text-xs text-gray-400 uppercase">{{ ebookExt(row) }}</span>
            </div>
            <div class="text-base text-white truncate" :title="ebookFilename(row)">{{ ebookFilename(row) }}</div>
            <div v-if="inferredTitle(row)" class="text-sm text-gray-300 truncate">
              {{ inferredTitle(row) }}<span v-if="inferredAuthor(row)" class="text-gray-400"> · {{ inferredAuthor(row) }}</span>
            </div>
            <div class="font-mono text-xs text-gray-500 mt-1 break-all">{{ row.sourcePath }}</div>
            <div v-if="row.error" class="text-xs text-error mt-1">⚠ {{ row.error }}</div>
          </div>

          <div class="flex flex-col gap-2 items-stretch shrink-0">
            <ui-btn v-if="canMatch(row)" small color="bg-success" class="text-bg" @click="openMatch(row)">Match</ui-btn>
            <ui-btn v-if="canReject(row)" small color="bg-error/30" @click="reject(row)">Reject</ui-btn>
            <button class="text-xs underline text-gray-400 mt-1" @click="deleteRow(row)">Delete</button>
          </div>
        </div>
      </div>
    </app-settings-content>

    <modals-imports-pick-audiobook-modal v-model="showPicker" :row="pickerRow" @updated="onUpdated" />
  </div>
</template>

<script>
export default {
  asyncData({ store, redirect }) {
    if (!store.getters['user/getIsAdminOrUp']) redirect('/config/stats')
  },
  data() {
    return {
      rows: [],
      libraryFilter: '',
      statusFilter: 'pending,failed',
      loading: false,
      showPicker: false,
      pickerRow: null,
      socketHandler: null
    }
  },
  computed: {
    audiobookOnlyLibraries() {
      const libs = this.$store.getters['libraries/getSortedLibraries']()
      return libs.filter((l) => l.mediaType === 'book' && l.settings?.audiobooksOnly)
    },
    libraryItems() {
      return [{ value: '', text: 'All libraries' }, ...this.audiobookOnlyLibraries.map((l) => ({ value: l.id, text: l.name }))]
    },
    statusItems() {
      return [
        { value: 'pending,failed', text: 'Active (pending + failed)' },
        { value: 'pending', text: 'Pending' },
        { value: 'failed', text: 'Failed' },
        { value: 'rejected', text: 'Rejected' },
        { value: 'imported', text: 'Imported' },
        { value: '', text: 'All' }
      ]
    }
  },
  watch: {
    libraryFilter() { this.reload() },
    statusFilter() { this.reload() }
  },
  methods: {
    async reload() {
      this.loading = true
      try {
        const params = []
        if (this.libraryFilter) params.push(`libraryId=${encodeURIComponent(this.libraryFilter)}`)
        if (this.statusFilter) params.push(`status=${encodeURIComponent(this.statusFilter)}`)
        const qs = params.length ? `?${params.join('&')}` : ''
        const res = await this.$axios.$get(`/api/imports${qs}`)
        this.rows = (res.rows || []).filter((r) => r.detectedType === 'ebook' || r.proposedAction === 'attachEbook')
      } catch (err) {
        console.error(err)
        this.$toast?.error?.('Failed to load imports')
      } finally {
        this.loading = false
      }
    },
    statusBadgeClass(r) {
      if (r.status === 'pending') return 'bg-warning text-bg'
      if (r.status === 'importing') return 'bg-primary text-white'
      if (r.status === 'imported') return 'bg-success text-bg'
      if (r.status === 'failed') return 'bg-error text-white'
      if (r.status === 'rejected') return 'bg-gray-500 text-white'
      return 'bg-gray-500 text-white'
    },
    canMatch(row) { return row.status === 'pending' || row.status === 'failed' },
    canReject(row) { return row.status === 'pending' || row.status === 'failed' },
    ebookFilename(row) {
      const path = row.originalMatch?.ebookPath || row.sourcePath
      return (path || '').split('/').pop()
    },
    ebookExt(row) {
      const fn = this.ebookFilename(row)
      const i = fn.lastIndexOf('.')
      return i >= 0 ? fn.slice(i + 1) : ''
    },
    inferredTitle(row) { return row.originalMatch?.inferredFromSource?.title || '' },
    inferredAuthor(row) { return row.originalMatch?.inferredFromSource?.author || '' },
    openMatch(row) {
      this.pickerRow = row
      this.showPicker = true
    },
    onUpdated(updated) {
      const idx = this.rows.findIndex((r) => r.id === updated.id)
      if (idx >= 0) {
        if (updated.status === 'imported' || updated.status === 'rejected') {
          this.rows.splice(idx, 1)
        } else {
          this.$set(this.rows, idx, updated)
        }
      }
    },
    async reject(row) {
      try {
        await this.$axios.$post(`/api/imports/${row.id}/reject`)
        this.rows = this.rows.filter((r) => r.id !== row.id)
      } catch (err) {
        this.$toast?.error?.(err.response?.data || 'Reject failed')
      }
    },
    async deleteRow(row) {
      try {
        await this.$axios.$delete(`/api/imports/${row.id}`)
        this.rows = this.rows.filter((r) => r.id !== row.id)
      } catch (err) {
        this.$toast?.error?.(err.response?.data || 'Delete failed')
      }
    }
  },
  mounted() {
    this.reload()
    if (this.$root && this.$root.socket) {
      this.socketHandler = () => this.reload()
      this.$root.socket.on('pending_import_added', this.socketHandler)
      this.$root.socket.on('pending_import_updated', this.socketHandler)
      this.$root.socket.on('pending_import_removed', this.socketHandler)
    }
  },
  beforeDestroy() {
    if (this.$root && this.$root.socket && this.socketHandler) {
      this.$root.socket.off('pending_import_added', this.socketHandler)
      this.$root.socket.off('pending_import_updated', this.socketHandler)
      this.$root.socket.off('pending_import_removed', this.socketHandler)
    }
  }
}
</script>
