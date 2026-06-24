import { parseSmil, parseClock, rsvpWordIndex, ebookProgressFraction } from '@/components/readers/storytellerSmil'

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<smil xmlns="http://www.w3.org/ns/SMIL" xmlns:epub="http://www.idpf.org/2007/ops" version="3.0">
  <body>
    <seq epub:textref="chapter1.xhtml" epub:type="chapter">
      <par><text src="chapter1.xhtml#s1"/><audio src="audio/ch1.mp4" clipBegin="0s" clipEnd="3.5s"/></par>
      <par><text src="chapter1.xhtml#s2"/><audio src="audio/ch1.mp4" clipBegin="3.5s" clipEnd="0:00:08.250"/></par>
    </seq>
  </body>
</smil>`

describe('parseClock', () => {
  it('parses seconds form', () => { expect(parseClock('3.5s')).to.equal(3.5) })
  it('parses full clock form', () => { expect(parseClock('0:00:08.250')).to.equal(8.25) })
  it('parses bare number as seconds', () => { expect(parseClock('12')).to.equal(12) })
})

describe('rsvpWordIndex', () => {
  const EVEN = ['aa', 'bb', 'cc', 'dd'] // equal-length → uniform split over 10s..20s
  it('returns first word at the start', () => { expect(rsvpWordIndex(10, 20, EVEN, 10)).to.equal(0) })
  it('advances through equal-weight words over the span', () => {
    expect(rsvpWordIndex(10, 20, EVEN, 12.6)).to.equal(1)
    expect(rsvpWordIndex(10, 20, EVEN, 15.1)).to.equal(2)
    expect(rsvpWordIndex(10, 20, EVEN, 17.6)).to.equal(3)
  })
  it('clamps at the last word past the end', () => { expect(rsvpWordIndex(10, 20, EVEN, 99)).to.equal(3) })
  it('weights longer words with more time', () => {
    const words = ['I', 'elephant'] // weights 1, 8 over 10s
    expect(rsvpWordIndex(10, 20, words, 10.5)).to.equal(0) // short word still showing early
    expect(rsvpWordIndex(10, 20, words, 12)).to.equal(1) // long word dominates the span
  })
  it('lead nudges the index ahead', () => {
    expect(rsvpWordIndex(10, 20, ['aa', 'bb'], 10, 0)).to.equal(0)
    expect(rsvpWordIndex(10, 20, ['aa', 'bb'], 10, 5)).to.equal(1)
  })
  it('returns 0 for an empty par', () => { expect(rsvpWordIndex(10, 20, [], 15)).to.equal(0) })
})

describe('ebookProgressFraction', () => {
  const D = [10, 20, 30] // total 60
  it('measures within the first chapter', () => { expect(ebookProgressFraction(D, 0, 6)).to.equal(0.1) })
  it('counts completed chapters', () => { expect(ebookProgressFraction(D, 1, 5)).to.equal(0.25) })
  it('clamps to 1 at the end', () => { expect(ebookProgressFraction(D, 2, 30)).to.equal(1) })
  it('returns null when there is no duration', () => { expect(ebookProgressFraction([0, 0], 0, 5)).to.equal(null) })
})

describe('parseSmil', () => {
  it('returns an ordered timeline of pars', () => {
    const timeline = parseSmil(SAMPLE)
    expect(timeline).to.have.lengthOf(2)
    expect(timeline[0]).to.deep.equal({ textSrc: 'chapter1.xhtml#s1', audioSrc: 'audio/ch1.mp4', clipBegin: 0, clipEnd: 3.5 })
    expect(timeline[1]).to.deep.equal({ textSrc: 'chapter1.xhtml#s2', audioSrc: 'audio/ch1.mp4', clipBegin: 3.5, clipEnd: 8.25 })
  })
  it('returns empty array for SMIL with no pars', () => {
    expect(parseSmil('<smil><body><seq></seq></body></smil>')).to.deep.equal([])
  })
})
