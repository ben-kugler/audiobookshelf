const Path = require('path')
const fsExtra = require('../libs/fsExtra')
const Logger = require('../Logger')
const Database = require('../Database')
const { filePathToPOSIX } = require('./fileUtils')
const { sanitizeFilename } = require('./fileUtils')
const { ALLOWED_PLACEHOLDERS } = require('./reorganizeTemplate')

const OPTIONAL_PLACEHOLDERS = new Set(['series', 'seriesSequence'])

/**
 * Build a flat substitution context from an expanded Book.
 *
 * @param {import('../models/Book')} book
 * @returns {Record<string, string|null>}
 */
function buildContext(book) {
  const firstAuthor = book.authors?.[0]?.name?.trim() || null
  const firstSeries = book.series?.[0]
  const seriesName = firstSeries?.name?.trim() || null
  const seriesSequence = firstSeries?.bookSeries?.sequence ?? null
  const firstNarrator = (Array.isArray(book.narrators) && book.narrators[0]?.trim()) || null

  return {
    author: firstAuthor,
    series: seriesName,
    seriesSequence: seriesSequence ? String(seriesSequence).trim() : null,
    title: book.title?.trim() || null,
    narrator: firstNarrator,
    publishedYear: book.publishedYear ? String(book.publishedYear).trim() : null,
    subtitle: book.subtitle?.trim() || null,
    language: book.language?.trim() || null,
    isbn: book.isbn?.trim() || null,
    asin: book.asin?.trim() || null
  }
}

/**
 * Return the set of placeholder names used in a template.
 *
 * @param {string} template
 * @returns {Set<string>}
 */
function placeholdersIn(template) {
  const set = new Set()
  const re = /\{([^{}]+)\}/g
  let m
  while ((m = re.exec(template)) !== null) {
    set.add(m[1].trim())
  }
  return set
}

/**
 * Substitute placeholders and sanitize each value, then collapse empty path segments.
 *
 * @param {string} template - validated template string
 * @param {Record<string, string|null>} context - pre-trimmed values, not yet sanitized
 * @returns {string} POSIX relative path/filename
 */
function renderTemplate(template, context) {
  const substituted = template.replace(/\{([^{}]+)\}/g, (_match, rawName) => {
    const name = rawName.trim()
    const raw = context[name]
    if (raw === null || raw === undefined || raw === '') return ''
    const safe = sanitizeFilename(String(raw))
    return safe === false ? '' : safe
  })

  // Per-segment cleanup: collapse orphaned connector punctuation/whitespace left by missing optional placeholders.
  // - drop empty whole segments (`Author//Title` -> `Author/Title`)
  // - within a segment: strip leading/trailing connector runs, collapse repeats, strip trailing dots
  const cleanSegment = (seg) => {
    let s = seg.replace(/\s+/g, ' ')
    // Collapse runs of separator punctuation that were left by empty substitutions, e.g. "- - " or " -  - "
    s = s.replace(/(\s*[-_]\s*){2,}/g, ' - ')
    // Strip leading/trailing connector runs
    s = s.replace(/^[\s_\-]+/, '').replace(/[\s_\-]+$/, '')
    // Strip trailing dots (Windows safety) and re-trim
    s = s.replace(/[ .]+$/g, '').trim()
    return s
  }
  const segments = substituted
    .split('/')
    .map(cleanSegment)
    .filter((seg) => seg.length)
  return segments.join('/')
}

/**
 * Compute the file extension (including dot) for a path. Returns '' if none.
 *
 * @param {string} filenameOrPath
 * @returns {string}
 */
function extOf(filenameOrPath) {
  return Path.extname(filenameOrPath) || ''
}

/**
 * Normalize a stored relPath for comparison: POSIX, strip leading slash.
 *
 * @param {string} rel
 * @returns {string}
 */
function normRel(rel) {
  if (!rel) return ''
  let s = filePathToPOSIX(rel)
  while (s.startsWith('/')) s = s.slice(1)
  return s
}

/**
 * Compute the per-libraryFile renames for a folder library item that is moving
 * from oldItemAbsPath to newItemAbsPath. Each file keeps its position within
 * the item folder; only the parent prefix changes.
 *
 * @param {Array<{ino:string, metadata:{path:string,relPath:string,filename:string}}>} libraryFiles
 * @param {string} oldItemAbsPath
 * @param {string} newItemAbsPath
 * @param {string} libraryFolderAbsPath
 * @returns {Array<{ino:string, fromPath:string, toPath:string, fromRelPath:string, toRelPath:string}>}
 */
