const Logger = require('../Logger')
const Database = require('../Database')
const SocketAuthority = require('../SocketAuthority')
const { executePendingImport } = require('../utils/importExecutor')

function gateAdmin(req, res) {
  if (!req.user?.isAdminOrUp) {
    res.sendStatus(403)
    return false
  }
  return true
}

async function loadPendingImport(req, res) {
  const p = await Database.pendingImportModel.findByPk(req.params.id)
  if (!p) {
    res.status(404).send('Pending import not found')
    return null
  }
  return p
}

class ImportController {
  /**
   * GET /api/imports?libraryId=&status=
   */
  async list(req, res) {
    if (!gateAdmin(req, res)) return
    const where = {}
    if (req.query.libraryId) where.libraryId = req.query.libraryId
    if (req.query.status) {
      const statuses = req.query.status.split(',').map((s) => s.trim()).filter(Boolean)
      if (statuses.length) where.status = statuses
    }
    const rows = await Database.pendingImportModel.findAll({ where, order: [['createdAt', 'ASC']] })
    return res.json({ rows: rows.map((r) => r.toJSON()) })
  }

  /**
   * GET /api/imports/candidates?libraryId=&q=
   * Returns audiobook items in the library (cover URL + minimal metadata) for the picker.
   */
  async candidates(req, res) {
    if (!gateAdmin(req, res)) return
    const libraryId = req.query.libraryId
    if (!libraryId) return res.status(400).send('libraryId is required')

    const items = await Database.libraryItemModel.findAll({
      where: { libraryId, mediaType: 'book', isFile: false },
      include: [
        {
          model: Database.bookModel,
          attributes: ['id', 'title', 'audioFiles', 'coverPath'],
          include: [
            { model: Database.authorModel, attributes: ['name'], through: { attributes: [] } },
            { model: Database.seriesModel, attributes: ['name'], through: { attributes: ['sequence'] } }
          ]
        }
      ]
    })

    const q = (req.query.q || '').toLowerCase().trim()
    const out = []
    for (const it of items) {
      const book = it.book || it.media
      if (!book) continue
      // Only audiobooks (must have audio files; ebook may or may not exist)
      if (!Array.isArray(book.audioFiles) || !book.audioFiles.length) continue
      const title = book.title || ''
      const authors = (book.authors || []).map((a) => a.name).filter(Boolean)
      const series = (book.series || []).map((s) => ({ name: s.name, sequence: s.bookSeries?.sequence || null }))
      if (q && !title.toLowerCase().includes(q) && !authors.join(' ').toLowerCase().includes(q)) continue
      out.push({
        id: it.id,
        title,
        authors,
        series,
        hasEbook: !!book.ebookFile
      })
    }

    out.sort((a, b) => a.title.localeCompare(b.title))
    return res.json({ candidates: out })
  }

  /**
   * GET /api/imports/:id
   */
  async findOne(req, res) {
    if (!gateAdmin(req, res)) return
    const p = await loadPendingImport(req, res)
    if (!p) return
    return res.json(p.toJSON())
  }

  /**
   * PATCH /api/imports/:id
   * Body: { attachToLibraryItemId: string | null }
   * Only the attach target is editable in this simplified flow.
   */
  async patch(req, res) {
    if (!gateAdmin(req, res)) return
    const p = await loadPendingImport(req, res)
    if (!p) return
    if (p.status === 'importing' || p.status === 'imported') {
      return res.status(409).send(`Cannot edit a pending import in status "${p.status}"`)
    }
    if (req.body.attachToLibraryItemId === undefined) {
      return res.status(400).send('attachToLibraryItemId is required')
    }
    const v = req.body.attachToLibraryItemId
    if (v !== null && typeof v !== 'string') {
      return res.status(400).send('attachToLibraryItemId must be a string or null')
    }
    if (v && !(await Database.libraryItemModel.checkExistsById(v))) {
      return res.status(400).send('attachToLibraryItemId does not reference an existing library item')
    }
    p.attachToLibraryItemId = v
    // Clear the error if the user has now picked a target
    if (v && p.status === 'failed' && p.proposedAction === 'attachEbook') {
      p.status = 'pending'
      p.error = null
    }
    await p.save()
    SocketAuthority.emitter('pending_import_updated', p.toJSON())
    return res.json(p.toJSON())
  }

  /**
   * POST /api/imports/:id/approve
   */
  async approve(req, res) {
    if (!gateAdmin(req, res)) return
    const p = await loadPendingImport(req, res)
    if (!p) return
    if (!Database.pendingImportModel.isTransitionAllowed(p.status, 'importing')) {
      return res.status(409).send(`Cannot approve from status "${p.status}"`)
    }
    if (p.proposedAction !== 'attachEbook' || !p.attachToLibraryItemId) {
      return res.status(400).send('Pick a target audiobook before approving')
    }

    p.status = 'importing'
    await p.save()
    SocketAuthority.emitter('pending_import_updated', p.toJSON())

    try {
      const result = await executePendingImport(p)
      p.status = result.status
      p.error = result.error
      await p.save()
    } catch (err) {
      Logger.error(`[ImportController] executePendingImport threw for ${p.id}:`, err)
      p.status = 'failed'
      p.error = err.message
      await p.save()
    }
    SocketAuthority.emitter('pending_import_updated', p.toJSON())
    return res.json(p.toJSON())
  }

  /**
   * POST /api/imports/:id/reject
   */
  async reject(req, res) {
    if (!gateAdmin(req, res)) return
    const p = await loadPendingImport(req, res)
    if (!p) return
    if (!Database.pendingImportModel.isTransitionAllowed(p.status, 'rejected')) {
      return res.status(409).send(`Cannot reject from status "${p.status}"`)
    }
    p.status = 'rejected'
    await p.save()
    SocketAuthority.emitter('pending_import_updated', p.toJSON())
    return res.json(p.toJSON())
  }

  /**
   * DELETE /api/imports/:id
   */
  async delete(req, res) {
    if (!gateAdmin(req, res)) return
    const p = await loadPendingImport(req, res)
    if (!p) return
    await p.destroy()
    SocketAuthority.emitter('pending_import_removed', { id: req.params.id })
    return res.sendStatus(204)
  }
}

module.exports = new ImportController()
