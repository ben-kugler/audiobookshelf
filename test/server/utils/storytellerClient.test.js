const chai = require('chai')
const expect = chai.expect
const { extractToken, extractBookUuid } = require('../../../server/utils/storytellerClient')

describe('storytellerClient parsers', () => {
  describe('extractToken', () => {
    it('accepts a bare string token', () => { expect(extractToken('abc.def.ghi')).to.equal('abc.def.ghi') })
    it('accepts { token }', () => { expect(extractToken({ token: 'xyz' })).to.equal('xyz') })
    it('accepts { access_token }', () => { expect(extractToken({ access_token: 'qqq' })).to.equal('qqq') })
    it('throws on garbage', () => { expect(() => extractToken({})).to.throw() })
  })

  describe('extractBookUuid', () => {
    it('accepts { bookUuid }', () => { expect(extractBookUuid({ bookUuid: 'u1' })).to.equal('u1') })
    it('accepts { uuid }', () => { expect(extractBookUuid({ uuid: 'u2' })).to.equal('u2') })
    it('accepts { books: [{ uuid }] }', () => { expect(extractBookUuid({ books: [{ uuid: 'u3' }] })).to.equal('u3') })
    it('throws when epub2 detected', () => { expect(() => extractBookUuid({ epub2Detected: true, paths: ['x'] })).to.throw(/epub2/i) })
    it('throws on empty', () => { expect(() => extractBookUuid({})).to.throw() })
  })
})
