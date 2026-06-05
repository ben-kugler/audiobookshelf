<template>
  <div>
    <div class="bg-bg rounded-md shadow-lg border border-white/5 p-4 mb-4">
      <div class="flex items-center mb-4">
        <h1 class="text-xl">Reorganize Files</h1>
      </div>
      <p class="text-sm text-gray-300 mb-3">
        Build path templates from book metadata, scan for misplaced books, then move them into a consistent folder structure. Listening progress and metadata are preserved.
      </p>

      <!-- Library selector -->
      <div v-if="bookLibraries.length > 1" class="mb-4">
        <label class="text-sm text-gray-300 block mb-1">Library</label>
        <select v-model="selectedLibraryId" class="bg-primary text-white py-2 px-3 rounded border border-black/20 w-full max-w-sm">
          <option v-for="lib in bookLibraries" :key="lib.id" :value="lib.id">{{ lib.name }}</option>
        </select>
      </div>
      <div v-else-if="!bookLibraries.length" class="bg-error/20 border border-error/40 rounded p-3 text-sm">
        Reorganize requires at least one book library.
      </div>
    </div>

    <!-- Templates editor -->
    <div v-if="library" class="bg-bg rounded-md shadow-lg border border-white/5 p-4 mb-4">
      <h2 class="text-lg mb-2">Templates</h2>

      <div class="mb-3">
        <label class="text-sm text-gray-300 block mb-1">Folder template</label>
        <input v-model="folderTemplate" type="text" class="bg-primary text-white py-2 px-3 rounded border border-black/20 w-full font-mono text-sm" placeholder="{author}/{series}/{title}" />
      </div>
      <div class="mb-3">
        <label class="text-sm text-gray-300 block mb-1">File template</label>
        <input v-model="fileTemplate" type="text" class="bg-primary text-white py-2 px-3 rounded border border-black/20 w-full max-w-md font-mono text-sm" placeholder="{title}" />
      </div>

      <div class="mb-3">
        <label class="text-sm text-gray-300 block mb-1">Sample book for preview</label>
        <select v-model="previewBookId" class="bg-primary text-white py-2 px-3 rounded border border-black/20 w-full max-w-md text-sm" :disabled="loadingSampleBooks">
          <option :value="null">— Use canned sample —</option>
          <option v-for="b in sampleBooks" :key="b.id" :value="b.id">{{ b.title }}</option>
        </select>
        <p v-if="loadingSampleBooks" class="text-xs text-gray-400 mt-1">Loading sample books…</p>
      </div>

      <div class="bg-primary/40 rounded p-3 font-mono text-xs">
        <div v-if="previewError" class="text-error">{{ previewError }}</div>
        <div v-else-if="previewResult">
          <div class="text-gray-400">Preview path:</div>
          <div class="text-white break-all">{{ previewResult.fullPath || '(empty)' }}</div>
          <div v-if="previewResult.blocked" class="text-warning mt-1">⚠ {{ previewBlockedReason }}</div>
        </div>
        <div v-else class="text-gray-400">…</div>
      </div>

      <p class="text-xs text-gray-400 mt-2">
        Placeholders: <span class="font-mono">{author} {series} {seriesSequence} {title} {narrator} {publishedYear} {subtitle} {language} {isbn} {asin}</span><br />
        Missing <span class="font-mono">{series}</span> or <span class="font-mono">{seriesSequence}</span> values collapse cleanly. Other placeholders are required if used.
      </p>

      <div class="flex items-center mt-4">
        <button class="bg-primary border border-black/20 hover:bg-primary/80 px-4 py-2 rounded text-sm" :disabled="savingTemplates || !templatesDirty" @click="saveTemplates">
          {{ savingTemplates ? 'Saving…' : (templatesDirty ? 'Save templates' : 'Saved') }}
        </button>
        <span v-if="saveError" class="ml-3 text-sm text-error">{{ saveError }}</span>
      </div>
    </div>

    <!-- Scan -->
    <div v-if="library" class="bg-bg rounded-md shadow-lg border border-white/5 p-4 mb-4">
      <div class="flex items-center justify-between">
        <h2 class="text-lg">Scan</h2>
        <button class="bg-warning text-bg hover:bg-warning/80 px-4 py-2 rounded text-sm font-medium" :disabled="isScanning || isApplying || templatesDirty" @click="startScan">
          {{ isScanning ? 'Scanning…' : 'Scan for misplaced books' }}
        </button>
      </div>
      <p v-if="templatesDirty" class="text-xs text-warning mt-2">Save your templates before scanning.</p>
      <p v-if="scanError" class="text-sm text-error mt-2">{{ scanError }}</p>
    </div>

    <!-- Results -->
    <div v-if="plan" class="bg-bg rounded-md shadow-lg border border-white/5 p-4 mb-4">
      <h2 class="text-lg mb-2">Results</h2>
      <div class="text-sm text-gray-300 mb-3">
        <span class="text-success">{{ plan.summary.willMove }}</span> to move ·
        <span>{{ plan.summary.alreadyCorrect }}</span> already correct ·
        <span class="text-warning">{{ plan.summary.blocked }}</span> blocked ·
        <span class="text-error">{{ plan.summary.conflicts }}</span> conflicts
      </div>

      <div v-if="!plan.moves.length" class="bg-primary/40 rounded p-3 text-sm text-gray-300">
        Nothing to move — everything matches the templates.
      </div>

      <div v-else>
        <div class="flex items-center mb-2">
          <label class="text-sm flex items-center cursor-pointer">
            <input type="checkbox" :checked="allSelected" :indeterminate.prop="someSelected && !allSelected" @change="toggleAll" />
            <span class="ml-2">Select all ({{ selectedMoveIds.size }} / {{ plan.moves.length }})</span>
          </label>
        </div>

        <div class="overflow-x-auto border border-white/10 rounded">
          <table class="w-full text-xs">
            <thead class="bg-primary/40 text-left">
              <tr>
                <th class="p-2 w-8"></th>
                <th class="p-2">Book</th>
                <th class="p-2">From</th>
                <th class="p-2">To</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in plan.moves" :key="m.itemId" class="border-t border-white/5 hover:bg-primary/10">
                <td class="p-2 align-top">
                  <input type="checkbox" :checked="selectedMoveIds.has(m.itemId)" @change="toggleMove(m.itemId)" />
                </td>
                <td class="p-2 align-top break-words">{{ m.title }}</td>
                <td class="p-2 align-top font-mono break-all text-gray-300">{{ m.fromRelPath }}</td>
                <td class="p-2 align-top font-mono break-all text-success">{{ m.toRelPath }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Blocked -->
      <div v-if="plan.blocked.length" class="mt-4">
        <button class="flex items-center text-sm text-warning" @click="showBlocked = !showBlocked">
          <span class="material-symbols">{{ showBlocked ? 'expand_more' : 'chevron_right' }}</span>
          Blocked ({{ plan.blocked.length }})
        </button>
        <div v-if="showBlocked" class="mt-2 border border-warning/30 rounded">
          <table class="w-full text-xs">
            <thead class="bg-primary/40 text-left"><tr><th class="p-2">Book</th><th class="p-2">Reason</th></tr></thead>
            <tbody>
              <tr v-for="b in plan.blocked" :key="b.itemId" class="border-t border-white/5">
                <td class="p-2">{{ b.title }}</td>
                <td class="p-2 font-mono">{{ formatBlocked(b) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Conflicts -->
      <div v-if="plan.conflicts.length" class="mt-3">
        <button class="flex items-center text-sm text-error" @click="showConflicts = !showConflicts">
          <span class="material-symbols">{{ showConflicts ? 'expand_more' : 'chevron_right' }}</span>
          Conflicts ({{ plan.conflicts.length }})
        </button>
        <div v-if="showConflicts" class="mt-2 border border-error/30 rounded">
          <table class="w-full text-xs">
            <thead class="bg-primary/40 text-left"><tr><th class="p-2">Book</th><th class="p-2">Destination</th><th class="p-2">Reason</th></tr></thead>
            <tbody>
              <tr v-for="c in plan.conflicts" :key="c.itemId + c.reason" class="border-t border-white/5">
                <td class="p-2">{{ c.title }}</td>
                <td class="p-2 font-mono break-all">{{ c.toRelPath }}</td>
                <td class="p-2 font-mono">{{ c.reason }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Apply -->
      <div class="mt-4 flex items-center">
        <button class="bg-success text-bg hover:bg-success/80 px-4 py-2 rounded text-sm font-medium" :disabled="!canApply" @click="startApply">
          {{ isApplying ? `Applying… ${applyProgressLabel}` : `Apply ${selectedMoveIds.size} selected` }}
        </button>
        <span v-if="applyError" class="ml-3 text-sm text-error">{{ applyError }}</span>
      </div>
    </div>

    <!-- Apply result -->
    <div v-if="applyResult" class="bg-bg rounded-md shadow-lg border border-white/5 p-4 mb-4">
      <h2 class="text-lg mb-2">Apply Result</h2>
      <div class="text-sm text-gray-300 mb-3">
        <span class="text-success">{{ applyResult.succeeded.length }}</span> succeeded ·
        <span class="text-error">{{ applyResult.failed.length }}</span> failed ·
        <span class="text-warning">{{ applyResult.stale.length }}</span> stale
      </div>
      <details v-if="applyResult.failed.length" open class="mb-2">
        <summary class="cursor-pointer text-sm text-error">Failed ({{ applyResult.failed.length }})</summary>
        <table class="w-full text-xs mt-2">
          <thead class="bg-primary/40 text-left"><tr><th class="p-2">Book id</th><th class="p-2">Target</th><th class="p-2">Reason</th></tr></thead>
          <tbody>
            <tr v-for="f in applyResult.failed" :key="f.itemId" class="border-t border-white/5">
              <td class="p-2 font-mono break-all">{{ f.itemId }}</td>
              <td class="p-2 font-mono break-all">{{ f.toRelPath }}</td>
              <td class="p-2">{{ f.reason }}<span v-if="f.error"> — {{ f.error }}</span><span v-if="f.rolledBack === false" class="text-error"> (filesystem diverged from DB!)</span></td>
            </tr>
          </tbody>
        </table>
      </details>
      <details v-if="applyResult.stale.length" open>
        <summary class="cursor-pointer text-sm text-warning">Stale ({{ applyResult.stale.length }})</summary>
        <p class="text-xs text-gray-400 mt-1">These items' computed destinations changed between scanning and applying (likely because metadata was edited). Re-scan to refresh.</p>
        <table class="w-full text-xs mt-2">
          <thead class="bg-primary/40 text-left"><tr><th class="p-2">Book id</th><th class="p-2">Requested</th><th class="p-2">Now</th></tr></thead>
          <tbody>
            <tr v-for="s in applyResult.stale" :key="s.itemId" class="border-t border-white/5">
              <td class="p-2 font-mono break-all">{{ s.itemId }}</td>
              <td class="p-2 font-mono break-all">{{ s.requestedToRelPath }}</td>
              <td class="p-2 font-mono break-all">{{ s.freshToRelPath || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </details>
    </div>

    <!-- Empty-folder cleanup -->
    <div v-if="library" class="bg-bg rounded-md shadow-lg border border-white/5 p-4 mb-4">
      <div class="flex items-center justify-between">
        <h2 class="text-lg">Clean up empty folders</h2>
        <button class="bg-warning text-bg hover:bg-warning/80 px-4 py-2 rounded text-sm font-medium" :disabled="isCleanupScanning || isCleanupApplying || isScanning || isApplying" @click="startCleanupScan">
          {{ isCleanupScanning ? 'Scanning…' : 'Scan for empty folders' }}
        </button>
      </div>
      <p class="text-xs text-gray-400 mt-1">Removes empty directories, cascading up to (but never including) library roots. OS metadata (<span class="font-mono">.DS_Store</span>, <span class="font-mono">Thumbs.db</span>, <span class="font-mono">desktop.ini</span>, <span class="font-mono">._*</span>) inside otherwise-empty folders is removed alongside.</p>
      <p v-if="cleanupScanError" class="text-sm text-error mt-2">{{ cleanupScanError }}</p>

      <div v-if="cleanupPlan" class="mt-3">
        <div class="text-sm text-gray-300 mb-2">
          <span class="text-warning">{{ cleanupPlan.summary.total }}</span> empty folders found
        </div>

        <div v-if="!cleanupPlan.folders.length" class="bg-primary/40 rounded p-3 text-sm text-gray-300">
          Nothing to clean up.
        </div>

        <div v-else>
          <div class="flex items-center mb-2">
            <label class="text-sm flex items-center cursor-pointer">
              <input type="checkbox" :checked="allCleanupSelected" :indeterminate.prop="someCleanupSelected && !allCleanupSelected" @change="toggleAllCleanup" />
              <span class="ml-2">Select all ({{ selectedCleanupPaths.size }} / {{ cleanupPlan.folders.length }})</span>
            </label>
          </div>

          <div class="overflow-x-auto border border-white/10 rounded">
            <table class="w-full text-xs">
              <thead class="bg-primary/40 text-left">
                <tr>
                  <th class="p-2 w-8"></th>
                  <th class="p-2">Folder</th>
                  <th class="p-2">Reason</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="f in cleanupPlan.folders" :key="f.absPath" class="border-t border-white/5 hover:bg-primary/10">
                  <td class="p-2 align-top">
                    <input type="checkbox" :checked="selectedCleanupPaths.has(f.absPath)" @change="toggleCleanupPath(f.absPath)" />
                  </td>
                  <td class="p-2 align-top font-mono break-all">{{ f.relPath }}</td>
                  <td class="p-2 align-top">{{ formatCleanupReason(f.reason) }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="mt-3 flex items-center">
            <button class="bg-error text-white hover:bg-error/80 px-4 py-2 rounded text-sm font-medium" :disabled="!canCleanupApply" @click="startCleanupApply">
              {{ isCleanupApplying ? `Removing… ${cleanupProgressLabel}` : `Delete ${selectedCleanupPaths.size} selected` }}
            </button>
            <span v-if="cleanupApplyError" class="ml-3 text-sm text-error">{{ cleanupApplyError }}</span>
          </div>
        </div>
      </div>

      <div v-if="cleanupResult" class="mt-4 border-t border-white/10 pt-3">
        <div class="text-sm text-gray-300 mb-2">
          <span class="text-success">{{ cleanupResult.succeeded.length }}</span> removed ·
          <span class="text-error">{{ cleanupResult.failed.length }}</span> failed ·
          <span class="text-warning">{{ cleanupResult.skipped.length }}</span> skipped
        </div>
        <details v-if="cleanupResult.failed.length" open>
          <summary class="cursor-pointer text-sm text-error">Failed ({{ cleanupResult.failed.length }})</summary>
          <ul class="mt-2 text-xs font-mono">
            <li v-for="f in cleanupResult.failed" :key="f.absPath" class="py-1"><span class="break-all">{{ f.absPath }}</span> — {{ f.error }}</li>
          </ul>
        </details>
        <details v-if="cleanupResult.skipped.length">
          <summary class="cursor-pointer text-sm text-warning">Skipped ({{ cleanupResult.skipped.length }})</summary>
          <ul class="mt-2 text-xs font-mono">
            <li v-for="s in cleanupResult.skipped" :key="s.absPath" class="py-1"><span class="break-all">{{ s.absPath }}</span> — {{ s.reason }}</li>
          </ul>
        </details>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  asyncData({ store, redirect }) {
    if (!store.getters['user/getIsAdminOrUp']) redirect('/config/stats')
  },
  data() {
    return {
      selectedLibraryId: null,
      library: null,
      folderTemplate: '',
      fileTemplate: '',
      savedFolderTemplate: '',
      savedFileTemplate: '',
      previewBookId: null,
      previewResult: null,
      previewError: null,
      previewDebounce: null,
      sampleBooks: [],
      loadingSampleBooks: false,

      savingTemplates: false,
      saveError: null,

      scanTaskId: null,
      scanError: null,
      plan: null,

      applyTaskId: null,
      applyError: null,
      applyResult: null,

      selectedMoveIds: new Set(),
      showBlocked: false,
      showConflicts: false,

      cleanupScanTaskId: null,
      cleanupScanError: null,
      cleanupPlan: null,
      cleanupApplyTaskId: null,
      cleanupApplyError: null,
      cleanupResult: null,
      selectedCleanupPaths: new Set(),

      taskUnwatch: null
    }
  },
  computed: {
    bookLibraries() {
      const libs = this.$store.getters['libraries/getSortedLibraries']()
      return libs.filter((l) => l.mediaType === 'book')
    },
    templatesDirty() {
      return this.folderTemplate !== this.savedFolderTemplate || this.fileTemplate !== this.savedFileTemplate
    },
    previewBlockedReason() {
      const r = this.previewResult?.blocked
      if (!r) return ''
      if (r === 'missingTitle') return 'Sample book has no title.'
      if (r === 'emptyFolderTemplate') return 'Folder template resolves to nothing.'
      if (r === 'emptyFileTemplate') return 'File template resolves to nothing.'
      return r
    },
    allSelected() {
      return !!this.plan?.moves.length && this.selectedMoveIds.size === this.plan.moves.length
    },
    someSelected() {
      return this.selectedMoveIds.size > 0
    },
    isScanning() {
      if (!this.scanTaskId) return false
      const t = this.findTask(this.scanTaskId)
      return !t || !t.isFinished
    },
    isApplying() {
      if (!this.applyTaskId) return false
      const t = this.findTask(this.applyTaskId)
      return !t || !t.isFinished
    },
    applyProgressLabel() {
      const t = this.findTask(this.applyTaskId)
      return t?.description || ''
    },
    canApply() {
      return this.plan && this.selectedMoveIds.size > 0 && !this.isApplying && !this.isScanning
    },
    isCleanupScanning() {
      if (!this.cleanupScanTaskId) return false
      const t = this.findTask(this.cleanupScanTaskId)
      return !t || !t.isFinished
    },
    isCleanupApplying() {
      if (!this.cleanupApplyTaskId) return false
      const t = this.findTask(this.cleanupApplyTaskId)
      return !t || !t.isFinished
    },
    cleanupProgressLabel() {
      const t = this.findTask(this.cleanupApplyTaskId)
      return t?.description || ''
    },
    allCleanupSelected() {
      return !!this.cleanupPlan?.folders.length && this.selectedCleanupPaths.size === this.cleanupPlan.folders.length
    },
    someCleanupSelected() {
      return this.selectedCleanupPaths.size > 0
    },
    canCleanupApply() {
      return this.cleanupPlan && this.selectedCleanupPaths.size > 0 && !this.isCleanupApplying && !this.isCleanupScanning && !this.isScanning && !this.isApplying
    }
  },
  watch: {
    selectedLibraryId(newId) {
      if (newId) this.loadLibrary(newId)
    },
    folderTemplate() { this.queuePreview() },
    fileTemplate() { this.queuePreview() },
    previewBookId() { this.queuePreview() }
  },
  methods: {
    findTask(id) {
      if (!id) return null
      return this.$store.state.tasks.tasks.find((t) => t.id === id) || null
    },
    formatBlocked(b) {
      if (b.reason === 'missingPlaceholder') return `missing {${b.placeholder}}`
      return b.reason
    },
    async loadLibrary(libraryId) {
      this.library = null
      this.plan = null
      this.applyResult = null
      this.selectedMoveIds = new Set()
      this.cleanupPlan = null
      this.cleanupResult = null
      this.selectedCleanupPaths = new Set()
      this.sampleBooks = []
      this.previewBookId = null
      try {
        const lib = await this.$axios.$get(`/api/libraries/${libraryId}`)
        this.library = lib
        const r = lib.settings?.reorganize || { folderTemplate: '{author}/{series}/{title}', fileTemplate: '{title}' }
        this.folderTemplate = r.folderTemplate
        this.fileTemplate = r.fileTemplate
        this.savedFolderTemplate = r.folderTemplate
        this.savedFileTemplate = r.fileTemplate
        this.queuePreview()
        this.loadSampleBooks(libraryId)
      } catch (err) {
        console.error('Failed to load library', err)
        this.$toast?.error?.('Failed to load library')
      }
    },
    async loadSampleBooks(libraryId) {
      this.loadingSampleBooks = true
      try {
        const res = await this.$axios.$get(`/api/libraries/${libraryId}/items?limit=200&sort=media.metadata.title`)
        const results = res?.results || res?.libraryItems || []
        this.sampleBooks = results.map((it) => ({ id: it.id, title: it.media?.metadata?.title || it.media?.title || '(untitled)' })).filter((b) => b.title !== '(untitled)')
      } catch (err) {
        console.error('Failed to load sample books', err)
      } finally {
        this.loadingSampleBooks = false
      }
    },
    queuePreview() {
      if (this.previewDebounce) clearTimeout(this.previewDebounce)
      this.previewDebounce = setTimeout(() => this.runPreview(), 350)
    },
    async runPreview() {
      if (!this.library) return
      this.previewError = null
      try {
        const res = await this.$axios.$post(`/api/libraries/${this.library.id}/reorganize/preview`, {
          folderTemplate: this.folderTemplate,
          fileTemplate: this.fileTemplate,
          libraryItemId: this.previewBookId || undefined
        })
        this.previewResult = res
      } catch (err) {
        const msg = err.response?.data || err.message || 'Preview failed'
        this.previewError = typeof msg === 'string' ? msg : 'Preview failed'
        this.previewResult = null
      }
    },
    async saveTemplates() {
      if (!this.library) return
      this.savingTemplates = true
      this.saveError = null
      try {
        await this.$axios.$patch(`/api/libraries/${this.library.id}`, {
          settings: { reorganize: { folderTemplate: this.folderTemplate, fileTemplate: this.fileTemplate } }
        })
        this.savedFolderTemplate = this.folderTemplate
        this.savedFileTemplate = this.fileTemplate
        this.$toast?.success?.('Templates saved')
      } catch (err) {
        const msg = err.response?.data || err.message || 'Save failed'
        this.saveError = typeof msg === 'string' ? msg : 'Save failed'
      } finally {
        this.savingTemplates = false
      }
    },
    async startScan() {
      if (!this.library) return
      this.scanError = null
      this.plan = null
      this.applyResult = null
      this.selectedMoveIds = new Set()
      try {
        const res = await this.$axios.$post(`/api/libraries/${this.library.id}/reorganize/scan`, {})
        this.scanTaskId = res.taskId
      } catch (err) {
        const msg = err.response?.data || err.message || 'Scan failed to start'
        this.scanError = typeof msg === 'string' ? msg : 'Scan failed to start'
      }
    },
    async startApply() {
      if (!this.plan) return
      const moves = this.plan.moves
        .filter((m) => this.selectedMoveIds.has(m.itemId))
        .map((m) => ({ itemId: m.itemId, expectedToRelPath: m.toRelPath }))
      if (!moves.length) return
      this.applyError = null
      this.applyResult = null
      try {
        const res = await this.$axios.$post(`/api/libraries/${this.library.id}/reorganize/apply`, { moves })
        this.applyTaskId = res.taskId
      } catch (err) {
        const msg = err.response?.data || err.message || 'Apply failed to start'
        this.applyError = typeof msg === 'string' ? msg : 'Apply failed to start'
      }
    },
    toggleMove(itemId) {
      const next = new Set(this.selectedMoveIds)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      this.selectedMoveIds = next
    },
    toggleAll() {
      if (this.allSelected) this.selectedMoveIds = new Set()
      else this.selectedMoveIds = new Set(this.plan.moves.map((m) => m.itemId))
    },
    formatCleanupReason(r) {
      if (r === 'empty') return 'empty'
      if (r === 'onlyJunk') return 'only OS junk'
      if (r === 'cascade') return 'cascade'
      return r
    },
    toggleCleanupPath(absPath) {
      const next = new Set(this.selectedCleanupPaths)
      if (next.has(absPath)) next.delete(absPath)
      else next.add(absPath)
      this.selectedCleanupPaths = next
    },
    toggleAllCleanup() {
      if (this.allCleanupSelected) this.selectedCleanupPaths = new Set()
      else this.selectedCleanupPaths = new Set(this.cleanupPlan.folders.map((f) => f.absPath))
    },
    async startCleanupScan() {
      if (!this.library) return
      this.cleanupScanError = null
      this.cleanupPlan = null
      this.cleanupResult = null
      this.selectedCleanupPaths = new Set()
      try {
        const res = await this.$axios.$post(`/api/libraries/${this.library.id}/reorganize/cleanup/scan`, {})
        this.cleanupScanTaskId = res.taskId
      } catch (err) {
        const msg = err.response?.data || err.message || 'Cleanup scan failed to start'
        this.cleanupScanError = typeof msg === 'string' ? msg : 'Cleanup scan failed to start'
      }
    },
    async startCleanupApply() {
      if (!this.cleanupPlan) return
      const paths = this.cleanupPlan.folders
        .filter((f) => this.selectedCleanupPaths.has(f.absPath))
        .map((f) => f.absPath)
      if (!paths.length) return
      this.cleanupApplyError = null
      this.cleanupResult = null
      try {
        const res = await this.$axios.$post(`/api/libraries/${this.library.id}/reorganize/cleanup/apply`, { paths })
        this.cleanupApplyTaskId = res.taskId
      } catch (err) {
        const msg = err.response?.data || err.message || 'Cleanup failed to start'
        this.cleanupApplyError = typeof msg === 'string' ? msg : 'Cleanup failed to start'
      }
    },
    onTasksChanged() {
      if (this.scanTaskId) {
        const t = this.findTask(this.scanTaskId)
        if (t && t.isFinished) {
          if (t.isFailed) {
            this.scanError = t.error || 'Scan failed'
          } else if (t.data?.plan) {
            this.plan = t.data.plan
            this.selectedMoveIds = new Set(this.plan.moves.map((m) => m.itemId))
          }
          this.scanTaskId = null
        }
      }
      if (this.applyTaskId) {
        const t = this.findTask(this.applyTaskId)
        if (t && t.isFinished) {
          if (t.isFailed) {
            this.applyError = t.error || 'Apply failed'
          } else if (t.data?.result) {
            this.applyResult = t.data.result
            // Refresh the plan since paths changed
            this.startScan()
          }
          this.applyTaskId = null
        }
      }
      if (this.cleanupScanTaskId) {
        const t = this.findTask(this.cleanupScanTaskId)
        if (t && t.isFinished) {
          if (t.isFailed) {
            this.cleanupScanError = t.error || 'Cleanup scan failed'
          } else if (t.data?.cleanupPlan) {
            this.cleanupPlan = t.data.cleanupPlan
            this.selectedCleanupPaths = new Set(this.cleanupPlan.folders.map((f) => f.absPath))
          }
          this.cleanupScanTaskId = null
        }
      }
      if (this.cleanupApplyTaskId) {
        const t = this.findTask(this.cleanupApplyTaskId)
        if (t && t.isFinished) {
          if (t.isFailed) {
            this.cleanupApplyError = t.error || 'Cleanup failed'
          } else if (t.data?.cleanupResult) {
            this.cleanupResult = t.data.cleanupResult
            // Re-scan to refresh the remaining empty list
            this.startCleanupScan()
          }
          this.cleanupApplyTaskId = null
        }
      }
    }
  },
  mounted() {
    const first = this.bookLibraries[0]
    if (first) this.selectedLibraryId = first.id
    this.taskUnwatch = this.$store.watch(
      (state) => state.tasks.tasks,
      () => this.onTasksChanged(),
      { deep: true }
    )
  },
  beforeDestroy() {
    if (this.previewDebounce) clearTimeout(this.previewDebounce)
    if (this.taskUnwatch) this.taskUnwatch()
  }
}
</script>
