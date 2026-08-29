// The game moved to /play/ on 2026-08-28; `/` is the marketing site now.
//
// Every harness tool takes a base URL from --url or CADLE_URL, and every command in CLAUDE.md, HANDOVER
// and half the scripts on disk passes a bare origin. Rather than break all of them, normalise here: a
// base that does not already point at /play/ gets it appended. Pass a URL that already ends in /play/
// (or /play) and it is left alone.
export function gameUrl(u) {
  const s = String(u || 'http://127.0.0.1:5173/').replace(/\/+$/, '');
  return (/\/play$/.test(s) ? s : s + '/play') + '/';
}
