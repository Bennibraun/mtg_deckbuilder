// Decks tab: a tile per deck with its key numbers, filtered by colors or text, sorted, grouped by
// folder or color identity. Filter and sort choices are remembered per browser.

const PIP_ORDER = 'wubrg';
const COLOR_NAMES = { w: 'White', u: 'Blue', b: 'Black', r: 'Red', g: 'Green', c: 'Colorless' };
const pipsOf = id => id ? [...PIP_ORDER].filter(x => id.includes(x)) : ['c'];
const artCrop = url => url?.replace('/small/', '/art_crop/');

const dashPrefs = (() => { try { return JSON.parse(localStorage.getItem('dash') || '{}'); } catch { return {}; } })();
dashPrefs.colors ??= []; dashPrefs.mode ??= 'includes'; dashPrefs.sort ??= 'changed'; dashPrefs.group ??= 'folder';
const saveDashPrefs = () => { try { localStorage.setItem('dash', JSON.stringify(dashPrefs)); } catch {} };

function pipEl(x) {
  const p = el('span', `pip pip-${x}`);
  p.title = COLOR_NAMES[x];
  return p;
}

// Numbers for one deck; cards must be looked up already.
function deckSummary(d) {
  const names = [...cmdrs(d), ...d.cards];
  const cards = names.map(n => cardData[n]).filter(Boolean);
  const n = name => isCmdr(d, name) ? 1 : qty(d, name);
  const missing = names.filter(x => !isOwned(x) && !d.info[x]?.any);
  const changed = d.log.at(-1)?.t || '';
  return {
    d, cards, size: deckSize(d), changed,
    missing: missing.reduce((s, x) => s + n(x), 0),
    missingUsd: missing.reduce((s, x) => s + (Number(cardData[x]?.usd) || 0) * n(x), 0),
    value: cards.reduce((s, c) => s + (Number(c.usd) || 0) * n(c.name), 0),
    gc: cards.filter(c => c.game_changer).length,
    themes: topThemes(d, cards, 3),
  };
}

// identity matches the selected colors: "includes" all of them, "exactly" them, or "within" them
function colorMatch(id) {
  const sel = dashPrefs.colors;
  if (!sel.length) return true;
  const have = new Set(pipsOf(id)), want = new Set(sel);
  if (dashPrefs.mode === 'includes') return sel.every(x => x === 'c' ? have.has('c') : have.has(x));
  if (dashPrefs.mode === 'exactly') return have.size === want.size && [...have].every(x => want.has(x));
  return have.has('c') || [...have].every(x => want.has(x));  // colorless fits within any colors
}

const DASH_SORTS = {
  changed: (a, b) => b.changed.localeCompare(a.changed),
  name: (a, b) => a.d.name.localeCompare(b.d.name),
  size: (a, b) => b.size - a.size,
  value: (a, b) => b.value - a.value,
  missing: (a, b) => b.missing - a.missing,
  colors: (a, b) => pipsOf(a.d.identity).length - pipsOf(b.d.identity).length || a.d.identity.localeCompare(b.d.identity),
};

let dashGen = 0;
async function renderDash() {
  const my = ++dashGen;
  const all = Object.values(decks);
  await lookup(all.flatMap(d => [...cmdrs(d), ...d.cards]));
  if (my !== dashGen) return;
  const rows = all.map(deckSummary);

  // summary over every deck, before filtering
  const complete = rows.filter(r => r.size >= 100).length;
  const toFinish = rows.reduce((s, r) => s + r.missingUsd, 0);
  const sum = $('dashsum');
  sum.innerHTML = '';
  sum.append(el('span', null, `${rows.length} deck${rows.length === 1 ? '' : 's'} · ${complete} at 100 cards · $${toFinish.toFixed(0)} in cards you don't own`));
  const dist = el('span', 'dist');
  for (const x of [...PIP_ORDER, 'c']) {
    const k = rows.filter(r => pipsOf(r.d.identity).includes(x) && r.d.commander).length;
    if (k) { const s = el('span'); s.append(pipEl(x), ` ${k}`); s.title = `${k} deck${k === 1 ? '' : 's'} with ${COLOR_NAMES[x].toLowerCase()}`; dist.append(s); }
  }
  sum.append(dist);

  const q = norm($('dashq').value || '');
  const shown = rows.filter(r => colorMatch(r.d.identity) &&
    (!q || [r.d.name, ...cmdrs(r.d), r.d.folder].some(t => norm(t || '').includes(q))))
    .sort(DASH_SORTS[dashPrefs.sort] || DASH_SORTS.changed);

  const groups = new Map();
  const groupOf = r => dashPrefs.group === 'folder' ? r.d.folder || 'No folder'
    : dashPrefs.group === 'colors' ? (r.d.commander ? pipsOf(r.d.identity).map(x => x.toUpperCase()).join('') : 'No commander') : '';
  for (const r of shown) {
    const k = groupOf(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === 'No folder' || a === 'No commander') - (b === 'No folder' || b === 'No commander') ||
    (dashPrefs.group === 'colors' ? a.length - b.length || PIP_ORDER.indexOf(a[0]?.toLowerCase()) - PIP_ORDER.indexOf(b[0]?.toLowerCase()) : a.localeCompare(b)));

  const box = $('dashdecks');
  box.innerHTML = '';
  if (!shown.length) box.append(el('div', 'dim', 'No decks match.'));
  for (const k of keys) {
    if (k) box.append(el('h3', null, `${k} (${groups.get(k).length})`));
    const grid = el('div', 'tiles');
    grid.append(...groups.get(k).map(deckTile));
    box.append(grid);
  }
}

