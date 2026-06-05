const Path = require('path')
const fsExtra = require('../libs/fsExtra')
const Logger = require('../Logger')
const Database = require('../Database')
const Watcher = require('../Watcher')
const TaskManager = require('../managers/TaskManager')
const { filePathToPOSIX, getFileTimestampsWithIno } = require('./fileUtils')
const { buildReorganizePlan } = require('./reorganizePlanner')

const inFlightLibraries = new Set()

function isLibraryReorganizing(libraryId) {
  return inFlightLibraries.has(libraryId)
}

/**
 * Try to restore a moved file/folder back to its original location.
 * Returns true if the source path is in its original place at the end.
 *
 * @param {string} fromAbs - the original source path
 * @param {string} toAbs - the new path the file/folder was moved to
 */
async function tryRollbackMove(fromAbs, toAbs) {
  try {
    const stillAtNew = await fsExtra.pathExists(toAbs)
    if (!stillAtNew) return false
    const sourceExists = await fsExtra.pathExists(fromAbs)
    if (sourceExists) return false // can't restore without overwriting
    await fsExtra.move(toAbs, fromAbs, { overwrite: false })
    return true
  } catch (err) {
    Logger.error(`[reorganizeExecutor] Rollback move failed (${toAbs} -> ${fromAbs}):`, err.message)
    return false
  }
}

/**
 * Re-stat a file or folder and return ino + timestamps + size, or null.
 *
 * @param {string} absPath
 */
async function safeStat(absPath) {
  return getFileTimestampsWithIno(absPath).then((s) => s || null).catch(() => null)
}

/**
 * Apply path/ino rewrites to libraryFiles, audioFiles, ebookFile, coverPath of a
 * library item that has just been moved to `move.toAbsPath`. Does NOT persist.
 *
 * @param {import('../models/LibraryItem')} libraryItem
 * @param {import('../models/Book')} book
 * @param {object} move
 */
async function applyPathRewrites(libraryItem, book, move) {
  // LibraryItem-level fields
  libraryItem.path = move.toAbsPath
  libraryItem.relPath = move.toRelPath
  const itemStat = await safeStat(move.toAbsPath)
  if (itemStat) {
    libraryItem.ino = itemStat.ino
    libraryItem.mtime = new Date(itemStat.mtimeMs)
    libraryItem.ctime = new Date(itemStat.ctimeMs)
    if (!libraryItem.isFile) {
      // For folder items, size is sum of libraryFiles; don't overwrite.
    } else {
      libraryItem.size = itemStat.size
    }
  }

  // Helper: find a libraryFile entry by old ino first, falling back to filename.
  const findByInoOrFilename = (arr, oldIno, fromPath) => {
    if (!Array.isArray(arr)) return null
    let entry = oldIno ? arr.find((x) => x.ino === oldIno) : null
    if (entry) return entry
    if (!fromPath) return null
    const filename = Path.basename(fromPath)
    return arr.find((x) => x.metadata?.filename === filename) || null
  }

  // libraryFiles
  if (Array.isArray(libraryItem.libraryFiles) && move.fileChanges?.length) {
    let touched = false
    for (const fc of move.fileChanges) {
      const lf = findByInoOrFilename(libraryItem.libraryFiles, fc.ino, fc.fromPath)
      if (!lf) {
        Logger.warn(`[reorganizeExecutor] libraryFile entry not found for ino=${fc.ino} path=${fc.fromPath}`)
        continue
      }
      lf.metadata.path = fc.toPath
      lf.metadata.relPath = fc.toRelPath
      const s = await safeStat(fc.toPath)
      if (s) {
        lf.ino = s.ino
        lf.metadata.mtimeMs = s.mtimeMs
        lf.metadata.ctimeMs = s.ctimeMs
      }
      touched = true
    }
    if (touched) libraryItem.changed('libraryFiles', true)
  }

  // Book.audioFiles
  if (Array.isArray(book.audioFiles) && move.audioFileChanges?.length) {
    let touched = false
    for (const ac of move.audioFileChanges) {
      const af = findByInoOrFilename(book.audioFiles, ac.ino, ac.fromPath)
      if (!af) {
        Logger.warn(`[reorganizeExecutor] audioFile entry not found for ino=${ac.ino} path=${ac.fromPath}`)
        continue
      }
      af.metadata.path = ac.toPath
      af.metadata.relPath = ac.toRelPath
      const s = await safeStat(ac.toPath)
      if (s) {
        af.ino = s.ino
        af.metadata.mtimeMs = s.mtimeMs
        af.metadata.ctimeMs = s.ctimeMs
      }
      touched = true
    }
    if (touched) book.changed('audioFiles', true)
  }

  // Book.ebookFile
  if (book.ebookFile && move.ebookFileChange) {
    book.ebookFile.metadata.path = move.ebookFileChange.toPath
    book.ebookFile.metadata.relPath = move.ebookFileChange.toRelPath
    const s = await safeStat(move.ebookFileChange.toPath)
    if (s) {
      book.ebookFile.ino = s.ino
      book.ebookFile.metadata.mtimeMs = s.mtimeMs
      book.ebookFile.metadata.ctimeMs = s.ctimeMs
    }
    book.changed('ebookFile', true)
  }

  // Book.coverPath
  if (move.coverChange) {
    book.coverPath = move.coverChange.toPath
  }
}