function planFolderFileMoves(libraryFiles, oldItemAbsPath, newItemAbsPath, libraryFolderAbsPath) {
  const oldBase = filePathToPOSIX(oldItemAbsPath)
  const newBase = filePathToPOSIX(newItemAbsPath)
  const folderBase = filePathToPOSIX(libraryFolderAbsPath)
  return (libraryFiles || []).map((lf) => {
    const fromPath = filePathToPOSIX(lf.metadata.path)
    const withinItem = fromPath.startsWith(oldBase) ? fromPath.slice(oldBase.length) : '/' + lf.metadata.filename
    const toPath = newBase + withinItem
    const toRelPath = toPath.startsWith(folderBase) ? toPath.slice(folderBase.length) : toPath
    return {
      ino: lf.ino,
      fromPath,
      toPath,
      fromRelPath: lf.metadata.relPath,
      toRelPath
    }
  })
}

/**
 * Plan moves for the audio/ebook/cover sub-paths of a folder item.
 * These overlap with libraryFiles but we expose them separately so the
 * executor can rewrite the typed metadata fields on Book.
 *
 * @param {import('../models/Book')} book
 * @param {string} oldItemAbsPath
 * @param {string} newItemAbsPath
 * @param {string} libraryFolderAbsPath
 */
function planFolderMediaRewrites(book, oldItemAbsPath, newItemAbsPath, libraryFolderAbsPath) {
  const oldBase = filePathToPOSIX(oldItemAbsPath)
  const newBase = filePathToPOSIX(newItemAbsPath)
  const folderBase = filePathToPOSIX(libraryFolderAbsPath)

  const rewriteSub = (absPath) => {
    if (!absPath) return null
    const p = filePathToPOSIX(absPath)
    if (!p.startsWith(oldBase)) return null
    const within = p.slice(oldBase.length)
    const toPath = newBase + within
    return {
      fromPath: p,
      toPath,
      toRelPath: toPath.startsWith(folderBase) ? toPath.slice(folderBase.length) : toPath
    }
  }

  const audioFileChanges = (book.audioFiles || []).map((af) => {
    const rw = rewriteSub(af.metadata?.path)
    return rw ? { ino: af.ino, fromPath: rw.fromPath, toPath: rw.toPath, fromRelPath: af.metadata.relPath, toRelPath: rw.toRelPath } : null
  }).filter(Boolean)

  let ebookFileChange = null
  if (book.ebookFile?.metadata?.path) {
    const rw = rewriteSub(book.ebookFile.metadata.path)
    if (rw) {
      ebookFileChange = { ino: book.ebookFile.ino, fromPath: rw.fromPath, toPath: rw.toPath, fromRelPath: book.ebookFile.metadata.relPath, toRelPath: rw.toRelPath }
    }
  }

  let coverChange = null
  if (book.coverPath) {
    const rw = rewriteSub(book.coverPath)
    if (rw) coverChange = { fromPath: rw.fromPath, toPath: rw.toPath }
  }

  return { audioFileChanges, ebookFileChange, coverChange }
}

/**
 * Plan a single item's move (or determine it is already correct / blocked).
 * Pure function - does not check destination conflicts (caller's responsibility).
 *
 * @param {import('../models/LibraryItem')} item - expanded; item.media is the Book
 * @param {import('../models/LibraryFolder')} folder - the library folder containing the item
 * @param {string} folderTemplate
 * @param {string} fileTemplate
 * @returns {{kind:'alreadyCorrect', relPath:string, title:string|null}
 *          |{kind:'blocked', reason:string, title:string|null, placeholder?:string}
 *          |{kind:'move', move:object}}
 */
