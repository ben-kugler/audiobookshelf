const Path = require('path')
const fsExtra = require('../libs/fsExtra')
const Logger = require('../Logger')
const Database = require('../Database')
const Watcher = require('../Watcher')
const TaskManager = require('../managers/TaskManager')
const { filePathToPOSIX, isSameOrSubPath } = require('./fileUtils')

const JUNK_FILENAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])
const APPLE_DOUBLE_REGEX = /^\._/

const inFlightCleanups = new Set()

function isLibraryCleaningUp(libraryId) {
  return inFlightCleanups.has(libraryId)
}

function isJunkFile(name) {
  return JUNK_FILENAMES.has(name) || APPLE_DOUBLE_REGEX.test(name)
}

/**
 * Walk a directory post-order; collect deletable subtrees into `outList`.
 * Returns `true` if `dirAbsPath` itself should be deleted (treated as gone by its parent).
 *
 * @param {string} dirAbsPath - POSIX absolute path
 * @param {Set<string>} protectedPaths - paths that must never be deleted (library roots + LibraryItem.paths)
 * @param {Array<{absPath:string,relPath:string,libraryFolderId:string,reason:string}>} outList
 * @param {string} libraryFolderRoot - POSIX root path for relPath computation
 * @param {string} libraryFolderId
 * @returns {Promise<boolean>}
 */
async function walkPostOrder(dirAbsPath, protectedPaths, outList, libraryFolderRoot, libraryFolderId) {
  let entries
  try {
    entries = await fsExtra.readdir(dirAbsPath, { withFileTypes: true })
  } catch (err) {
    Logger.warn(`[emptyFolderCleanup] readdir failed for "${dirAbsPath}":`, err.message)
    return false
  }

  let hasOnlyJunkOrDeletable = true
  let hasOnlyJunk = true
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      hasOnlyJunkOrDeletable = false
      hasOnlyJunk = false
      continue
    }
    const childAbs = filePathToPOSIX(Path.join(dirAbsPath, entry.name))
    if (entry.isDirectory()) {
      const childDeletable = await walkPostOrder(childAbs, protectedPaths, outList, libraryFolderRoot, libraryFolderId)
      if (!childDeletable) {
        hasOnlyJunkOrDeletable = false
      }
      hasOnlyJunk = false
    } else if (entry.isFile()) {
      if (!isJunkFile(entry.name)) {
        hasOnlyJunkOrDeletable = false
        hasOnlyJunk = false
      }
    } else {
      hasOnlyJunkOrDeletable = false
      hasOnlyJunk = false
    }
  }

  if (!hasOnlyJunkOrDeletable) return false
  if (protectedPaths.has(dirAbsPath)) return false

  const reason = entries.length === 0 ? 'empty' : (hasOnlyJunk ? 'onlyJunk' : 'cascade')
  const relPath = dirAbsPath.startsWith(libraryFolderRoot)
    ? dirAbsPath.slice(libraryFolderRoot.length) || '/'
    : dirAbsPath
  outList.push({ absPath: dirAbsPath, relPath, libraryFolderId, reason })
  return true
}

/**
 * Scan a library for folders that are empty (or contain only OS junk) and
 * safe to remove. Cascades upward through chains of would-be-empty folders.
 *
 * @param {import('../models/Library')} library - must include libraryFolders
 * @returns {Promise<{folders: Array, summary: {total:number}}>}
 */
async function scanEmptyFolders(library) {
  if (!library.libraryFolders?.length) {
    return { folders: [], summary: { total: 0 } }
  }

  // Protected: library roots + every registered LibraryItem path
  const protectedPaths = new Set()
  for (const lf of library.libraryFolders) {
    protectedPaths.add(filePathToPOSIX(lf.path))
  }
  const items = await Database.libraryItemModel.findAll({
    where: { libraryId: library.id },
    attributes: ['path']
  })
  for (const it of items) {
    if (it.path) protectedPaths.add(filePathToPOSIX(it.path))
  }

  const folders = []
  for (const lf of library.libraryFolders) {
    const root = filePathToPOSIX(lf.path)
    // Walk children of the root, NOT the root itself (root is always protected).
    let rootEntries
    try {
      rootEntries = await fsExtra.readdir(root, { withFileTypes: true })
    } catch (err) {
      Logger.warn(`[emptyFolderCleanup] readdir failed for library folder root "${root}":`, err.message)
      continue
    }
    for (const entry of rootEntries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const childAbs = filePathToPOSIX(Path.join(root, entry.name))
      await walkPostOrder(childAbs, protectedPaths, folders, root, lf.id)
    }
  }

  // Stable ordering by relPath for deterministic UI display
  folders.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return { folders, summary: { total: folders.length } }
}

