const Logger = require('../Logger')
const Database = require('../Database')
const TaskManager = require('../managers/TaskManager')
const { validateReorganizeSettings } = require('../utils/reorganizeTemplate')
const { renderTemplate, buildContext, buildReorganizePlan } = require('../utils/reorganizePlanner')
const { executeReorganization, isLibraryReorganizing } = require('../utils/reorganizeExecutor')
const { scanEmptyFolders, deleteEmptyFolders, isLibraryCleaningUp } = require('../utils/emptyFolderCleanup')

const SAMPLE_CONTEXT = {
  author: 'Brandon Sanderson',
  series: 'Mistborn',
  seriesSequence: '1',
  title: 'The Final Empire',
  narrator: 'Michael Kramer',
  publishedYear: '2006',
  subtitle: null,
  language: 'English',
  isbn: '9780765311788',
  asin: 'B002GYI9C4'
}

class ReorganizeController {
  /**
   * Admin gate + book-library gate. Used at the top of every handler.
   *
   * @returns {boolean} true if the request should proceed
   */
  _gate(req, res) {
    if (!req.user?.isAdminOrUp) {
      Logger.warn(`[ReorganizeController] Non-admin user "${req.user?.username}" attempted to use reorganize`)
      res.sendStatus(403)
      return false
    }
    if (req.library.mediaType !== 'book') {
      res.status(400).send('Reorganize is only supported on book libraries')
      return false
    }
    return true
  }

  /**
   * POST /api/libraries/:id/reorganize/preview
   * Body: { folderTemplate, fileTemplate, libraryItemId? }
   * Validates the supplied templates and returns the rendered preview
   * using either a specified library item or a canned sample context.
   */
  async preview(req, res) {
    if (!this._gate(req, res)) return

    const { folderTemplate, fileTemplate, libraryItemId } = req.body || {}
    const validation = validateReorganizeSettings({ folderTemplate, fileTemplate })
    if (!validation.valid) {
      return res.status(400).send(validation.error)
    }

    let context = SAMPLE_CONTEXT
    let blocked = null
    let sourceItemId = null

    if (libraryItemId) {
      const item = await Database.libraryItemModel.findOneExpanded({ id: libraryItemId, libraryId: req.library.id })
      if (!item || item.mediaType !== 'book' || !item.media) {
        return res.status(404).send('Library item not found in this library')
      }
      context = buildContext(item.media)
      sourceItemId = item.id
      if (!context.title) blocked = 'missingTitle'
    }

    const folderPath = renderTemplate(folderTemplate, context)
    const filename = renderTemplate(fileTemplate, context)

    if (!folderPath) blocked = blocked || 'emptyFolderTemplate'
    if (!filename) blocked = blocked || 'emptyFileTemplate'

    return res.json({
      folderPath,
      filename,
      fullPath: filename ? `${folderPath}/${filename}` : folderPath,
      context,
      sourceItemId,
      blocked
    })
  }

  /**
   * POST /api/libraries/:id/reorganize/scan
   * Builds the dry-run plan as a background task. The plan is attached to
   * task.data.plan when the task completes; client reads it via the
   * existing task_finished socket event.
   */
  async scan(req, res) {
    if (!this._gate(req, res)) return

    if (!req.library.settings?.reorganize) {
      return res.status(400).send('Reorganize templates are not configured for this library')
    }
    if (isLibraryReorganizing(req.library.id) || isLibraryCleaningUp(req.library.id)) {
      return res.status(409).send('A reorganization or cleanup is already in progress for this library')
    }

    const titleString = {
      text: `Scanning "${req.library.name}" for reorganization`,
      key: 'MessageTaskReorganizeScanning',
      subs: [req.library.name]
    }
    const task = TaskManager.createAndAddTask('reorganize-scan', titleString, null, false, {
      libraryId: req.library.id,
      libraryName: req.library.name
    })

    res.status(202).json({ taskId: task.id })

    try {
      const plan = await buildReorganizePlan(req.library)
      task.data = { ...task.data, plan }
      const finishedString = {
        text: `Scan complete: ${plan.summary.willMove} to move, ${plan.summary.alreadyCorrect} already correct, ${plan.summary.blocked} blocked, ${plan.summary.conflicts} conflicts`,
        key: 'MessageTaskReorganizeScanComplete',
        subs: [plan.summary.willMove, plan.summary.alreadyCorrect, plan.summary.blocked, plan.summary.conflicts]
      }
      task.setFinished(finishedString)
      TaskManager.taskFinished(task)
    } catch (err) {
      Logger.error(`[ReorganizeController] Scan failed for library "${req.library.name}":`, err)
      task.setFailed({ text: err.message || 'Scan failed', key: 'MessageTaskReorganizeScanFailed' })
      TaskManager.taskFinished(task)
    }
  }

