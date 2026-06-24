/**
 * Identify a read-along ebook by filename. Matches our generated
 * "<base>.readalong.epub" and Storyteller's "<title> (readaloud).epub"
 * (and ".readaloud.epub"). Case-insensitive; .epub only.
 *
 * ponytail: filename heuristic (no EPUB/zip parsing). A real book whose
 * title literally contains "readalong"/"readaloud" would false-positive;
 * acceptable for v1.
 *
 * @param {string} filename
 * @returns {boolean}
 */
function isReadAlongEbookFilename(filename) {
  if (!filename) return false
  const lower = String(filename).toLowerCase()
  if (!lower.endsWith('.epub')) return false
  return lower.includes('readaloud') || lower.includes('readalong')
}

module.exports = { isReadAlongEbookFilename }
