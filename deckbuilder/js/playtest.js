// Opening hand odds (hypergeometric) and sample hands for the current deck.

// The library: every card in the deck once per copy, commanders excluded.
const library = d => d.cards.flatMap(n => Array(qty(d, n)).fill(n));

const logFact = (() => { const t = [0]; return n => { for (let i = t.length; i <= n; i++) t[i] = t[i - 1] + Math.log(i); return t[n]; }; })();
const logC = (n, k) => k < 0 || k > n ? -Infinity : logFact(n) - logFact(k) - logFact(n - k);
// P(exactly k hits) drawing `draws` cards from `size` cards of which `hits` are hits
const hyper = (size, hits, draws, k) => Math.exp(logC(hits, k) + logC(size - hits, draws - k) - logC(size, draws));
const atLeast = (size, hits, draws, k) => 1 - Array.from({ length: k }, (_, i) => hyper(size, hits, draws, i)).reduce((a, b) => a + b, 0);
const between = (size, hits, draws, lo, hi) => Array.from({ length: hi - lo + 1 }, (_, i) => hyper(size, hits, draws, lo + i)).reduce((a, b) => a + b, 0);

async function renderPlay() {
  const d = deck;
  await lookup(d.cards);
  if (d !== deck) return;
  const lib = library(d), size = lib.length;
  const count = test => lib.filter(n => cardData[n] && test(cardData[n])).length;
  const cards = n => `${n} card${n === 1 ? '' : 's'}`;
  const lands = count(isLand), ramp = count(c => hasRole(c, 'ramp')), draw = count(c => hasRole(c, 'draw')), removal = count(c => hasRole(c, 'removal'));
  const box = $('odds');
  if (size < 8) return box.replaceChildren(el('div', 'dim', 'Add more cards to see odds.'));
  // cards seen by turn t: 7 + (t - 1) on the play, 7 + t on the draw
  const rows = [
    ['2–4 lands in the opening 7', between(size, lands, 7, 2, 4)],
    ['0–1 lands (mulligan)', between(size, lands, 7, 0, 1)],
    ['5+ lands (flood)', atLeast(size, lands, 7, 5)],
    ['3rd land drop on turn 3, on the play / draw', atLeast(size, lands, 9, 3), atLeast(size, lands, 10, 3)],
    ['4th land drop on turn 4, on the play / draw', atLeast(size, lands, 10, 4), atLeast(size, lands, 11, 4)],
    [`Ramp in the opening 7 (${cards(ramp)})`, atLeast(size, ramp, 7, 1)],
    [`Card draw by turn 3 on the play (${cards(draw)})`, atLeast(size, draw, 9, 1)],
    [`Removal by turn 4 on the play (${cards(removal)})`, atLeast(size, removal, 10, 1)],
  ];
  const t = el('table');
  t.innerHTML = `<tr><th>${size} cards, ${lands} lands</th><th class="num">Chance</th></tr>`;
  for (const [label, ...ps] of rows) {
    const tr = el('tr');
    tr.append(el('td', null, label), el('td', 'num', ps.map(pct).join(' / ')));
    t.append(tr);
  }
  box.replaceChildren(t);
  if (!hand.cards.length || hand.deck !== d) newHand(0);
}

let hand = { deck: null, lib: [], cards: [], mulligans: 0 };
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function newHand(mulligans) {
  const lib = shuffle(library(deck));
  hand = { deck, lib, cards: lib.splice(0, 7), mulligans };
  renderHand();
}
function renderHand() {
  const lands = hand.cards.filter(n => cardData[n] && isLand(cardData[n])).length;
  const drawn = hand.cards.length - 7;
  $('handinfo').textContent = `${lands} land${lands === 1 ? '' : 's'}` + (drawn ? `, ${drawn} drawn` : '') +
    (hand.mulligans ? ` · mulligan ${hand.mulligans}: put ${hand.mulligans} on the bottom (the first is free in multiplayer)` : '');
  $('hand').replaceChildren(...hand.cards.map(n => {
    const c = el('div', 'card'), img = el('img');
    img.src = big(deck.info[n]?.img) || ''; img.alt = img.title = n;
    c.append(img);
    return c;
  }));
}
$('drawhand').onclick = () => newHand(0);
$('mulligan').onclick = () => newHand(hand.mulligans + 1);
$('drawone').onclick = () => { if (hand.lib.length) { hand.cards.push(hand.lib.shift()); renderHand(); } };
