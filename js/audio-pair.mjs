// 音效輸出配對（add-rig-autosetup A11）：找跟電台輸入同一台裝置的輸出。
// 依序：groupId 相同（Chrome 對同一張 USB 音效卡一致）→ 名稱比對（括號內的裝置名稱）→ 列出讓使用者選。
// default／communications 是別名，不選。
const ALIASES = new Set(['default', 'communications']);
const ROLE_WORDS = /\b(microphone|mic|speakers?|headphones?|line|input|output|in|out)\b|麥克風|喇叭|揚聲器|耳機|線路輸入|輸入|輸出/gi;

// 裝置核心名稱：有括號取第一組括號內，去掉 Windows 的「2- 」序號與角色字，小寫
export function deviceCore(label) {
  const s = String(label ?? '');
  const m = /\(([^()]*(?:\([^()]*\)[^()]*)*)\)/.exec(s);
  const core = (m ? m[1] : s).replace(/^\s*\d+-\s*/, '').replace(ROLE_WORDS, ' ');
  return core.replace(/\s+/g, ' ').trim().toLowerCase();
}

// input：{ deviceId, label, groupId }（可為 null）；devices：enumerateDevices() 的結果
// 回傳 { deviceId, label, reason:'group'|'name'|null, candidates[] }；deviceId 為 null 時讓使用者從 candidates 選
export function pairOutput(input, devices) {
  const outs = devices.filter((d) => d.kind === 'audiooutput' && d.deviceId && !ALIASES.has(d.deviceId));
  const pick = (d, reason) => ({ deviceId: d.deviceId, label: d.label, reason, candidates: [] });
  const core = deviceCore(input?.label);
  const byName = (list) => (core ? list.filter((d) => deviceCore(d.label) === core) : []);
  if (input?.groupId) {
    const same = outs.filter((d) => d.groupId === input.groupId);
    if (same.length === 1) return pick(same[0], 'group');
    if (same.length > 1) {
      const named = byName(same);
      if (named.length === 1) return pick(named[0], 'group');
      return { deviceId: null, label: '', reason: null, candidates: same };
    }
  }
  const named = byName(outs);
  if (named.length === 1) return pick(named[0], 'name');
  return { deviceId: null, label: '', reason: null, candidates: named.length ? named : outs };
}

// 有沒有電台內建 USB 音效的輸入裝置（issue #149）：Yaesu、ICOM、Kenwood 內建 USB 音效多叫「USB Audio CODEC」。
// 只是推測（其他 USB 音效卡也可能同名）；沒有麥克風權限時名稱是空的，回 false
export function hasRigCodec(devices) {
  return (devices ?? []).some((d) => d.kind === 'audioinput' && /usb audio\s*codec/i.test(d.label ?? ''));
}
