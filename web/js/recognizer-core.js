// Shepit Web — streaming recognition on top of sherpa-onnx (WebAssembly).
// Classic script: loaded with importScripts() in the worker and with vm in the
// Node test, so both run exactly the same logic.
/* global createOnlineRecognizer */

const SAMPLE_RATE = 16000;

/**
 * Wraps one Nemotron recognizer + stream: feed 16 kHz audio, get a running
 * partial line and finished phrases (with times) at each pause.
 */
class StreamingTranscriber {
  /**
   * @param {object} Module  initialised emscripten module
   * @param {string} dir     folder in the emscripten FS holding the model files
   * @param {object} opts    { language, maxPhraseSec }
   */
  constructor(Module, dir, opts = {}) {
    this.Module = Module;
    this.language = opts.language || 'auto';
    const config = {
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: `${dir}/encoder.int8.onnx`,
          decoder: `${dir}/decoder.int8.onnx`,
          joiner: `${dir}/joiner.int8.onnx`,
        },
        paraformer: { encoder: '', decoder: '' },
        zipformer2Ctc: { model: '' },
        nemoCtc: { model: '' },
        toneCtc: { model: '' },
        tokens: `${dir}/tokens.txt`,
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
        modelType: '',
        modelingUnit: '',
        bpeVocab: '',
      },
      decodingMethod: 'greedy_search',
      maxActivePaths: 4,
      enableEndpoint: 1,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 1.0,
      rule3MinUtteranceLength: opts.maxPhraseSec || 20,
      hotwordsFile: '',
      hotwordsScore: 1.5,
      ctcFstDecoderConfig: { graph: '', maxActive: 3000 },
      ruleFsts: '',
      ruleFars: '',
    };
    this.recognizer = createOnlineRecognizer(Module, config);
    if (!this.recognizer.handle) throw new Error('Не вдалося створити розпізнавач (модель пошкоджена?)');
    this.samplesFed = 0;
    this.phraseStart = 0;
    this.stream = this._newStream();
  }

  _newStream() {
    const s = this.recognizer.createStream();
    s.setOption('language', this.language);
    return s;
  }

  _ms(samples) {
    return Math.round((samples * 1000) / SAMPLE_RATE);
  }

  static clean(text) {
    return (text || '').replace(/<[a-z]{2,3}(-[A-Z]{2})?>/g, '').replace(/\s+/g, ' ').trim();
  }

  /** Moves the timeline (e.g. after a pause, recording continues at `ms`). */
  setTimeline(ms) {
    this.samplesFed = Math.round((ms * SAMPLE_RATE) / 1000);
    this.phraseStart = this.samplesFed;
  }

  /**
   * @param {Float32Array} samples 16 kHz mono
   * @returns {{partial: string, final: null | {start: number, end: number, text: string}}}
   */
  accept(samples) {
    this.stream.acceptWaveform(SAMPLE_RATE, samples);
    this.samplesFed += samples.length;
    while (this.recognizer.isReady(this.stream)) this.recognizer.decode(this.stream);
    const text = StreamingTranscriber.clean(this.recognizer.getResult(this.stream).text);
    if (this.recognizer.isEndpoint(this.stream)) {
      const final = text ? { start: this._ms(this.phraseStart), end: this._ms(this.samplesFed), text } : null;
      this.recognizer.reset(this.stream);
      this.phraseStart = this.samplesFed;
      return { partial: '', final };
    }
    if (!text) this.phraseStart = this.samplesFed;
    return { partial: text, final: null };
  }

  /** Ends the phrase in progress and starts a fresh stream. */
  finish() {
    this.stream.acceptWaveform(SAMPLE_RATE, new Float32Array(SAMPLE_RATE / 2));
    this.stream.inputFinished();
    while (this.recognizer.isReady(this.stream)) this.recognizer.decode(this.stream);
    const text = StreamingTranscriber.clean(this.recognizer.getResult(this.stream).text);
    const final = text ? { start: this._ms(this.phraseStart), end: this._ms(this.samplesFed), text } : null;
    this.stream.free();
    this.stream = this._newStream();
    this.phraseStart = this.samplesFed;
    return final;
  }

  setLanguage(language) {
    this.language = language || 'auto';
    return this.finish();
  }

  free() {
    if (this.stream) this.stream.free();
    if (this.recognizer) this.recognizer.free();
    this.stream = null;
    this.recognizer = null;
  }
}

if (typeof module === 'object' && module.exports) {
  module.exports = { StreamingTranscriber, SAMPLE_RATE };
}