function planMoveForItem(item, folder, folderTemplate, fileTemplate) {
  const folderPlaceholders = placeholdersIn(folderTemplate)
  const filePlaceholders = placeholdersIn(fileTemplate)
  const usedPlaceholders = new Set([...folderPlaceholders, ...filePlaceholders])

  const context = buildContext(item.media)

  for (const ph of usedPlaceholders) {
    if (!ALLOWED_PLACEHOLDERS.includes(ph)) continue
    if (OPTIONAL_PLACEHOLDERS.has(ph)) continue
    if (!context[ph]) {
      return { kind: 'blocked', reason: 'missingPlaceholder', title: context.title || null, placeholder: ph }
    }
  }
  if (!context.title && filePlaceholders.has('title')) {
    return { kind: 'blocked', reason: 'missingTitle', title: null }
  }

  const renderedFolder = renderTemplate(folderTemplate, context)
  if (!renderedFolder) {
    return { kind: 'blocked', reason: 'emptyFolderTemplate', title: context.title || null }
  }
  const renderedFile = renderTemplate(fileTemplate, context)
  if (!renderedFile && item.isFile) {
    return { kind: 'blocked', reason: 'emptyFileTemplate', title: context.title || null }
  }

  const folderAbs = filePathToPOSIX(folder.path)

  // Single-file items get promoted to a folder containing the (possibly renamed)
  // audio file. After this runs they are folder-based items (isFile=false), so
  // the rest of the app — including ebook attach — treats them like any other
  // folder item. When the file already lives inside the folder the template
  // would build, it's an in-place promotion: no on-disk move, just flip isFile
  // and rewrite paths in the DB (with an in-folder rename if the file template
  // produces a different filename).
  const promoteToFolder = !!item.isFile
  const ext = item.isFile ? extOf(item.path) : ''
  const expectedRelPath = renderedFolder
  const promotedAudioRel = promoteToFolder ? `${renderedFolder}/${renderedFile}${ext}` : null

  const currentRel = normRel(item.relPath)
  const expectedRel = normRel(expectedRelPath)

  if (!promoteToFolder && currentRel === expectedRel) {
    return { kind: 'alreadyCorrect', relPath: currentRel, title: context.title || null }
  }

  const oldItemAbs = filePathToPOSIX(item.path)
  const newItemAbs = `${folderAbs}/${expectedRel}`

  let fileChanges = []
  let mediaRewrites = { audioFileChanges: [], ebookFileChange: null, coverChange: null }
  let inPlacePromotion = false
  if (promoteToFolder) {
    const audioToAbs = `${folderAbs}/${promotedAudioRel}`
    const audioToRel = '/' + promotedAudioRel
    const currentParentAbs = filePathToPOSIX(Path.dirname(oldItemAbs))
    inPlacePromotion = currentParentAbs === newItemAbs

    if (inPlacePromotion && oldItemAbs === audioToAbs) {
      // Nothing to do on disk — the file already lives where the templates want
      // and has the templated filename. Pure DB reclassification.
      fileChanges = []
    } else {
      fileChanges = [{
        ino: item.libraryFiles?.[0]?.ino,
        fromPath: oldItemAbs,
        toPath: audioToAbs,
        fromRelPath: item.libraryFiles?.[0]?.metadata?.relPath,
        toRelPath: audioToRel
      }]
    }
    const af = item.media.audioFiles?.[0]
    if (af) {
      mediaRewrites.audioFileChanges = [{
        ino: af.ino,
        fromPath: oldItemAbs,
        toPath: audioToAbs,
        fromRelPath: af.metadata?.relPath,
        toRelPath: audioToRel
      }]
    }
  } else {
    fileChanges = planFolderFileMoves(item.libraryFiles, oldItemAbs, newItemAbs, folderAbs)
    mediaRewrites = planFolderMediaRewrites(item.media, oldItemAbs, newItemAbs, folderAbs)
  }

  return {
    kind: 'move',
    move: {
      itemId: item.id,
      title: context.title,
      libraryFolderId: folder.id,
      fromAbsPath: oldItemAbs,
      toAbsPath: newItemAbs,
      fromRelPath: '/' + currentRel,
      toRelPath: '/' + expectedRel,
      isFile: item.isFile,
      promoteToFolder,
      inPlacePromotion,
      fileChanges,
      audioFileChanges: mediaRewrites.audioFileChanges,
      ebookFileChange: mediaRewrites.ebookFileChange,
      coverChange: mediaRewrites.coverChange
    }
  }
}

/**
 * Build a dry-run reorganization plan for a book library.
 *
 * @param {import('../models/Library')} library - must include libraryFolders and have settings.reorganize set
 * @returns {Promise<object>} plan
 */
