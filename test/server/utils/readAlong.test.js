// test/server/utils/readAlong.test.js
const { expect } = require('chai')
const { isReadAlongEbookFilename } = require('../../../server/utils/readAlong')

describe('isReadAlongEbookFilename', () => {
  it('matches our generated .readalong.epub', () => {
    expect(isReadAlongEbookFilename('Some Book.readalong.epub')).to.equal(true)
  })
  it('matches Storyteller (readaloud).epub', () => {
    expect(isReadAlongEbookFilename('Some Book (readaloud).epub')).to.equal(true)
  })
  it('matches .readaloud.epub', () => {
    expect(isReadAlongEbookFilename('Some Book.readaloud.epub')).to.equal(true)
  })
  it('is case-insensitive', () => {
    expect(isReadAlongEbookFilename('BOOK (READALOUD).EPUB')).to.equal(true)
  })
  it('does not match a plain epub', () => {
    expect(isReadAlongEbookFilename('Some Book.epub')).to.equal(false)
  })
  it('does not match a non-epub even if it contains readalong', () => {
    expect(isReadAlongEbookFilename('readalong-notes.txt')).to.equal(false)
  })
  it('handles null/undefined', () => {
    expect(isReadAlongEbookFilename(null)).to.equal(false)
    expect(isReadAlongEbookFilename(undefined)).to.equal(false)
  })
})
