// 所有區的字典。各區分檔（多人同時翻譯不衝突）；新增區要在這裡登記
import common from './common.mjs';
import page from './page.mjs';
import config from './config.mjs';
import help from './help.mjs';
import tx from './tx.mjs';
import qso from './qso.mjs';
import js8 from './js8.mjs';
import cards from './cards.mjs';
import station from './station.mjs';
import map from './map.mjs';
import spectrum from './spectrum.mjs';
import country from './country.mjs';
import dash from './dash.mjs';
import mapui from './mapui.mjs';
import js8chat from './js8chat.mjs';
import rig from './rig.mjs';
import update from './update.mjs';
import dtadvisor from './dtadvisor.mjs';
import freq from './freq.mjs';
import jtty from './jtty.mjs';

export const DICTIONARIES = { common, page, config, help, tx, qso, js8, cards, station, map, spectrum, country, dash, mapui, js8chat, rig, update, dtadvisor, freq, jtty };

// 合併成 { en: {...}, 'zh-TW': {...} }
export function mergedDicts() {
  const out = { en: {}, 'zh-TW': {} };
  for (const d of Object.values(DICTIONARIES)) for (const loc of Object.keys(out)) Object.assign(out[loc], d[loc]);
  return out;
}
