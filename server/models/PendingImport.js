const { DataTypes, Model } = require('sequelize')

/**
 * @typedef {'file'|'folder'} SourceKind
 * @typedef {'audio'|'ebook'|'unknown'} DetectedType
 * @typedef {'create'|'attachEbook'|'error'} ProposedAction
 * @typedef {'pending'|'importing'|'imported'|'rejected'|'failed'} PendingImportStatus
 */

const VALID_STATUSES = new Set(['pending', 'importing', 'imported', 'rejected', 'failed'])
const VALID_ACTIONS = new Set(['create', 'attachEbook', 'error'])
const VALID_KINDS = new Set(['file', 'folder'])
const VALID_TYPES = new Set(['audio', 'ebook', 'unknown'])

const VALID_TRANSITIONS = {
  pending: new Set(['importing', 'rejected']),
  importing: new Set(['imported', 'failed']),
  imported: new Set([]),
  rejected: new Set(['pending']),
  failed: new Set(['pending', 'importing'])
}

class PendingImport extends Model {
  constructor(values, options) {
    super(values, options)

    /** @type {string} */
    this.id
    /** @type {string} */
    this.libraryId
    /** @type {string|null} */
    this.attachToLibraryItemId
    /** @type {string} */
    this.sourcePath
    /** @type {string|null} */
    this.sourceIno
    /** @type {SourceKind} */
    this.sourceKind
    /** @type {DetectedType} */
    this.detectedType
    /** @type {ProposedAction} */
    this.proposedAction
    /** @type {string|null} */
    this.proposedDestRelPath
    /** @type {Object} */
    this.originalMatch
    /** @type {Object} */
    this.editedMetadata
    /** @type {PendingImportStatus} */
    this.status
    /** @type {string|null} */
    this.error
    /** @type {Date} */
    this.createdAt
    /** @type {Date} */
    this.updatedAt
  }

  /**
   * @returns {Set<string>} - valid statuses (e.g. for controller validation)
   */
  static get validStatuses() {
    return VALID_STATUSES
  }

  /**
   * @returns {Set<string>} - valid proposed actions
   */
  static get validActions() {
    return VALID_ACTIONS
  }

  /**
   * Check whether a status transition is allowed by the state machine.
   *
   * @param {PendingImportStatus} from
   * @param {PendingImportStatus} to
   * @returns {boolean}
   */
  static isTransitionAllowed(from, to) {
    if (from === to) return true
    return VALID_TRANSITIONS[from]?.has(to) === true
  }

  /**
   * Find an existing pending row for the same (libraryId, sourceIno) or
   * (libraryId, sourcePath). Used by the watcher pipeline to dedupe.
   *
   * @param {string} libraryId
   * @param {{ ino?: string, path: string }} source
   * @returns {Promise<PendingImport|null>}
   */
  static async findExistingForSource(libraryId, source) {
    if (!libraryId || !source?.path) return null
    if (source.ino) {
      const byIno = await this.findOne({ where: { libraryId, sourceIno: source.ino } })
      if (byIno) return byIno
    }
    return this.findOne({ where: { libraryId, sourcePath: source.path } })
  }

  /**
   * Initialize model
   * @param {import('../Database').sequelize} sequelize
   */
  static init(sequelize) {
    super.init(
      {
        id: {
          type: DataTypes.UUID,
          defaultValue: DataTypes.UUIDV4,
          primaryKey: true
        },
        sourcePath: {
          type: DataTypes.STRING,
          allowNull: false
        },
        sourceIno: DataTypes.STRING,
        sourceKind: {
          type: DataTypes.STRING,
          allowNull: false,
          validate: { isIn: [[...VALID_KINDS]] }
        },
        detectedType: {
          type: DataTypes.STRING,
          allowNull: false,
          validate: { isIn: [[...VALID_TYPES]] }
        },
        proposedAction: {
          type: DataTypes.STRING,
          allowNull: false,
          validate: { isIn: [[...VALID_ACTIONS]] }
        },
        proposedDestRelPath: DataTypes.STRING,
        originalMatch: DataTypes.JSON,
        editedMetadata: DataTypes.JSON,
        status: {
          type: DataTypes.STRING,
          allowNull: false,
          defaultValue: 'pending',
          validate: { isIn: [[...VALID_STATUSES]] }
        },
        error: DataTypes.TEXT
      },
      {
        sequelize,
        modelName: 'pendingImport',
        indexes: [
          { fields: ['libraryId', 'status'] },
          { fields: ['libraryId', 'sourceIno'] },
          { fields: ['libraryId', 'sourcePath'] }
        ]
      }
    )

    const { library, libraryItem } = sequelize.models
    library.hasMany(PendingImport, { onDelete: 'CASCADE' })
    PendingImport.belongsTo(library)

    libraryItem.hasMany(PendingImport, { foreignKey: 'attachToLibraryItemId', onDelete: 'SET NULL' })
    PendingImport.belongsTo(libraryItem, { foreignKey: 'attachToLibraryItemId' })
  }
}

module.exports = PendingImport
