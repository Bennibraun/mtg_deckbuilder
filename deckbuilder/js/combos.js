// Commander Spellbook combos, fetched through the server (which caches them for a day).

const combosByDeck = {}, combosDone = {};  // promises and finished results by deck contents
const comboKey = d => JSON.stringify([cmdrs(d), [...d.cards].sort()]);

// {included: [...], almostIncluded: [...]}, each combo {id, cards, produces, mv, popularity, prereq, steps}
function deckCombos(d) {
  const key = comboKey(d);
  return combosByDeck[key] ??= fetch('combos.json', { method: 'POST', body: JSON.stringify({ commanders: cmdrs(d), main: d.cards }) })
    .then(r => r.ok ? r.json() : null).catch(() => null).then(r => (combosDone[key] = r));
}
// The finished result for a deck if it's loaded; otherwise starts loading and calls `then` when done.
function combosNow(d, then) {
  const key = comboKey(d);
  if (key in combosDone) return combosDone[key];
  deckCombos(d).then(() => then?.());
}

const comboUrl = c => `https://commanderspellbook.com/combo/${c.id}/`;
const haveSet = d => new Set([...cmdrs(d), ...d.cards].map(n => norm(front(n))));

// {lowercase front name: [combos]} for combos the deck is exactly one card away from
function missingPieces(d, result) {
  const have = haveSet(d), out = {};
  for (const c of result?.almostIncluded || []) {
    const missing = c.cards.filter(n => !have.has(norm(front(n))));
    if (missing.length === 1) (out[norm(front(missing[0]))] ??= []).push(c);
  }
  return out;
}

const twoCardCombos = result => (result?.included || []).filter(c => c.cards.length === 2);

function comboEl(c, missing) {
  const box = el('div', 'combo');
  const cards = el('div');
  c.cards.forEach((n, i) => {
    if (i) cards.append(' + ');
    const s = el('span', n === missing ? 'miss' : null, n);
    preview(s, cardData[n] && small(cardData[n]));
    cards.append(s);
  });
  const link = el('a', 'dim', ' details');
  link.href = comboUrl(c); link.target = '_blank';
  box.append(cards, el('div', 'dim', c.produces.slice(0, 3).join(' · ')), link);
  box.title = [c.prereq, c.steps].filter(Boolean).join('\n\n');
  return box;
}

let comboGen = 0;  // only the latest render writes; the deck re-renders on every change
async function renderCombos(d) {
  const my = ++comboGen, box = $('combos');
  box.replaceChildren(el('div', 'dim', 'loading combos from Commander Spellbook...'));
  const result = await deckCombos(d);
  if (my !== comboGen) return;
  if (!result) return box.replaceChildren(el('div', 'dim', 'Commander Spellbook lookup failed.'));
  box.innerHTML = '';
  box.append(el('h4', null, `In the deck (${result.included.length})`));
  for (const c of result.included) box.append(comboEl(c));
  const pieces = missingPieces(d, result);
  const names = Object.values(pieces).map(cs => cs[0].cards.find(n => !haveSet(d).has(norm(front(n)))));
  const cards = await lookup(names);
  if (my !== comboGen) return;
  const rows = names.map((n, i) => ({ n, c: cards[i], combos: pieces[norm(front(n))] }))
    .sort((a, b) => isOwned(b.n) - isOwned(a.n) || b.combos.length - a.combos.length || b.combos[0].popularity - a.combos[0].popularity);
  box.append(el('h4', null, `One card away (${rows.length}, owned first)`));
  for (const { n, c, combos } of rows.slice(0, 40)) {
    const row = el('div', 'away');
    const head = el('div');
    head.append(el('b', null, n), isOwned(n) ? el('span', 'tag own', 'owned') : el('span', 'tag', 'not owned'));
    if (c) {
      const add = el('button', null, 'Add'), fit = el('button', null, 'Fit?');
      add.onclick = () => { addTo(d, c); renderDeck(); };
      fit.onclick = () => fitOne(c);
      head.append(add, fit);
      preview(head.querySelector('b'), small(c));
    }
    row.append(head, ...combos.slice(0, 3).map(x => comboEl(x, n)));
    if (combos.length > 3) row.append(el('div', 'dim', `and ${combos.length - 3} more`));
    box.append(row);
  }
}
