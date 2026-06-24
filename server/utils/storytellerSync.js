const fs = require('fs')
const Path = require('path')
const Logger = require('../Logger')
const StorytellerClient = require('./storytellerClient')
const SocketAuthority = require('../SocketAuthority')
const LibraryFile = require('../objects/files/LibraryFile')

/**
 * Gather the absolute paths Storyteller needs: the ebook + all audio files.
 *
 * @param {Object} libraryItem - expanded library item with media association
 * @returns {{ ebookPath: string, audioPaths: string[] }}
 */
function collectPaths(libraryItem) {
  const media = libraryItem.media
  const ebookPath = media.ebookFile?.metadata?.path
  if (!ebookPath) throw new Error('No ebook file on item')
  const audioPaths = (media.audioFiles || []).map((af) => af.metadata.path).filter(Boolean)
  if (!audioPaths.length) throw new Error('No audio files on item')
  return { ebookPath, audioPaths }
}

/**
 * Generate a Storyteller read-along EPUB for an imported item and store it as the ebookFile.
 * Non-destructive: throws on any failure, leaving the original ebookFile untouched.
 * The download goes to a .tmp path first; only on success is it renamed to the final path.
 *
 * @param {Object} libraryItem - expanded library item (from Database.libraryItemModel.getExpandedById)
 * @param {Object} library    - library model instance (with library.settings.storyteller)
 * @param {import('../objects/Task')} task - TaskManager task for progress tracking (may be null)
 */
async function generateReadAlong(libraryItem, library, task) {
  const cfg = library.settings?.storyteller || {}
  if (!cfg.enabled || !cfg.url) throw new Error('Storyteller not configured')

  const { ebookPath, audioPaths } = collectPaths(libraryItem)
  const client = new StorytellerClient({ url: cfg.url, username: cfg.username, password: cfg.password })

  await client.authenticate()

  // ponytail: v1 — create book by uploading paths; Storyteller must have access to these paths
  // (shared-volume / importMode:"reference"). Remote HTTP upload not yet supported.
  const bookUuid = await client.createBookByPaths([ebookPath, ...audioPaths])
  await client.startProcessing(bookUuid)

  // ponytail: v1 — poll interval/timeout uses StorytellerClient defaults; no user-configurable timeout yet
  await client.waitForAligned(bookUuid, {})

  // Download synced EPUB next to the original ebook.
  // Non-destructive: write to .tmp first; rename only on success.
  const itemDir = Path.dirname(ebookPath)
  const baseName = Path.basename(ebookPath, Path.extname(ebookPath))
  const destPath = Path.join(itemDir, `${baseName}.readalong.epub`)
  const tmpPath = `${destPath}.tmp`

  await client.downloadSynced(bookUuid, tmpPath)
  await fs.promises.rename(tmpPath, destPath)

  // FIX #2: compute relPath relative to the library folder (same convention as importExecutor.js:64-68)
  const folder = library.libraryFolders?.find((f) => f.id === libraryItem.libraryFolderId)
  const folderPath = folder?.path || ''
  const relPath = destPath.startsWith(folderPath) ? destPath.replace(folderPath, '') : '/' + Path.basename(destPath)

  const stat = await fs.promises.stat(destPath)
  const filename = Path.basename(destPath)
  const ext = '.epub'

  // Mirror the ebookFile shape from importExecutor.js:70-85
  libraryItem.media.ebookFile = {
    ino: stat.ino ? String(stat.ino) : null,
    ebookFormat: 'epub',
    addedAt: Date.now(),
    updatedAt: Date.now(),
    metadata: {
      filename,
      ext,
      path: destPath,
      relPath,
      size: stat.size || 0,
      mtimeMs: stat.mtimeMs || 0,
      ctimeMs: stat.ctimeMs || 0,
      birthtimeMs: stat.birthtimeMs || 0
    }
  }
  libraryItem.media.changed('ebookFile', true)

  // FIX #1: register the new file in libraryFiles (mirror importExecutor.js:88-91).
  // Non-destructive: we leave the original ebook's libraryFiles entry in place because
  // importExecutor does not remove a prior entry — it only appends. The user's original
  // ebook remains on disk and remains listed in libraryFiles.
  const newLF = new LibraryFile()
  await newLF.setDataFromPath(destPath, relPath)
  libraryItem.libraryFiles = [...libraryItem.libraryFiles, { ...newLF.toJSON(), isSupplementary: false }]
  libraryItem.changed('libraryFiles', true)

  await libraryItem.media.save()
  await libraryItem.save()

  SocketAuthority.libraryItemEmitter('item_updated', libraryItem)
  Logger.info(`[Storyteller] Read-along generated for "${libraryItem.media.title}" → ${destPath}`)
}

module.exports = { generateReadAlong, collectPaths }
