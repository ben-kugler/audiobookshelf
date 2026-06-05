const Path = require('path')
const fsExtra = require('../libs/fsExtra')
const Logger = require('../Logger')
const globals = require('./globals')
const { filePathToPOSIX, getFileTimestampsWithIno, readTextFile } = require('./fileUtils')
const { parseOpfMetadataXML } = require('./parsers/parseOpfMetadata')

const EBOOK_EXTS = new Set(globals.SupportedEbookTypes.map((e) => e.toLowerCase()))

function extOf(p) {
  const ext = Path.extname(p)
  return ext ? ext.slice(1).toLowerCase() : ''
}

/**
 * Heuristic: derive title and author from a filename or folder name. Best-effort.
 *
 * @param {string} basename
 * @returns {{ title: string|null, author: string|null }}
 */
function inferFromBasename(basename) {
  let name = basename.replace(/\.[A-Za-z0-9]{1,5}$/, '')
  name = name.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!name) return { title: null, author: null }
  const m = name.match(/^(.+?)\s*-\s*(.+)$/)
  if (m) return { title: m[1].trim(), author: m[2].trim() }
  return { title: name, author: null }
}

/**
 * Parse a sibling .opf file if one was passed in.
 * Audiobookshelf doesn't open .epub archives natively, so for .epub sources we
 * fall back to filename-only metadata.
 *
 * @param {string} absPath
 * @returns {Promise<{title:string|null, author:string|null}|null>}
 */
async function readOpfMetadata(absPath) {
  if (extOf(absPath) !== 'opf') return null
  const xml = await readTextFile(absPath).catch(() => null)
  if (!xml) return null
  try {
    const meta = await parseOpfMetadataXML(xml)
    if (!meta) return null
    return {
      title: meta.title || null,
      author: (Array.isArray(meta.authors) && meta.authors[0]) || null
    }
  } catch (err) {
    Logger.warn(`[importMatcher] readOpfMetadata failed for "${absPath}": ${err.message}`)
    return null
  }
}

/**
 * Identify a candidate import source and produce a PendingImport-shaped proposal.
 * Only ebook files are accepted; everything else becomes proposedAction='error'.
 *
 * The matcher does NOT search providers and does NOT auto-pick a target. The
 * admin picks an existing audiobook from a UI picker.
 *
 * @param {import('../models/Library')} library
 * @param {string} sourceAbsPath
 * @returns {Promise<object>}
 */
async function matchSourcePath(library, sourceAbsPath) {
  const posixPath = filePathToPOSIX(sourceAbsPath)
  let stat
  try {
    stat = await fsExtra.stat(posixPath)
  } catch (err) {
    return {
      sourcePath: posixPath,
      sourceIno: null,
      sourceKind: 'file',
      detectedType: 'unknown',
      proposedAction: 'error',
      attachToLibraryItemId: null,
      proposedDestRelPath: null,
      originalMatch: { error: `stat failed: ${err.message}` },
      editedMetadata: {},
      error: `Could not read source: ${err.message}`
    }
  }
  const ino = (await getFileTimestampsWithIno(posixPath))?.ino || null
  const isFolder = stat.isDirectory()
  const sourceKind = isFolder ? 'folder' : 'file'

  // Find the primary ebook file
  let ebookPath = null
  if (isFolder) {
    const entries = await fsExtra.readdir(posixPath).catch(() => [])
    const ebook = entries.find((n) => EBOOK_EXTS.has(extOf(n)))
    if (ebook) ebookPath = filePathToPOSIX(Path.join(posixPath, ebook))
  } else if (EBOOK_EXTS.has(extOf(posixPath))) {
    ebookPath = posixPath
  }

  if (!ebookPath) {
    return {
      sourcePath: posixPath,
      sourceIno: ino,
      sourceKind,
      detectedType: 'unknown',
      proposedAction: 'error',
      attachToLibraryItemId: null,
      proposedDestRelPath: null,
      originalMatch: { source: 'filename', inferredFromSource: inferFromBasename(Path.basename(posixPath)) },
      editedMetadata: {},
      error: 'No ebook file detected in this source. Only ebooks can be imported.'
    }
  }

  // Best-effort inference
  let inferred = inferFromBasename(Path.basename(ebookPath))
  if (isFolder) {
    const opfs = (await fsExtra.readdir(posixPath).catch(() => [])).filter((n) => extOf(n) === 'opf')
    if (opfs.length) {
      const opfSeed = await readOpfMetadata(filePathToPOSIX(Path.join(posixPath, opfs[0])))
      if (opfSeed) {
        if (opfSeed.title) inferred.title = opfSeed.title
        if (opfSeed.author) inferred.author = opfSeed.author
      }
    }
  }

  return {
    sourcePath: posixPath,
    sourceIno: ino,
    sourceKind,
    detectedType: 'ebook',
    proposedAction: 'attachEbook',
    attachToLibraryItemId: null,
    proposedDestRelPath: null,
    originalMatch: {
      source: 'filename',
      inferredFromSource: inferred,
      ebookPath
    },
    editedMetadata: {}
  }
}

module.exports = {
  matchSourcePath,
  inferFromBasename
}
