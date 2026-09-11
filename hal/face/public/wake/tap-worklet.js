// HAL 喚醒詞音框抽取 worklet。
//
// 這支檔案刻意以「同源實體檔案」形式提供，而不是用 blob: URL 動態建立 ——
// 因為 audioWorklet.addModule() 受 CSP 的 `script-src` 管轄（worklet 是 script，不是 worker），
// 而 BFF 的 CSP 是 `script-src 'self' 'wasm-unsafe-eval'`，不含 blob:。
// 用 blob: 的話開發時正常、上線後才會被 CSP 擋掉並靜默降級成已廢棄的 ScriptProcessor
// （跑在主執行緒，會造成音訊 glitch 並卡住紅眼動畫）。
// 詳見 hal/server/src/index.ts 的 CSP 說明。
class HalTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // 固定長度、反覆覆寫的暫存區；不累積、不保留（安全紅線 5）
    this._buf = new Float32Array(1024);
    this._n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this._buf[this._n++] = ch[i];
      if (this._n === this._buf.length) {
        this.port.postMessage(this._buf.slice(0));
        this._n = 0;
      }
    }
    return true;
  }
}
registerProcessor('hal-tap', HalTapProcessor);