async function buildReorganizePlan(library) {
  if (library.mediaType !== 'book') {
    throw new Error('Reorganize is only supported on book libraries')
  }
  const templates = library.settings?.reorganize
  if (!templates) {
    throw new Error('Reorganize templates are not configured for this library')
  }
  const folderTemplate = templates.folderTemplate
  const fileTemplate = templates.fileTemplate

  const folderById = new Map()
  for (const f of library.libraryFolders || []) {
    folderById.set(f.id, f)
  }
  if (!folderById.size) {
    throw new Error('Library has no folders to organize within')
  }

  const items = await Database.libraryItemModel.findAllExpandedWhere({ libraryId: library.id })

  const moves = []
  const alreadyCorrect = []
  const blocked = []
  const conflicts = []

  for (const item of items) {
    if (item.mediaType !== 'book' || !item.media) {
      continue
    }
    const folder = folderById.get(item.libraryFolderId)
    if (!folder) {
      blocked.push({ itemId: item.id, title: item.media.title || '(untitled)', reason: 'unknownLibraryFolder' })
      continue
    }

    const result = planMoveForItem(item, folder, folderTemplate, fileTemplate)
    if (result.kind === 'blocked') {
      const entry = { itemId: item.id, title: result.title || '(untitled)', reason: result.reason }
      if (result.placeholder) entry.placeholder = result.placeholder
      blocked.push(entry)
    } else if (result.kind === 'alreadyCorrect') {
      alreadyCorrect.push({ itemId: item.id, title: result.title, relPath: result.relPath })
    } else {
      moves.push(result.move)
    }
  }

  // Conflict detection: duplicate destinations
  const byDest = new Map()
  for (const mv of moves) {
    const key = mv.toAbsPath
    if (!byDest.has(key)) byDest.set(key, [])
    byDest.get(key).push(mv)
  }

  const dupKeys = new Set()
  for (const [key, group] of byDest.entries()) {
    if (group.length > 1) {
      dupKeys.add(key)
      for (const mv of group) {
        conflicts.push({
          itemId: mv.itemId,
          title: mv.title,
          toRelPath: mv.toRelPath,
          reason: 'duplicateDestination',
          otherItemIds: group.filter((g) => g.itemId !== mv.itemId).map((g) => g.itemId)
        })
      }
    }
  }

  // Conflict detection: destination already exists on disk.
  // In-place promotions are expected to land in an existing folder (the file's
  // current parent), so we skip the folder check for them and instead check
  // that the audio file's final path doesn't collide with a different file.
  const remaining = moves.filter((mv) => !dupKeys.has(mv.toAbsPath))
  await Promise.all(remaining.map(async (mv) => {
    try {
      if (mv.inPlacePromotion) {
        const audioTo = mv.audioFileChanges?.[0]?.toPath
        if (audioTo && filePathToPOSIX(audioTo) !== mv.fromAbsPath) {
          const exists = await fsExtra.pathExists(audioTo)
          if (exists) {
            conflicts.push({ itemId: mv.itemId, title: mv.title, toRelPath: mv.toRelPath, reason: 'destinationExists' })
          }
        }
        return
      }
      const exists = await fsExtra.pathExists(mv.toAbsPath)
      if (exists && filePathToPOSIX(mv.toAbsPath) !== mv.fromAbsPath) {
        conflicts.push({
          itemId: mv.itemId,
          title: mv.title,
          toRelPath: mv.toRelPath,
          reason: 'destinationExists'
        })
      }
    } catch (err) {
      Logger.warn(`[reorganizePlanner] pathExists failed for move ${mv.itemId}:`, err.message)
    }
  }))

  const conflictIds = new Set(conflicts.map((c) => c.itemId))
  const cleanMoves = moves.filter((mv) => !conflictIds.has(mv.itemId))

  return {
    libraryId: library.id,
    templates: { folderTemplate, fileTemplate },
    summary: {
      total: items.length,
      willMove: cleanMoves.length,
      alreadyCorrect: alreadyCorrect.length,
      blocked: blocked.length,
      conflicts: conflicts.length
    },
    moves: cleanMoves,
    alreadyCorrect,
    blocked,
    conflicts
  }
}

module.exports = {
  buildContext,
  renderTemplate,
  buildReorganizePlan,
  planMoveForItem
}
