// Parses an EPUB 3 Media Overlay (SMIL) document into an ordered timeline.
// Browser-native parsing via DOMParser (runs in the reader's browser/Cypress env).

// SMIL clock values: "3.5s", "12", "0:00:08.250", "00:03.5" → seconds
export function parseClock(value) {
  if (value == null) return 0
  const v = String(value).trim()
  if (v.endsWith('ms')) return parseFloat(v) / 1000
  if (v.endsWith('s')) return parseFloat(v)
  if (v.endsWith('min')) return parseFloat(v) * 60
  if (v.endsWith('h')) return parseFloat(v) * 3600
  if (v.includes(':')) {
    const parts = v.split(':').map(parseFloat)
    return parts.reduce((acc, n) => acc * 60 + n, 0)
  }
  return parseFloat(v) || 0
}

// RSVP: which word of a SMIL par is "current" at time t. SMIL aligns per-sentence,
// not per-word, so we distribute the par's [start,end] span across its words weighted
// by length (longer words are spoken longer — closer to real narration than a uniform
// split). `lead` nudges the index ahead to compensate for sampling/perception latency.
// Clamped to [0, words.length-1]; returns 0 for an empty par.
export function rsvpWordIndex(start, end, words, t, lead = 0) {
  const n = words ? words.length : 0
  if (n < 1) return 0
  const dur = Math.max(0.001, end - start)
  const weights = words.map((w) => Math.max(1, (w || '').length))
  const total = weights.reduce((a, b) => a + b, 0)
  const elapsed = Math.min(dur, Math.max(0, t - start + lead))
  const target = (elapsed / dur) * total
  let acc = 0
  for (let i = 0; i < n; i++) {
    acc += weights[i]
    if (target < acc) return i
  }
  return n - 1
}

export function parseSmil(xmlString) {
  const doc = new DOMParser().parseFromString(xmlString, 'application/xml')
  const pars = Array.from(doc.getElementsByTagName('par'))
  const timeline = []
  for (const par of pars) {
    const text = par.getElementsByTagName('text')[0]
    const audio = par.getElementsByTagName('audio')[0]
    if (!text || !audio) continue
    timeline.push({
      textSrc: text.getAttribute('src') || '',
      audioSrc: audio.getAttribute('src') || '',
      clipBegin: parseClock(audio.getAttribute('clipBegin')),
      clipEnd: parseClock(audio.getAttribute('clipEnd'))
    })
  }
  return timeline
}