/**
 * Execute a single move with watcher suppression + per-move transactional DB update.
 * Returns one of:
 *   { outcome: 'succeeded', itemId, fromRelPath, toRelPath }
 *   { outcome: 'failed', itemId, fromRelPath, toRelPath, reason, error?, rolledBack? }
 *
 * @param {object} move - from buildReorganizePlan
 */
async function executeSingleMove(move) {
  const fromAbs = move.fromAbsPath
  const toAbs = move.toAbsPath
  const cleanupWatcher = () => {
    try { Watcher.removeIgnoreDir(fromAbs) } catch (e) { /* noop */ }
    try { Watcher.removeIgnoreDir(toAbs) } catch (e) { /* noop */ }
  }

  Watcher.addIgnoreDir(fromAbs)
  Watcher.addIgnoreDir(toAbs)

  // Pre-checks
  if (!(await fsExtra.pathExists(fromAbs))) {
    cleanupWatcher()
    return { outcome: 'failed', itemId: move.itemId, fromRelPath: move.fromRelPath, toRelPath: move.toRelPath, reason: 'sourceVanished' }
  }
  if (await fsExtra.pathExists(toAbs)) {
    cleanupWatcher()
    return { outcome: 'failed', itemId: move.itemId, fromRelPath: move.fromRelPath, toRelPath: move.toRelPath, reason: 'destinationExists' }
  }

  // Ensure parent dir exists
  try {
    await fsExtra.ensureDir(Path.dirname(toAbs))
  } catch (err) {
    cleanupWatcher()
    return { outcome: 'failed', itemId: move.itemId, fromRelPath: move.fromRelPath, toRelPath: move.toRelPath, reason: 'ensureDirFailed', error: err.message }
  }

  // The move itself
  try {
    await fsExtra.move(fromAbs, toAbs, { overwrite: false })
  } catch (err) {
    cleanupWatcher()
    return { outcome: 'failed', itemId: move.itemId, fromRelPath: move.fromRelPath, toRelPath: move.toRelPath, reason: 'moveError', error: err.message }
  }

  // Re-load fresh from DB and apply rewrites in a transaction
  const sequelize = Database.sequelize
  const t = await sequelize.transaction()
  try {
    const libraryItem = await Database.libraryItemModel.findByPk(move.itemId, { transaction: t })
    if (!libraryItem) {
      throw new Error('LibraryItem disappeared from DB')
    }
    const book = await libraryItem.getMedia({ transaction: t })
    if (!book) {
      throw new Error('Book disappeared from DB')
    }
    await applyPathRewrites(libraryItem, book, move)
    await book.save({ transaction: t })
    await libraryItem.save({ transaction: t })
    await t.commit()
  } catch (err) {
    try { await t.rollback() } catch (e) { /* noop */ }
    const rolledBack = await tryRollbackMove(fromAbs, toAbs)
    cleanupWatcher()
    return {
      outcome: 'failed',
      itemId: move.itemId,
      fromRelPath: move.fromRelPath,
      toRelPath: move.toRelPath,
      reason: 'dbError',
      error: err.message,
      rolledBack
    }
  }

  cleanupWatcher()
  return { outcome: 'succeeded', itemId: move.itemId, fromRelPath: move.fromRelPath, toRelPath: move.toRelPath }
}

/**
 * Execute a batch of reorganization moves. Each move is independently
 * transactional. The client's requested moves are re-planned and verified
 * against the original destinations the client saw.
 *
 * @param {import('../models/Library')} library
 * @param {Array<{itemId:string, expectedToRelPath:string}>} requested
 * @param {import('../objects/Task')} task
 * @returns {Promise<{ succeeded: Array, failed: Array, stale: Array }>}
 */
async function executeReorganization(library, requested, task) {
  if (inFlightLibraries.has(library.id)) {
    throw new Error('A reorganization is already in progress for this library')
  }
  inFlightLibraries.add(library.id)
  try {
    const plan = await buildReorganizePlan(library)
    const planByItemId = new Map(plan.moves.map((m) => [m.itemId, m]))

    const succeeded = []
    const failed = []
    const stale = []
    const toExecute = []

    // Resolve client requests against the fresh plan
    for (const req of requested) {
      const planned = planByItemId.get(req.itemId)
      if (!planned) {
        // Either already correct, blocked, or in conflicts now.
        stale.push({
          itemId: req.itemId,
          requestedToRelPath: req.expectedToRelPath,
          freshToRelPath: null,
          reason: 'noLongerPlanned'
        })
        continue
      }
      if (planned.toRelPath !== req.expectedToRelPath) {
        stale.push({
          itemId: req.itemId,
          requestedToRelPath: req.expectedToRelPath,
          freshToRelPath: planned.toRelPath,
          reason: 'destinationChanged'
        })
        continue
      }
      toExecute.push(planned)
    }

    const total = toExecute.length
    let done = 0
    for (const mv of toExecute) {
      const result = await executeSingleMove(mv)
      if (result.outcome === 'succeeded') succeeded.push(result)
      else failed.push(result)
      done++

      // Push progress through the existing task event channel
      task.description = `Moved ${done} of ${total}`
      task.descriptionKey = null
      task.descriptionSubs = null
      TaskManager.notifyTaskUpdate(task)
    }

    return { succeeded, failed, stale }
  } finally {
    inFlightLibraries.delete(library.id)
  }
}

module.exports = {
  executeReorganization,
  isLibraryReorganizing
}
