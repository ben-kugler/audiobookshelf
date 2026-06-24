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
 * Generate a Storyteller read-along EPUB for an imported item and register it as a
 * read-along supplementary file (isSupplementary:true, isReadAlong:true).
 * The primary ebookFile is intentionally left untouched.
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

  // Register the synced EPUB as a read-along supplementary file.
  // The primary ebook (media.ebookFile) is intentionally left untouched.
  const newLF = new LibraryFile()
  await newLF.setDataFromPath(destPath, relPath)
  const readAlongEntry = { ...newLF.toJSON(), isSupplementary: true, isReadAlong: true }

  // Replace any stale entry for the same path, then append.
  libraryItem.libraryFiles = [...libraryItem.libraryFiles.filter((lf) => lf.metadata?.path !== readAlongEntry.metadata.path), readAlongEntry]
  libraryItem.changed('libraryFiles', true)
  await libraryItem.save()

  SocketAuthority.libraryItemEmitter('item_updated', libraryItem)
  Logger.info(`[Storyteller] Read-along generated for "${libraryItem.media.title}" → ${destPath}`)
}

module.exports = { generateReadAlong, collectPaths }