function deckTile(r) {
  const { d } = r;
  const t = el('div', 'tile' + (d === deck ? ' current' : ''));
  const art = el('div', 'art');
  for (const n of cmdrs(d)) { const img = el('img'); img.src = artCrop(d.info[n]?.img) || ''; img.alt = n; img.loading = 'lazy'; art.append(img); }
  if (!d.commander) art.append(el('div', 'noart', 'No commander'));
  const head = el('div', 'head');
  const pips = el('span', 'pips');
  if (d.commander) pips.append(...pipsOf(d.identity).map(pipEl));
  head.append(el('b', null, d.name), pips);
  const facts = el('div', 'facts');
  const fact = (text, cls, title) => { const f = el('span', cls, text); if (title) f.title = title; facts.append(f); };
  fact(`${r.size}/100`, r.size === 100 ? 'ok' : r.size > 100 ? 'bad' : '');
  fact(r.missing ? `${r.missing} missing · $${r.missingUsd.toFixed(0)}` : 'all owned', r.missing ? '' : 'ok', 'Cards you don\'t own, and what they cost');
  if (r.gc) fact(`${r.gc} Game Changer${r.gc > 1 ? 's' : ''}`, '', r.cards.filter(c => c.game_changer).map(c => c.name).join('\n'));
  const themes = el('div', 'themes', r.themes.map(x => x.label).join(' · ') || ' ');
  const foot = el('div', 'foot');
  foot.append(el('span', 'dim', r.changed ? `changed ${new Date(r.changed).toLocaleDateString()}` : ''));
  const folder = el('select');
  folder.title = 'Folder';
  const folders = [...new Set(Object.values(decks).map(x => x.folder).filter(Boolean))].sort();
  folder.append(new Option('No folder', ''), ...folders.map(f => new Option(f, f)), new Option('New folder…', '\u0000new'));
  folder.value = d.folder;
  folder.onclick = e => e.stopPropagation();
  folder.onchange = () => {
    let f = folder.value;
    if (f === '\u0000new') f = prompt('Folder name')?.trim() || d.folder;
    d.folder = f; save(d); renderDash();
  };
  const dup = el('button', null, 'Duplicate');
  dup.onclick = e => { e.stopPropagation(); duplicateDeck(d); };
  foot.append(folder, dup);
  t.append(art, head, facts, themes, foot);
  t.title = `Open ${d.name}`;
  t.onclick = () => { openDeck(d.name); renderDash(); if (phone.matches) showView('deck'); };
  return t;
}

function duplicateDeck(d) {
  const name = uniqueName(`${d.name} (copy)`);
  decks[name] = upgrade({ ...structuredClone(d), name, log: [] });
  change(decks[name], { op: 'import', name: `copy of ${d.name}` });
  save(decks[name]);
  openDeck(name);
  renderDash();
}

// filter bar
for (const x of [...PIP_ORDER, 'c']) {
  const b = el('button', 'pipbtn');
  b.append(pipEl(x));
  b.dataset.color = x;
  b.classList.toggle('on', dashPrefs.colors.includes(x));
  b.onclick = () => {
    dashPrefs.colors = dashPrefs.colors.includes(x) ? dashPrefs.colors.filter(y => y !== x) : [...dashPrefs.colors, x];
    b.classList.toggle('on');
    saveDashPrefs(); renderDash();
  };
  $('dashcolors').append(b);
}
$('dashmode').value = dashPrefs.mode;
$('dashsort').value = dashPrefs.sort;
$('dashgroup').value = dashPrefs.group;
for (const [id, key] of [['dashmode', 'mode'], ['dashsort', 'sort'], ['dashgroup', 'group']])
  $(id).onchange = () => { dashPrefs[key] = $(id).value; saveDashPrefs(); renderDash(); };
$('dashq').oninput = () => renderDash();
$('dashnew').onclick = () => $('newdeck').click();
$('dashimport').onclick = () => $('impdeck').click();
