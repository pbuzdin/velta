// Fake WebRTC for group-call tests: pcs pair up by the token in their SDP and
// 'connect' once both sides have both descriptions.
export const pcs = [];
class FakeDC { constructor(pc) { this.pc = pc; this.readyState = "connecting"; this.sent = []; } send(d) { this.sent.push(d); const o = this.pc.remote; if (o?.dc?.onmessage) o.dc.onmessage({ data: d }); } close() { this.readyState = "closed"; } }
export class FakePC {
  constructor(cfg) { this.cfg = cfg; this.tracks = []; this.connectionState = "new"; this.iceGatheringState = "new"; this.token = `pc${pcs.length}`; this.closed = false; pcs.push(this); }
  addTrack(t) { this.tracks.push(t); }
  createDataChannel(label, o) { this.dc = new FakeDC(this); this.dcOpts = o; return this.dc; }
  async createOffer() { return { type: "offer", sdp: `v=0 offer ${this.token}\r\na=rtpmap:111 opus/48000/2` }; }
  async createAnswer() { return { type: "answer", sdp: `v=0 answer ${this.token}\r\na=rtpmap:111 opus/48000/2` }; }
  async setLocalDescription(d) { this.localDescription = d; this.iceGatheringState = "complete"; this._try(); }
  async setRemoteDescription(d) { this.remoteDescription = d; const tok = /(pc\d+)/.exec(d.sdp)[1]; this.remote = pcs.find((p) => p.token === tok); this._try(); }
  _try() {
    const o = this.remote;
    if (this.localDescription && this.remoteDescription && o && o.remote === this && o.localDescription && o.remoteDescription && !this.closed && !o.closed) {
      for (const pc of [this, o]) { pc.connectionState = "connected"; pc.dc.readyState = "open"; pc.dc.onopen?.(); pc.ontrack?.({ streams: [{ id: "s" + pc.remote.token }], track: {} }); pc.onconnectionstatechange?.(); }
    }
  }
  async getStats() { return new Map([["a", { type: "inbound-rtp", kind: "audio", audioLevel: 0.2 }]]); }
  close() { this.closed = true; this.connectionState = "closed"; }
}
export const track = () => ({ enabled: true, stopped: false, stop() { this.stopped = true; } });
export const mkStream = () => { const t = track(); return { t, getAudioTracks: () => [t], getTracks: () => [t] }; };

