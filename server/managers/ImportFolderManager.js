const fsExtra = require('../libs/fsExtra')
const Watcher = require('../libs/watcher/watcher')
const Logger = require('../Logger')
const Database = require('../Database')
const SocketAuthority = require('../SocketAuthority')
const { filePathToPOSIX, getFileMTimeMs } = require('../utils/fileUtils')
const { matchSourcePath } = require('../utils/importMatcher')

/**
 * One watcher per library that has importFolder set + importFolderEnabled.
 * Top-level files/folders that appear are debounced until stable, then matched
 * and persisted as PendingImport rows for admin review.
 */
class ImportFolderManager {
  constructor() {
    /** @type {Map<string, { libraryId:string, libraryName:string, importFolder:string, watcher:any }>} */
    this.watchers = new Map()
    /** @type {Map<string, Promise<void>>} */
    this.inFlightEnqueues = new Map()
    /** @type {Set<string>} */
    this.disabledLibraryIds = new Set()
  }

  /**
   * @param {import('../models/Library')[]} libraries
   */
  init(libraries) {
    for (const library of libraries) {
      this.maybeStart(library)
    }
  }

  /**
   * @param {import('../models/Library')} library
   */
  addLibrary(library) {
    this.maybeStart(library)
  }

  /**
   * @param {import('../models/Library')} library
   */
  updateLibrary(library) {
    this.stop(library.id)
    this.maybeStart(library)
  }

  /**
   * @param {string} libraryId
   */
  removeLibrary(libraryId) {
    this.stop(libraryId)
  }

  /**
   * Start a watcher for this library if its settings request it.
   * @param {import('../models/Library')} library
   */
  maybeStart(library) {
    const importFolder = library.settings?.importFolder
    const enabled = !!library.settings?.importFolderEnabled
    if (!importFolder || !enabled) return
    if (library.mediaType !== 'book') return
    if (!library.settings?.audiobooksOnly) {
      Logger.warn(`[ImportFolderManager] Skipping library "${library.name}" — import folder requires audiobooksOnly`)
      return
    }

    const posix = filePathToPOSIX(importFolder)
    fsExtra
      .ensureDir(posix)
      .then(() => this.startWatcher(library, posix))
      .catch((err) => {
        Logger.error(`[ImportFolderManager] Failed to ensure import folder "${posix}" for library "${library.name}":`, err.message)
      })
  }

  /**
   * @param {import('../models/Library')} library
   * @param {string} importFolderPosix
   */
  startWatcher(library, importFolderPosix) {
    if (this.watchers.has(library.id)) return
    Logger.info(`[ImportFolderManager] Watching import folder "${importFolderPosix}" for library "${library.name}"`)

    const watcher = new Watcher(importFolderPosix, {
      ignored: /(^|[\\/])\../, // ignore dotfiles
      recursive: false, // top-level only — folders are treated as whole books
      ignoreInitial: false, // also pick up files already present at startup
      persistent: true
    })
    watcher
      .on('add', (path) => this.onAdded(library.id, filePathToPOSIX(path)))
      .on('addDir', (path) => this.onAdded(library.id, filePathToPOSIX(path)))
      .on('error', (err) => Logger.error(`[ImportFolderManager] Watcher error for "${library.name}":`, err.message))
      .on('ready', () => Logger.debug(`[ImportFolderManager] Watcher ready for "${library.name}"`))

    this.watchers.set(library.id, {
      libraryId: library.id,
      libraryName: library.name,
      importFolder: importFolderPosix,
      watcher
    })
  }

  stop(libraryId) {
    const entry = this.watchers.get(libraryId)
    if (!entry) return
    try {
      entry.watcher.close()
    } catch (err) {
      Logger.warn(`[ImportFolderManager] Error closing watcher: ${err.message}`)
    }
    this.watchers.delete(libraryId)
    Logger.info(`[ImportFolderManager] Stopped watching import folder for library "${entry.libraryName}"`)
  }

  closeAll() {
    for (const id of [...this.watchers.keys()]) this.stop(id)
  }

  /**
   * Wait for an added file/folder's modification time to stabilize (cheap "is it done copying?").
   *
   * @param {string} absPath
   * @param {number} [maxLoops=60]
   * @returns {Promise<boolean>}
   */
  async waitUntilStable(absPath, maxLoops = 60) {
    let last = -1
    for (let i = 0; i < maxLoops; i++) {
      let current
      try {
        current = await getFileMTimeMs(absPath)
      } catch {
        return false
      }
      if (current === last && current > 0) return true
      last = current
      await new Promise((r) => setTimeout(r, 2000))
    }
    Logger.warn(`[ImportFolderManager] Timed out waiting for "${absPath}" to stabilize`)
    return true // proceed anyway — better to have a stale match than to ignore forever
  }

  /**
   * Pipeline: stable-wait → dedup → match → persist → socket emit.
   *
   * @param {string} libraryId
   * @param {string} absPath
   */
  async onAdded(libraryId, absPath) {
    const key = `${libraryId}::${absPath}`
    if (this.inFlightEnqueues.has(key)) return
    const work = (async () => {
      try {
        await this.waitUntilStable(absPath)

        // Reload library to get fresh settings (admin may have changed them)
        const library = await Database.libraryModel.findByPk(libraryId, { include: Database.libraryFolderModel })
        if (!library || !library.settings?.importFolderEnabled || !library.settings?.importFolder) {
          return // watcher's still alive but settings flipped off — skip
        }

        // Ignore the watched folder root itself (some watchers fire an addDir on the root during initial scan).
        if (filePathToPOSIX(library.settings.importFolder).replace(/\/+$/, '') === absPath.replace(/\/+$/, '')) {
          return
        }

        // Dedup: skip if a PendingImport already exists for this source
        const existing = await Database.pendingImportModel.findOne({ where: { libraryId, sourcePath: absPath } })
        if (existing) {
          Logger.debug(`[ImportFolderManager] Skip enqueue, PendingImport already exists for "${absPath}" (status=${existing.status})`)
          return
        }

        // Match
        const proposal = await matchSourcePath(library, absPath)

        // Skip non-ebook sources entirely — no row, no noise
        if (proposal.detectedType !== 'ebook') {
          Logger.debug(`[ImportFolderManager] Ignoring non-ebook source "${absPath}"`)
          return
        }

        // Persist
        const row = await Database.pendingImportModel.create({
          libraryId,
          ...proposal,
          status: 'pending'
        })
        Logger.info(`[ImportFolderManager] Created PendingImport "${row.id}" for "${absPath}" (action=${row.proposedAction}, status=${row.status})`)

        // Notify any admin clients listening
        SocketAuthority.emitter('pending_import_added', row.toJSON())
      } catch (err) {
        Logger.error(`[ImportFolderManager] Failed to enqueue import for "${absPath}":`, err)
      } finally {
        this.inFlightEnqueues.delete(key)
      }
    })()
    this.inFlightEnqueues.set(key, work)
  }
}

module.exports = new ImportFolderManager()