  /**
   * POST /api/libraries/:id/reorganize/apply
   * Body: { moves: [{ itemId, expectedToRelPath }, ...] }
   * Executes the selected moves as a background task. Per-move outcomes are
   * attached to task.data.result when the task completes.
   */
  async apply(req, res) {
    if (!this._gate(req, res)) return

    if (!req.library.settings?.reorganize) {
      return res.status(400).send('Reorganize templates are not configured for this library')
    }

    const moves = req.body?.moves
    if (!Array.isArray(moves) || !moves.length) {
      return res.status(400).send('Request body must include a non-empty "moves" array')
    }
    for (const m of moves) {
      if (!m || typeof m.itemId !== 'string' || typeof m.expectedToRelPath !== 'string') {
        return res.status(400).send('Each move must include "itemId" and "expectedToRelPath" strings')
      }
    }

    if (isLibraryReorganizing(req.library.id) || isLibraryCleaningUp(req.library.id)) {
      return res.status(409).send('A reorganization or cleanup is already in progress for this library')
    }

    const titleString = {
      text: `Reorganizing "${req.library.name}"`,
      key: 'MessageTaskReorganizeApplying',
      subs: [req.library.name]
    }
    const task = TaskManager.createAndAddTask('reorganize-apply', titleString, null, true, {
      libraryId: req.library.id,
      libraryName: req.library.name,
      requestedCount: moves.length
    })

    res.status(202).json({ taskId: task.id })

    try {
      const result = await executeReorganization(req.library, moves, task)
      task.data = { ...task.data, result }
      const finishedString = {
        text: `Reorganization complete: ${result.succeeded.length} succeeded, ${result.failed.length} failed, ${result.stale.length} stale`,
        key: 'MessageTaskReorganizeApplyComplete',
        subs: [result.succeeded.length, result.failed.length, result.stale.length]
      }
      task.setFinished(finishedString)
      TaskManager.taskFinished(task)
    } catch (err) {
      Logger.error(`[ReorganizeController] Apply failed for library "${req.library.name}":`, err)
      task.setFailed({ text: err.message || 'Reorganization failed', key: 'MessageTaskReorganizeApplyFailed' })
      TaskManager.taskFinished(task)
    }
  }

  /**
   * POST /api/libraries/:id/reorganize/cleanup/scan
   * Walks the library tree post-order looking for folders that are empty
   * (or contain only OS junk), respecting LibraryItem paths as protected.
   * Plan attached to task.data.cleanupPlan.
   */
  async cleanupScan(req, res) {
    if (!this._gate(req, res)) return
    if (isLibraryReorganizing(req.library.id) || isLibraryCleaningUp(req.library.id)) {
      return res.status(409).send('A reorganization or cleanup is already in progress for this library')
    }

    const titleString = {
      text: `Scanning "${req.library.name}" for empty folders`,
      key: 'MessageTaskCleanupScanning',
      subs: [req.library.name]
    }
    const task = TaskManager.createAndAddTask('reorganize-cleanup-scan', titleString, null, false, {
      libraryId: req.library.id,
      libraryName: req.library.name
    })

    res.status(202).json({ taskId: task.id })

    try {
      const plan = await scanEmptyFolders(req.library)
      task.data = { ...task.data, cleanupPlan: plan }
      task.setFinished({
        text: `Found ${plan.summary.total} empty folders`,
        key: 'MessageTaskCleanupScanComplete',
        subs: [plan.summary.total]
      })
      TaskManager.taskFinished(task)
    } catch (err) {
      Logger.error(`[ReorganizeController] Cleanup scan failed for "${req.library.name}":`, err)
      task.setFailed({ text: err.message || 'Cleanup scan failed', key: 'MessageTaskCleanupScanFailed' })
      TaskManager.taskFinished(task)
    }
  }

  /**
   * POST /api/libraries/:id/reorganize/cleanup/apply
   * Body: { paths: ["/abs/path/to/folder", ...] }
   * Re-validates each path is still deletable, then removes deepest-first.
   * Results attached to task.data.cleanupResult.
   */
  async cleanupApply(req, res) {
    if (!this._gate(req, res)) return

    const paths = req.body?.paths
    if (!Array.isArray(paths) || !paths.length) {
      return res.status(400).send('Request body must include a non-empty "paths" array')
    }
    for (const p of paths) {
      if (typeof p !== 'string' || !p.length) {
        return res.status(400).send('Each path must be a non-empty string')
      }
    }

    if (isLibraryReorganizing(req.library.id) || isLibraryCleaningUp(req.library.id)) {
      return res.status(409).send('A reorganization or cleanup is already in progress for this library')
    }

    const titleString = {
      text: `Removing empty folders in "${req.library.name}"`,
      key: 'MessageTaskCleanupApplying',
      subs: [req.library.name]
    }
    const task = TaskManager.createAndAddTask('reorganize-cleanup-apply', titleString, null, true, {
      libraryId: req.library.id,
      libraryName: req.library.name,
      requestedCount: paths.length
    })

    res.status(202).json({ taskId: task.id })

    try {
      const result = await deleteEmptyFolders(req.library, paths, task)
      task.data = { ...task.data, cleanupResult: result }
      task.setFinished({
        text: `Cleanup complete: ${result.succeeded.length} removed, ${result.failed.length} failed, ${result.skipped.length} skipped`,
        key: 'MessageTaskCleanupApplyComplete',
        subs: [result.succeeded.length, result.failed.length, result.skipped.length]
      })
      TaskManager.taskFinished(task)
    } catch (err) {
      Logger.error(`[ReorganizeController] Cleanup apply failed for "${req.library.name}":`, err)
      task.setFailed({ text: err.message || 'Cleanup failed', key: 'MessageTaskCleanupApplyFailed' })
      TaskManager.taskFinished(task)
    }
  }
}

module.exports = new ReorganizeController()
