<template>
  <div>
    <app-settings-content header-text="Reorganize Files" description="Build path templates from book metadata, scan for misplaced books, then move them into a consistent folder structure. Listening progress and metadata are preserved.">
      <template #header-items>
        <div class="grow" />
        <ui-dropdown v-if="bookLibraries.length > 1" v-model="selectedLibraryId" :items="libraryItems" small class="w-60" />
      </template>

      <div v-if="!bookLibraries.length" class="text-warning text-sm">Reorganize requires at least one book library.</div>
    </app-settings-content>

    <!-- Templates -->
    <app-settings-content v-if="library" header-text="Templates" description="Click a placeholder below to add it. Click a chip in your template to remove it. Missing series or seriesSequence collapse cleanly.">
      <form @submit.prevent="saveTemplates">
        <!-- Folder template -->
        <p class="px-1 text-sm font-semibold mb-1">Folder template</p>
        <div class="bg-primary/40 rounded p-3 min-h-14 flex items-center gap-1 flex-wrap mb-2">
          <template v-if="folderTokens.length">
            <template v-for="(tok, i) in folderTokens">
              <span v-if="i > 0" :key="`fsep-${i}`" class="text-gray-400 font-mono select-none">/</span>
              <button :key="`ftok-${i}`" type="button" class="bg-success/20 hover:bg-error/40 text-success hover:text-error px-2 py-1 rounded text-xs font-mono inline-flex items-center gap-1 transition-colors" @click="removeFolderToken(i)">
                {{ tok }}
                <span class="material-symbols text-sm leading-none">close</span>
              </button>
            </template>
          </template>
          <span v-else class="text-gray-500 text-xs italic">Click a placeholder below to start building…</span>
        </div>
        <div class="flex gap-1 flex-wrap mb-4">
          <button v-for="ph in availablePlaceholders" :key="`fadd-${ph}`" type="button" class="bg-primary border border-white/10 hover:border-success hover:bg-primary/60 px-2 py-1 rounded text-xs font-mono" :disabled="folderTokens.includes(`{${ph}}`)" :class="{ 'opacity-40 cursor-not-allowed hover:border-white/10 hover:bg-primary': folderTokens.includes(`{${ph}}`) }" @click="addFolderToken(ph)">{{ '{' + ph + '}' }}</button>
        </div>

        <!-- File template -->
        <p class="px-1 text-sm font-semibold mb-1">File template</p>
        <div class="bg-primary/40 rounded p-3 min-h-14 flex items-center gap-1 flex-wrap mb-2">
          <template v-if="fileTokens.length">
            <template v-for="(tok, i) in fileTokens">
              <span v-if="i > 0" :key="`flsep-${i}`" class="text-gray-400 font-mono select-none">·</span>
              <button :key="`fltok-${i}`" type="button" class="bg-success/20 hover:bg-error/40 text-success hover:text-error px-2 py-1 rounded text-xs font-mono inline-flex items-center gap-1 transition-colors" @click="removeFileToken(i)">
                {{ tok }}
                <span class="material-symbols text-sm leading-none">close</span>
              </button>
            </template>
          </template>
          <span v-else class="text-gray-500 text-xs italic">Click a placeholder below to start building…</span>
        </div>
        <div class="flex gap-1 flex-wrap mb-4">
          <button v-for="ph in availablePlaceholders" :key="`fladd-${ph}`" type="button" class="bg-primary border border-white/10 hover:border-success hover:bg-primary/60 px-2 py-1 rounded text-xs font-mono" :disabled="fileTokens.includes(`{${ph}}`)" :class="{ 'opacity-40 cursor-not-allowed hover:border-white/10 hover:bg-primary': fileTokens.includes(`{${ph}}`) }" @click="addFileToken(ph)">{{ '{' + ph + '}' }}</button>
        </div>

        <!-- Preview -->
        <div class="flex flex-wrap -mx-1 mb-2">
          <div class="w-full md:w-2/3 px-1 py-1">
            <p class="px-1 text-sm font-semibold mb-1">Preview path</p>
            <div class="bg-primary/40 rounded p-3 font-mono text-xs min-h-10 flex items-center">
              <span v-if="previewError" class="text-error">{{ previewError }}</span>
              <span v-else-if="previewResult" :class="previewResult.blocked ? 'text-warning' : 'text-success'" class="break-all">{{ previewResult.fullPath || '(empty)' }}</span>
              <span v-else class="text-gray-400">…</span>
            </div>
            <p v-if="previewResult && previewResult.blocked" class="text-xs text-warning mt-1">⚠ {{ previewBlockedReason }}</p>
          </div>
          <div class="w-full md:w-1/3 px-1 py-1">
            <ui-dropdown v-model="previewBookId" :items="sampleBookItems" label="Sample book" small :disabled="loadingSampleBooks" />
          </div>
        </div>

        <div class="flex items-center justify-end pt-2">
          <ui-btn type="submit" :loading="savingTemplates" :disabled="!templatesDirty">{{ templatesDirty ? 'Save templates' : 'Saved' }}</ui-btn>
        </div>
        <p v-if="saveError" class="text-sm text-error mt-2">{{ saveError }}</p>
      </form>
    </app-settings-content>

    <!-- Scan -->
    <app-settings-content v-if="library" header-text="Scan" description="Scan the library for books whose paths don't match the templates.">
      <template #header-items>
        <div class="grow" />
        <ui-btn color="bg-warning" class="text-bg" small :loading="isScanning" :disabled="isApplying || templatesDirty" @click="startScan">Scan for misplaced books</ui-btn>
      </template>
      <p v-if="templatesDirty" class="text-xs text-warning">Save your templates before scanning.</p>
      <p v-if="scanError" class="text-sm text-error mt-2">{{ scanError }}</p>
    </app-settings-content>

    <!-- Results -->
    <app-settings-content v-if="plan" header-text="Results">
      <p class="text-sm text-gray-300 mb-3">
        <span class="text-success">{{ plan.summary.willMove }}</span> to move ·
        <span>{{ plan.summary.alreadyCorrect }}</span> already correct ·
        <span class="text-warning">{{ plan.summary.blocked }}</span> blocked ·
        <span class="text-error">{{ plan.summary.conflicts }}</span> conflicts
      </p>

      <div v-if="!plan.moves.length" class="text-gray-300 text-sm py-2">Nothing to move — everything matches the templates.</div>

      <div v-else>
        <div class="flex items-center mb-2">
          <ui-checkbox :value="allSelected" :partial="someSelected && !allSelected" check-color="success" @input="toggleAll" />
          <span class="ml-2 text-sm text-gray-300">Select all ({{ selectedMoveIds.size }} / {{ plan.moves.length }})</span>
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
                  <ui-checkbox :value="selectedMoveIds.has(m.itemId)" check-color="success" @input="toggleMove(m.itemId)" />
                </td>
                <td class="p-2 align-top break-words">{{ m.title }}</td>
                <td class="p-2 align-top font-mono break-all text-gray-300">{{ m.fromRelPath }}</td>
                <td class="p-2 align-top font-mono break-all text-success">{{ m.toRelPath }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-if="plan.blocked.length" class="mt-4">
        <button type="button" class="flex items-center text-sm text-warning" @click="showBlocked = !showBlocked">
          <span class="material-symbols">{{ showBlocked ? 'expand_more' : 'chevron_right' }}</span>
          Blocked ({{ plan.blocked.length }})
        </button>
        <div v-if="showBlocked" class="mt-2 border border-warning/30 rounded">
          <table class="w-full text-xs">
            <thead class="bg-primary/40 text-left"><tr><th class="p-2">Book</th><th class="p-2">Reason</th></tr></thead>
            <tbody>
              <tr v-for="b in plan.blocked" :key="b.itemId" class="border-t border-white/5"><td class="p-2">{{ b.title }}</td><td class="p-2 font-mono">{{ formatBlocked(b) }}</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-if="plan.conflicts.length" class="mt-3">
        <button type="button" class="flex items-center text-sm text-error" @click="showConflicts = !showConflicts">
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

      <div class="flex items-center justify-end pt-4">
        <span v-if="isApplying" class="mr-3 text-sm text-gray-300">{{ applyProgressLabel }}</span>
        <ui-btn color="bg-success" class="text-bg" :loading="isApplying" :disabled="!canApply" @click="startApply">Apply {{ selectedMoveIds.size }} selected</ui-btn>
      </div>
      <p v-if="applyError" class="text-sm text-error mt-2">{{ applyError }}</p>
    </app-settings-content>

    <!-- Apply Result -->
    <app-settings-content v-if="applyResult" header-text="Apply Result">
      <p class="text-sm text-gray-300 mb-3">
        <span class="text-success">{{ applyResult.succeeded.length }}</span> succeeded ·
        <span class="text-error">{{ applyResult.failed.length }}</span> failed ·
        <span class="text-warning">{{ applyResult.stale.length }}</span> stale
      </p>
      <details v-if="applyResult.failed.length" open class="mb-3">
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
        <p class="text-xs text-gray-400 mt-1">These items' destinations changed between scanning and applying (likely metadata edits). Re-scan to refresh.</p>
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
    </app-settings-content>

    <!-- Cleanup -->
    <app-settings-content v-if="library" header-text="Clean up empty folders" description="Remove empty directories, cascading up to (but never including) library roots. OS metadata (.DS_Store, Thumbs.db, desktop.ini, ._*) inside otherwise-empty folders is removed alongside.">
      <template #header-items>
        <div class="grow" />
        <ui-btn color="bg-warning" class="text-bg" small :loading="isCleanupScanning" :disabled="isCleanupApplying || isScanning || isApplying" @click="startCleanupScan">Scan for empty folders</ui-btn>
      </template>

      <p v-if="cleanupScanError" class="text-sm text-error">{{ cleanupScanError }}</p>

      <div v-if="cleanupPlan" class="mt-2">
        <p class="text-sm text-gray-300 mb-2">
          <span class="text-warning">{{ cleanupPlan.summary.total }}</span> empty folders found
        </p>

        <div v-if="!cleanupPlan.folders.length" class="text-gray-300 text-sm py-2">Nothing to clean up.</div>

        <div v-else>
          <div class="flex items-center mb-2">
            <ui-checkbox :value="allCleanupSelected" :partial="someCleanupSelected && !allCleanupSelected" check-color="success" @input="toggleAllCleanup" />
            <span class="ml-2 text-sm text-gray-300">Select all ({{ selectedCleanupPaths.size }} / {{ cleanupPlan.folders.length }})</span>
          </div>
          <div class="overflow-x-auto border border-white/10 rounded">
            <table class="w-full text-xs">
              <thead class="bg-primary/40 text-left">
                <tr><th class="p-2 w-8"></th><th class="p-2">Folder</th><th class="p-2">Reason</th></tr>
              </thead>
              <tbody>
                <tr v-for="f in cleanupPlan.folders" :key="f.absPath" class="border-t border-white/5 hover:bg-primary/10">
                  <td class="p-2 align-top">
                    <ui-checkbox :value="selectedCleanupPaths.has(f.absPath)" check-color="success" @input="toggleCleanupPath(f.absPath)" />
                  </td>
                  <td class="p-2 align-top font-mono break-all">{{ f.relPath }}</td>
                  <td class="p-2 align-top">{{ formatCleanupReason(f.reason) }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="flex items-center justify-end pt-3">
            <span v-if="isCleanupApplying" class="mr-3 text-sm text-gray-300">{{ cleanupProgressLabel }}</span>
            <ui-btn color="bg-error" :loading="isCleanupApplying" :disabled="!canCleanupApply" @click="startCleanupApply">Delete {{ selectedCleanupPaths.size }} selected</ui-btn>
          </div>
          <p v-if="cleanupApplyError" class="text-sm text-error mt-2">{{ cleanupApplyError }}</p>
        </div>
      </div>

      <div v-if="cleanupResult" class="mt-4 border-t border-white/10 pt-3">
        <p class="text-sm text-gray-300 mb-2">
          <span class="text-success">{{ cleanupResult.succeeded.length }}</span> removed ·
          <span class="text-error">{{ cleanupResult.failed.length }}</span> failed ·
          <span class="text-warning">{{ cleanupResult.skipped.length }}</span> skipped
        </p>
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
    </app-settings-content>
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
      previewBookId: '',
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
    libraryItems() {
      return this.bookLibraries.map((l) => ({ value: l.id, text: l.name }))
    },
    sampleBookItems() {
      return [{ value: '', text: '— Use canned sample —' }, ...this.sampleBooks.map((b) => ({ value: b.id, text: b.title }))]
    },
    availablePlaceholders() {
      return ['author', 'series', 'seriesSequence', 'title', 'narrator', 'publishedYear', 'subtitle', 'language', 'isbn', 'asin']
    },
    folderTokens() {
      return this.parseTokens(this.folderTemplate)
    },
    fileTokens() {
      return this.parseTokens(this.fileTemplate)
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
    allSelected() { return !!this.plan?.moves.length && this.selectedMoveIds.size === this.plan.moves.length },
    someSelected() { return this.selectedMoveIds.size > 0 },
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
    allCleanupSelected() { return !!this.cleanupPlan?.folders.length && this.selectedCleanupPaths.size === this.cleanupPlan.folders.length },
    someCleanupSelected() { return this.selectedCleanupPaths.size > 0 },
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
    parseTokens(tmpl) {
      if (!tmpl) return []
      const matches = tmpl.match(/\{[^{}]+\}/g) || []
      return matches.filter((m) => this.availablePlaceholders.includes(m.slice(1, -1)))
    },
    addFolderToken(placeholder) {
      const token = `{${placeholder}}`
      if (this.folderTokens.includes(token)) return
      const tokens = [...this.folderTokens, token]
      this.folderTemplate = tokens.join('/')
    },
    removeFolderToken(index) {
      const tokens = [...this.folderTokens]
      tokens.splice(index, 1)
      this.folderTemplate = tokens.join('/')
    },
    addFileToken(placeholder) {
      const token = `{${placeholder}}`
      if (this.fileTokens.includes(token)) return
      const tokens = [...this.fileTokens, token]
      this.fileTemplate = tokens.join(' ')
    },
    removeFileToken(index) {
      const tokens = [...this.fileTokens]
      tokens.splice(index, 1)
      this.fileTemplate = tokens.join(' ')
    },
    formatBlocked(b) {
      if (b.reason === 'missingPlaceholder') return `missing {${b.placeholder}}`
      return b.reason
    },
    formatCleanupReason(r) {
      if (r === 'empty') return 'empty'
      if (r === 'onlyJunk') return 'only OS junk'
      if (r === 'cascade') return 'cascade'
      return r
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
      this.previewBookId = ''
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
          if (t.isFailed) this.scanError = t.error || 'Scan failed'
          else if (t.data?.plan) {
            this.plan = t.data.plan
            this.selectedMoveIds = new Set(this.plan.moves.map((m) => m.itemId))
          }
          this.scanTaskId = null
        }
      }
      if (this.applyTaskId) {
        const t = this.findTask(this.applyTaskId)
        if (t && t.isFinished) {
          if (t.isFailed) this.applyError = t.error || 'Apply failed'
          else if (t.data?.result) {
            this.applyResult = t.data.result
            this.startScan()
          }
          this.applyTaskId = null
        }
      }
      if (this.cleanupScanTaskId) {
        const t = this.findTask(this.cleanupScanTaskId)
        if (t && t.isFinished) {
          if (t.isFailed) this.cleanupScanError = t.error || 'Cleanup scan failed'
          else if (t.data?.cleanupPlan) {
            this.cleanupPlan = t.data.cleanupPlan
            this.selectedCleanupPaths = new Set(this.cleanupPlan.folders.map((f) => f.absPath))
          }
          this.cleanupScanTaskId = null
        }
      }
      if (this.cleanupApplyTaskId) {
        const t = this.findTask(this.cleanupApplyTaskId)
        if (t && t.isFinished) {
          if (t.isFailed) this.cleanupApplyError = t.error || 'Cleanup failed'
          else if (t.data?.cleanupResult) {
            this.cleanupResult = t.data.cleanupResult
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
