const { expect } = require('chai')
const LibraryFile = require('../../../server/objects/files/LibraryFile')

describe('LibraryFile isReadAlong', () => {
  it('defaults isReadAlong to null', () => {
    const lf = new LibraryFile({ ino: '1', metadata: { filename: 'a.epub', ext: '.epub', path: '/a.epub', relPath: '/a.epub' } })
    expect(lf.isReadAlong).to.equal(null)
    expect(lf.toJSON()).to.have.property('isReadAlong', null)
  })
  it('preserves isReadAlong through construct + toJSON', () => {
    const lf = new LibraryFile({ ino: '1', isReadAlong: true, metadata: { filename: 'a.readalong.epub', ext: '.epub', path: '/a.readalong.epub', relPath: '/a.readalong.epub' } })
    expect(lf.isReadAlong).to.equal(true)
    expect(lf.toJSON().isReadAlong).to.equal(true)
  })
})
