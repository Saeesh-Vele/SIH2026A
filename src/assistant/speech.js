/* ═══════════════════════════════════════════════════════════════
   Aurora assistant — Web Speech API wrappers.

   Recognition (SpeechRecognition / webkitSpeechRecognition) is missing in some
   browsers (Firefox): the panel then offers text only and says why. Browser speech
   recognition may send audio to the browser vendor; the panel says so too.
   Synthesis uses the browser's own voices. Nothing here runs without a user gesture:
   the panel calls these from a click / key press, or after one has happened.
   ═══════════════════════════════════════════════════════════════ */

export function speechSupport() {
  if (typeof window === 'undefined') return { recognition: false, synthesis: false };
  return {
    recognition: Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
    synthesis: Boolean(window.speechSynthesis && window.SpeechSynthesisUtterance),
  };
}

export const LANGS = { en: 'en-IN', hi: 'hi-IN' };

/** A voice for `lang` ('en' | 'hi'), or null (the browser default is used). */
export function pickVoice(lang) {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  const tag = LANGS[lang] || 'en-IN';
  const base = tag.split('-')[0];
  return voices.find((v) => v.lang === tag) || voices.find((v) => v.lang?.startsWith(`${base}-`)) || voices.find((v) => v.lang?.startsWith(base)) || null;
}

export function hasHindiVoice() {
  return (window.speechSynthesis?.getVoices?.() || []).some((v) => v.lang?.startsWith('hi'));
}

/** Plain text for speech: no markdown, symbols read as words. */
export function speakable(text) {
  return String(text || '').replace(/[*#_`]/g, '').replace(/CO₂/g, 'CO2').replace(/°C/g, ' degrees Celsius')
    .replace(/(\d)\s?kL\b/g, '$1 kilolitres').replace(/(\d)\s?L\/hr\b/g, '$1 litres per hour').replace(/(\d)\s?L\/h\b/g, '$1 litres per hour')
    .replace(/(\d)\s?kW\b/g, '$1 kilowatts').replace(/(\d)\s?km\/h\b/g, '$1 kilometres per hour').replace(/(\d)\s?hPa\b/g, '$1 hectopascals')
    .replace(/(\d)\s?ppm\b/g, '$1 parts per million').replace(/(\d)\s?dBm\b/g, '$1 dBm').replace(/σ/g, ' sigma').replace(/→/g, ' to ');
}

/** Speak; resolves when finished, cancelled or failed (never rejects). */
export function speak(text, { rate = 1, lang = 'en', onStart } = {}) {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    if (!synth || !text) { resolve('unsupported'); return; }
    synth.cancel();
    const said = speakable(text);
    const u = new window.SpeechSynthesisUtterance(said);
    // Some engines never fire `end` (no voices installed, headless): give up after a generous
    // estimate so the panel does not stay in "speaking" and conversation mode can resume.
    const guard = setTimeout(() => resolve('timeout'), 4000 + (said.length * 110) / rate);
    const v = pickVoice(lang);
    if (v) u.voice = v;
    u.lang = v?.lang || LANGS[lang] || 'en-IN';
    u.rate = rate;
    u.onstart = () => onStart?.();
    u.onend = () => { clearTimeout(guard); resolve('ended'); };
    u.onerror = (e) => {
      clearTimeout(guard);
      if (e.error !== 'interrupted' && e.error !== 'canceled') console.warn('[Aurora] speech synthesis error', e.error);
      resolve('error');
    };
    synth.speak(u);
  });
}

export function stopSpeaking() {
  try { window.speechSynthesis?.cancel(); } catch (err) { console.warn('[Aurora] could not stop speech', err); }
}

/**
 * A recogniser. `continuous` keeps listening across pauses (conversation mode / push-to-talk).
 * Callbacks: onInterim(text), onFinal(text), onEnd(), onError(code).
 */
export function createRecognizer({ lang = 'en', continuous = false, onInterim, onFinal, onEnd, onError }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.lang = LANGS[lang] || 'en-IN';
  rec.interimResults = true;
  rec.continuous = continuous;
  rec.maxAlternatives = 1;
  rec.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
      const r = ev.results[i];
      if (r.isFinal) onFinal?.(r[0].transcript.trim());
      else interim += r[0].transcript;
    }
    onInterim?.(interim.trim());
  };
  rec.onerror = (ev) => {
    if (ev.error !== 'no-speech' && ev.error !== 'aborted') console.warn('[Aurora] speech recognition error', ev.error);
    onError?.(ev.error);
  };
  rec.onend = () => onEnd?.();
  return rec;
}

/** Human text for a recognition error code. */
export function recognitionErrorText(code) {
  if (code === 'not-allowed' || code === 'service-not-allowed') return 'Microphone access was blocked. Allow it in the browser, or type instead.';
  if (code === 'audio-capture') return 'No microphone was found. Type your request instead.';
  if (code === 'network') return 'Speech recognition needs the browser vendor’s service, which is unreachable. Type instead.';
  if (code === 'language-not-supported') return 'This language is not supported for voice input here.';
  return null;
}