/**
 * Re-check at apply time that a candidate folder is still deletable.
 *
 * @param {string} absPath
 * @param {Set<string>} protectedPaths
 */
async function recheckDeletable(absPath, protectedPaths) {
  if (protectedPaths.has(absPath)) return false
  let stat
  try {
    stat = await fsExtra.stat(absPath)
  } catch {
    return false
  }
  if (!stat.isDirectory()) return false
  let entries
  try {
    entries = await fsExtra.readdir(absPath, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) return false
    if (entry.isFile()) {
      if (!isJunkFile(entry.name)) return false
    } else if (entry.isDirectory()) {
      // Subdirs are only acceptable if they themselves are deletable; we don't recurse here
      // because the planner sorted deepest-first and removed them before us. So if a subdir
      // is still present at this point, treat as non-empty.
      return false
    } else {
      return false
    }
  }
  return true
}

/**
 * Delete the requested folders if they are still deletable. Returns per-path outcomes.
 *
 * @param {import('../models/Library')} library
 * @param {string[]} requestedAbsPaths - POSIX paths from a fresh scan
 * @param {import('../objects/Task')} task
 * @returns {Promise<{succeeded:Array, failed:Array, skipped:Array}>}
 */
async function deleteEmptyFolders(library, requestedAbsPaths, task) {
  if (inFlightCleanups.has(library.id)) {
    throw new Error('A cleanup is already in progress for this library')
  }
  inFlightCleanups.add(library.id)
  try {
    // Build protected-paths set fresh at apply time
    const protectedPaths = new Set()
    for (const lf of library.libraryFolders || []) {
      protectedPaths.add(filePathToPOSIX(lf.path))
    }
    const items = await Database.libraryItemModel.findAll({
      where: { libraryId: library.id },
      attributes: ['path']
    })
    for (const it of items) {
      if (it.path) protectedPaths.add(filePathToPOSIX(it.path))
    }

    const libraryRoots = (library.libraryFolders || []).map((lf) => filePathToPOSIX(lf.path))

    // Sort deepest-first so cascade-parents become empty before we get to them
    const sorted = [...new Set(requestedAbsPaths.map(filePathToPOSIX))]
      .sort((a, b) => b.split('/').length - a.split('/').length || b.localeCompare(a))

    const succeeded = []
    const failed = []
    const skipped = []
    const total = sorted.length
    let done = 0

    for (const absPath of sorted) {
      done++

      // Defense: path must live under some library folder
      const insideLibrary = libraryRoots.some((root) => isSameOrSubPath(root, absPath) && absPath !== root)
      if (!insideLibrary) {
        skipped.push({ absPath, reason: 'notInLibrary' })
        continue
      }
      if (!(await recheckDeletable(absPath, protectedPaths))) {
        skipped.push({ absPath, reason: 'noLongerEmpty' })
        continue
      }

      Watcher.addIgnoreDir(absPath)
      try {
        await fsExtra.remove(absPath)
        succeeded.push({ absPath })
      } catch (err) {
        Logger.error(`[emptyFolderCleanup] remove failed for "${absPath}":`, err.message)
        failed.push({ absPath, error: err.message })
      } finally {
        try { Watcher.removeIgnoreDir(absPath) } catch { /* noop */ }
      }

      task.description = `Removed ${done} of ${total}`
      task.descriptionKey = null
      task.descriptionSubs = null
      TaskManager.notifyTaskUpdate(task)
    }

    return { succeeded, failed, skipped }
  } finally {
    inFlightCleanups.delete(library.id)
  }
}

module.exports = {
  scanEmptyFolders,
  deleteEmptyFolders,
  isLibraryCleaningUp
}
