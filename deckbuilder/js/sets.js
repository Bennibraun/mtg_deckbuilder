// New-set alerts: sets released in the last 60 days or being previewed now, with how many of
// their cards fit your decks, and a nudge to recheck a set once EDHREC has data on its cards.
// Which sets you've reviewed is kept in state.json on the server, so it's shared across devices.

const SET_TYPES = ['expansion', 'core', 'masters', 'draft_innovation', 'commander'];
const DAY = 86400000;
let appState = {};
const setState = (key, value) => { appState[key] = value; fetch('state.json', { method: 'POST', body: JSON.stringify({ key, value }) }); };
const loadState = async () => { appState = await (await fetch('state.json')).json(); };

async function loadSet(code, status = () => {}) {
  const out = [];
  let url = 'https://api.scryfall.com/cards/search?' + new URLSearchParams({ q: `e:${code} -t:basic`, unique: 'cards' });
  while (url) {
    status(`loading set ${code}... ${out.length}`);
    const r = await (await fetch(url)).json();
    if (r.object === 'error') { status(r.details); return []; }
    out.push(...r.data);
    url = r.has_more ? r.next_page : null;
    if (url) await sleep(500);
  }
  return out;
}

function markReviewed(code, extra) {
  const all = { ...(appState.reviewedSets || {}) };
  all[code] = { date: new Date().toISOString().slice(0, 10), ...all[code], ...extra };
  setState('reviewedSets', all);
}

function reviewSet(code) {
  markReviewed(code);
  showView('fit');
  $('fitset').value = code;
  runFit(status => loadSet(code, status), `set ${code.toUpperCase()}`);
  checkNewSets();
}

let allSets = [];
async function checkNewSets(sets = allSets) {
  allSets = sets;
  const reviewed = appState.reviewedSets || {}, now = Date.now();
  const released = s => new Date(s.released_at).getTime();
  const fresh = sets.filter(s => !s.digital && SET_TYPES.includes(s.set_type) && s.card_count > 0 && Math.abs(released(s) - now) < 60 * DAY && !reviewed[s.code]);
  const recheck = sets.filter(s => reviewed[s.code] && !reviewed[s.code].rechecked && now - new Date(reviewed[s.code].date) > 21 * DAY && now - released(s) < 120 * DAY);
  $('alerts').innerHTML = '';
  // more than two alerts fold into one collapsible line
  let box = $('alerts'), summary;
  if (fresh.length + recheck.length > 2) {
    const group = el('details', 'alertgroup');
    summary = el('summary', null, `${fresh.length + recheck.length} set alerts`);
    group.append(summary);
    $('alerts').append(group);
    box = group;
  }
  const alert = (text, buttons) => {
    const a = el('div', 'alert');
    a.append(el('span', null, text));
    for (const [label, fn] of buttons) { const b = el('button', null, label); b.onclick = fn; a.append(b); }
    box.append(a);
    return a;
  };
  const counts = [];
  for (const s of fresh) {
    const when = released(s) > now ? `previewing, releases ${s.released_at}` : `released ${s.released_at}`;
    const a = alert(`New set: ${s.name} (${s.code.toUpperCase()}), ${when}`, [
      ['Review', () => reviewSet(s.code)],
      ['Dismiss', () => { markReviewed(s.code); a.remove(); }],
    ]);
    const n = el('span', 'dim', ' · checking your decks...');
    a.firstChild.after(n);
    counts.push([s, n]);
  }
  for (const s of recheck) {
    const a = alert(`${s.name} came out a while ago, so EDHREC has more data on its cards now`, [
      ['Recheck', () => { markReviewed(s.code, { rechecked: true }); reviewSet(s.code); }],
      ['Dismiss', () => { markReviewed(s.code, { rechecked: true }); a.remove(); }],
    ]);
  }
  let total = 0;
  for (const [s, n] of counts) {  // one set at a time to go easy on Scryfall
    const rows = await scoreCards(await loadSet(s.code), () => {}, { tops: false });
    if (!rows) { counts.forEach(([, x]) => { x.textContent = ''; }); return; }  // no deck has a commander yet
    const fits = rows.filter(r => r.fits.some(f => f.signal && !f.has)).length;
    n.textContent = ` · ${fits} card${fits === 1 ? '' : 's'} fit your decks`;
    total += fits;
    if (summary) summary.textContent = `${fresh.length + recheck.length} set alerts · ${total} card${total === 1 ? '' : 's'} fit your decks so far`;
  }
  if (summary && counts.length) summary.textContent = summary.textContent.replace(' so far', '');
}
