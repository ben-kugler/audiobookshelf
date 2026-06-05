const Path = require('path')
const { filePathToPOSIX, isSameOrSubPath } = require('./fileUtils')

/**
 * @typedef ImportFolderInput
 * @property {string|null} currentLibraryId - null when validating during a library create
 * @property {string|null|undefined} importFolder - new value
 * @property {boolean} importFolderEnabled - new value
 * @property {string[]} ownFolderPaths - this library's folder paths after the update
 *
 * @typedef OtherLibrary
 * @property {string} id
 * @property {string[]} folderPaths
 * @property {string|null} importFolder
 *
 * @typedef ValidationResult
 * @property {boolean} valid
 * @property {string} [error]
 */

const stripTrailingSlash = (p) => filePathToPOSIX(p).replace(/\/+$/, '')

/**
 * Validate import-folder settings against this library's own folders and
 * all other libraries' folders + import folders. Returns the first failure
 * encountered with a human-readable error message.
 *
 * @param {ImportFolderInput} input
 * @param {OtherLibrary[]} otherLibraries
 * @returns {ValidationResult}
 */
function validateImportFolderSettings(input, otherLibraries) {
  const { currentLibraryId, importFolder, importFolderEnabled, ownFolderPaths, audiobooksOnly } = input

  if (importFolderEnabled && !importFolder) {
    return { valid: false, error: 'importFolderEnabled is true but importFolder is not set' }
  }
  if (importFolderEnabled && !audiobooksOnly) {
    return { valid: false, error: 'import folder is only supported on audiobooks-only libraries' }
  }

  if (importFolder === null || importFolder === undefined) {
    return { valid: true }
  }
  if (typeof importFolder !== 'string') {
    return { valid: false, error: 'importFolder must be a string or null' }
  }
  if (!importFolder.length) {
    return { valid: false, error: 'importFolder must not be empty' }
  }
  if (!Path.isAbsolute(importFolder)) {
    return { valid: false, error: 'importFolder must be an absolute path' }
  }

  const normImport = stripTrailingSlash(importFolder)

  // Cannot equal, be inside, or be a parent of any of this library's own folders
  for (const fp of ownFolderPaths || []) {
    if (!fp) continue
    const normFolder = stripTrailingSlash(fp)
    if (isSameOrSubPath(normImport, normFolder) || isSameOrSubPath(normFolder, normImport)) {
      return { valid: false, error: `importFolder overlaps this library's folder "${fp}"` }
    }
  }

  // Same overlap check against every other library's folders + their import folder
  for (const other of otherLibraries || []) {
    if (currentLibraryId && other.id === currentLibraryId) continue
    for (const fp of other.folderPaths || []) {
      if (!fp) continue
      const normFolder = stripTrailingSlash(fp)
      if (isSameOrSubPath(normImport, normFolder) || isSameOrSubPath(normFolder, normImport)) {
        return { valid: false, error: `importFolder overlaps library "${other.id}" folder "${fp}"` }
      }
    }
    if (other.importFolder) {
      const normOtherImport = stripTrailingSlash(other.importFolder)
      if (normImport === normOtherImport) {
        return { valid: false, error: `importFolder is already used by library "${other.id}"` }
      }
    }
  }

  return { valid: true }
}

module.exports = {
  validateImportFolderSettings
}
