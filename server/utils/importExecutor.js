const Path = require('path')
const fsExtra = require('../libs/fsExtra')
const Logger = require('../Logger')
const Database = require('../Database')
const Watcher = require('../Watcher')
const LibraryFile = require('../objects/files/LibraryFile')
const { filePathToPOSIX, getFileTimestampsWithIno } = require('./fileUtils')

/**
 * Execute a single PendingImport: attach the ebook to its target audiobook.
 * The only supported action is 'attachEbook'.
 *
 * @returns {Promise<{status:'imported'|'failed', error:string|null}>}
 */
async function executePendingImport(pendingImport) {
  if (pendingImport.proposedAction !== 'attachEbook') {
    return { status: 'failed', error: `Only "attachEbook" imports are supported (got "${pendingImport.proposedAction}")` }
  }
  if (!pendingImport.attachToLibraryItemId) {
    return { status: 'failed', error: 'No audiobook selected. Pick a target audiobook before approving.' }
  }

  const library = await Database.libraryModel.findByPk(pendingImport.libraryId, { include: Database.libraryFolderModel })
  if (!library) return { status: 'failed', error: 'Library no longer exists' }

  const target = await Database.libraryItemModel.findByPk(pendingImport.attachToLibraryItemId, { include: Database.bookModel })
  if (!target || !target.media) return { status: 'failed', error: 'Target audiobook no longer exists' }
  if (target.isFile) return { status: 'failed', error: 'Cannot attach ebook to a single-file audiobook (target is a file, not a folder)' }

  // The source may be a single ebook file or a folder containing one. Resolve to the actual ebook path.
  let ebookSource = pendingImport.originalMatch?.ebookPath || pendingImport.sourcePath
  if (!(await fsExtra.pathExists(ebookSource))) {
    return { status: 'failed', error: 'Source no longer exists in the import folder' }
  }

  const filename = Path.basename(ebookSource)
  const destAbs = filePathToPOSIX(Path.join(target.path, filename))
  if (await fsExtra.pathExists(destAbs)) {
    return { status: 'failed', error: `Destination already exists: ${destAbs}` }
  }

  Watcher.addIgnoreDir(target.path)
  try {
    await fsExtra.move(ebookSource, destAbs, { overwrite: false })
  } catch (err) {
    try { Watcher.removeIgnoreDir(target.path) } catch { /* noop */ }
    return { status: 'failed', error: `Move failed: ${err.message}` }
  }

  // If the source was a folder containing only the ebook (plus sidecars we don't care about),
  // remove the now-empty/junk-only parent so the import folder stays tidy.
  if (pendingImport.sourceKind === 'folder' && pendingImport.sourcePath !== ebookSource) {
    try {
      const remaining = await fsExtra.readdir(pendingImport.sourcePath)
      if (!remaining.length) {
        await fsExtra.remove(pendingImport.sourcePath)
      }
    } catch (err) {
      Logger.debug(`[importExecutor] Could not cleanup source folder: ${err.message}`)
    }
  }

  try {
    const folder = library.libraryFolders.find((f) => f.id === target.libraryFolderId)
    const folderPath = folder?.path || ''
    const stat = await getFileTimestampsWithIno(destAbs)
    const ext = Path.extname(filename).slice(1).toLowerCase()
    const relPath = destAbs.startsWith(folderPath) ? destAbs.replace(folderPath, '') : '/' + filename

    target.media.ebookFile = {
      ino: stat?.ino || null,
      ebookFormat: ext,
      addedAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {
        filename,
        ext: '.' + ext,
        path: destAbs,
        relPath,
        size: stat?.size || 0,
        mtimeMs: stat?.mtimeMs || 0,
        ctimeMs: stat?.ctimeMs || 0,
        birthtimeMs: stat?.birthtimeMs || 0
      }
    }
    target.media.changed('ebookFile', true)

    const newLF = new LibraryFile()
    await newLF.setDataFromPath(destAbs, filename)
    target.libraryFiles = [...target.libraryFiles, { ...newLF.toJSON(), isSupplementary: false }]
    target.changed('libraryFiles', true)

    await target.media.save()
    await target.save()
  } catch (err) {
    try { Watcher.removeIgnoreDir(target.path) } catch { /* noop */ }
    return { status: 'failed', error: `DB update failed: ${err.message}` }
  }

  try { Watcher.removeIgnoreDir(target.path) } catch { /* noop */ }
  return { status: 'imported', error: null }
}

module.exports = {
  executePendingImport
}
