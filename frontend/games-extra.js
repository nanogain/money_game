/* global ethers, APP_CONFIG, state, tx, notify, button, renderGame */
// Écrans des jeux « Duel de dés » (game 3) et « Bataille navale » (game 4).
// Utilise les fonctions communes de app.js (tx, notify, button, state…).

const ABI = ethers.AbiCoder.defaultAbiCoder();
const DICE_FACES = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
const NAVAL_SIZES = [4, 3, 3, 2];
const NAVAL_CELLS = 12;
const COLS = "ABCDEFGH";
const cellName = (c) => `${COLS[c % 8]}${Math.floor(c / 8) + 1}`;
const bitSet = (mask, c) => ((BigInt(mask) >> BigInt(c)) & 1n) === 1n;
const popcount = (mask) => { let v = BigInt(mask), n = 0; while (v) { v &= v - 1n; n++; } return n; };
const lateButton = (actions, id) => actions.appendChild(button("Réclamer la victoire (adversaire inactif)", () => tx("Victoire par délai", () => state.arena.claimTimeout(id))));

// Empreintes calculées dans le navigateur : le secret ne part jamais vers le nœud RPC.
function diceHashLocal(id, round, player, secret) {
  return ethers.keccak256(ABI.encode(
    ["string", "address", "uint256", "uint256", "uint8", "address", "bytes32"],
    ["des", APP_CONFIG.arena, APP_CONFIG.chainId, id, round, player, secret]));
}
function navalHashLocal(id, player, f, salt) {
  return ethers.keccak256(ABI.encode(
    ["string", "address", "uint256", "uint256", "address", "uint8[4]", "uint8[4]", "bool[4]", "bytes32"],
    ["navale", APP_CONFIG.arena, APP_CONFIG.chainId, id, player, f.xs, f.ys, f.v, salt]));
}

async function renderExtraGame(m, ctx) {
  return ctx.game === 3 ? renderDice(m, ctx) : renderNaval(m, ctx);
}

// ------------------------------------------------------------------ duel de dés

const diceKey = (id, round) => `des:${APP_CONFIG.arena}:${id}:${round}:${state.account}`.toLowerCase();

async function renderDice(m, { st, me, late, mm, board, actions }) {
  const d = (await state.readArena.dice(m.id)).toObject();
  const round = Number(m.moves);
  const mine = me === 1 ? "Creator" : "Opponent", theirs = me === 1 ? "Opponent" : "Creator";
  const empty = ethers.ZeroHash;

  const lastMe = Number(d[`lastDie${mine}`]), lastThem = Number(d[`lastDie${theirs}`]);
  if (lastMe) {
    const wrap = document.createElement("div");
    wrap.className = "dice";
    wrap.innerHTML = `<div><span>${DICE_FACES[lastMe]}</span><small>Vous</small></div><div><span>${DICE_FACES[lastThem]}</span><small>Adversaire</small></div>`;
    board.appendChild(wrap);
  }
  if (st !== 1) return null;

  const roundTxt = round > 0 ? `Égalité ${lastMe}–${lastThem} : on relance (manche ${round + 1}). ` : "";
  const myCommit = d[`commit${mine}`], theirCommit = d[`commit${theirs}`];
  const myRev = d[`revealed${mine}`], theirRev = d[`revealed${theirs}`];
  let status;
  if (myCommit === empty) {
    status = roundTxt + "Lancez vos dés. Le résultat combine un secret de chaque joueur : personne ne peut le truquer.";
    actions.appendChild(button("🎲 Lancer les dés", async () => {
      const secret = ethers.hexlify(ethers.randomBytes(32));
      localStorage.setItem(diceKey(m.id, round), secret);
      await tx("Lancer des dés", () => state.arena.commitDice(m.id, diceHashLocal(m.id, round, state.account, secret)));
    }));
  } else if (theirCommit === empty) {
    status = roundTxt + `Dés lancés. En attente de l'adversaire (délai : ${mm}).`;
  } else if (!myRev) {
    status = roundTxt + "Les deux joueurs ont lancé. Révélez pour découvrir les dés.";
    actions.appendChild(button("Révéler les dés", async () => {
      const secret = localStorage.getItem(diceKey(m.id, round));
      if (!secret) return notify("Secret introuvable dans ce navigateur : il faut révéler depuis le navigateur qui a lancé.", true);
      await tx("Révélation", () => state.arena.revealDice(m.id, secret));
    }));
  } else {
    status = roundTxt + `Révélé. En attente de la révélation adverse (délai : ${mm}).`;
  }
  const iActed = myCommit !== empty && (theirCommit === empty || myRev);
  const theyActed = theirCommit !== empty && (myCommit === empty || theirRev);
  if (late && iActed && !theyActed) lateButton(actions, m.id);
  return status;
}

// ------------------------------------------------------------------ bataille navale

const navalKey = (id) => `navale:${APP_CONFIG.arena}:${id}:${state.account}`.toLowerCase();
const placing = {}; // placement en cours par partie : { ships: [{x,y,v}], vertical }

function fleetCells(ships) {
  const cells = new Set();
  ships.forEach((s, i) => {
    for (let k = 0; k < NAVAL_SIZES[i]; k++) cells.add(s.v ? (s.y + k) * 8 + s.x : s.y * 8 + s.x + k);
  });
  return cells;
}

function canPlace(ships, x, y, v) {
  const len = NAVAL_SIZES[ships.length];
  if (v ? y + len > 8 : x + len > 8) return false;
  const used = fleetCells(ships);
  for (let k = 0; k < len; k++) if (used.has(v ? (y + k) * 8 + x : y * 8 + x + k)) return false;
  return true;
}

function randomFleet() {
  for (;;) {
    const ships = [];
    for (let tries = 0; ships.length < 4 && tries < 200; tries++) {
      const v = Math.random() < 0.5, x = Math.floor(Math.random() * 8), y = Math.floor(Math.random() * 8);
      if (canPlace(ships, x, y, v)) ships.push({ x, y, v });
    }
    if (ships.length === 4) return ships;
  }
}

function grid(title, cellFn) {
  const box = document.createElement("div");
  box.className = "naval-box";
  box.innerHTML = `<div class="small muted">${title}</div>`;
  const g = document.createElement("div");
  g.className = "naval";
  g.appendChild(document.createElement("div"));
  for (let c = 0; c < 8; c++) { const h = document.createElement("div"); h.className = "lbl"; h.textContent = COLS[c]; g.appendChild(h); }
  for (let r = 0; r < 8; r++) {
    const l = document.createElement("div"); l.className = "lbl"; l.textContent = r + 1; g.appendChild(l);
    for (let c = 0; c < 8; c++) {
      const el = document.createElement("div");
      el.className = "ncell";
      el.dataset.cell = r * 8 + c;
      cellFn(r * 8 + c, el);
      g.appendChild(el);
    }
  }
  box.appendChild(g);
  return box;
}

async function renderNaval(m, { st, me, late, mm, board, actions }) {
  const n = (await state.readArena.naval(m.id)).toObject();
  const phase = Number(n.phase);
  const mine = me === 1 ? "Creator" : "Opponent", theirs = me === 1 ? "Opponent" : "Creator";
  const saved = JSON.parse(localStorage.getItem(navalKey(m.id)) || "null");
  const myShips = saved ? fleetCells(saved.ships) : new Set();
  const empty = ethers.ZeroHash;
  const wrap = document.createElement("div");
  wrap.className = "naval-wrap";
  board.appendChild(wrap);

  // ---- placement
  if (st === 1 && phase === 0 && n[`commit${mine}`] === empty) {
    const p = (placing[m.id] ||= { ships: [], vertical: false });
    const used = fleetCells(p.ships);
    wrap.appendChild(grid("Votre flotte (cliquez la case de départ de chaque bateau)", (c, el) => {
      if (used.has(c)) el.classList.add("ship");
      if (p.ships.length < 4) el.onclick = () => {
        const x = c % 8, y = Math.floor(c / 8);
        if (!canPlace(p.ships, x, y, p.vertical)) return notify("Le bateau sort du plateau ou chevauche un autre bateau.", true);
        p.ships.push({ x, y, v: p.vertical });
        renderGameSafe();
      };
    }));
    actions.appendChild(button(p.vertical ? "Sens : vertical ↓" : "Sens : horizontal →", () => { p.vertical = !p.vertical; renderGameSafe(); }, "ghost"));
    actions.appendChild(button("Placement aléatoire", () => { p.ships = randomFleet(); renderGameSafe(); }, "ghost"));
    actions.appendChild(button("Recommencer", () => { p.ships = []; renderGameSafe(); }, "ghost"));
    if (p.ships.length === 4) {
      actions.appendChild(button("Valider ma flotte", async () => {
        const salt = ethers.hexlify(ethers.randomBytes(32));
        const f = { xs: p.ships.map((s) => s.x), ys: p.ships.map((s) => s.y), v: p.ships.map((s) => s.v) };
        // Le plateau et le sel restent dans ce navigateur jusqu'à la révélation finale.
        localStorage.setItem(navalKey(m.id), JSON.stringify({ ships: p.ships, salt }));
        await tx("Validation de la flotte", () => state.arena.commitNavalBoard(m.id, navalHashLocal(m.id, state.account, f, salt)));
      }));
    }
    const next = p.ships.length < 4 ? `Placez le bateau de ${NAVAL_SIZES[p.ships.length]} cases.` : "Flotte complète : validez-la.";
    return `Placement (bateaux de 4, 3, 3 et 2 cases). ${next} Votre plateau reste secret ; il sera vérifié à la fin.`;
  }

  // ---- plateaux
  const myShots = n[`shotsBy${mine}`], myHits = n[`hitsBy${mine}`];
  const theirShots = n[`shotsBy${theirs}`], theirHits = n[`hitsBy${theirs}`];
  const pending = n.hasPending ? Number(n.pendingCell) : null;
  const myTurn = st === 1 && phase === 1 && m.turn.toLowerCase() === state.account.toLowerCase();
  const pendingAtMe = myTurn && pending !== null; // l'adversaire vient de tirer sur moi
  const answer = pendingAtMe && myShips.has(pending);
  const lastHitToLose = answer && popcount(theirHits) + 1 >= NAVAL_CELLS;
  const iShotAll = BigInt(myShots) === (1n << 64n) - 1n;

  wrap.appendChild(grid(`Votre flotte · ${popcount(theirHits)}/${NAVAL_CELLS} touchés`, (c, el) => {
    if (myShips.has(c)) el.classList.add("ship");
    if (bitSet(theirShots, c)) el.classList.add(bitSet(theirHits, c) || (pendingAtMe && c === pending && answer) ? "hit" : "miss");
    if (pendingAtMe && c === pending) el.classList.add("pending");
  }));
  const fire = (c) => tx(`Tir en ${cellName(c)}`, () => state.arena.navalTurn(m.id, answer, c));
  wrap.appendChild(grid(`Flotte adverse · ${popcount(myHits)}/${NAVAL_CELLS} touchés`, (c, el) => {
    if (bitSet(myShots, c)) el.classList.add(bitSet(myHits, c) ? "hit" : "miss");
    else if (myTurn && !lastHitToLose && !iShotAll) { el.classList.add("target"); el.onclick = () => fire(c); }
  }));

  if (st !== 1) return null;
  if (phase === 0) {
    if (late && n[`commit${theirs}`] === empty) lateButton(actions, m.id);
    return `Flotte validée. En attente du placement adverse (délai : ${mm}).`;
  }
  if (phase === 1) {
    if (!myTurn) {
      if (late) lateButton(actions, m.id);
      return `Tour de l'adversaire (délai : ${mm}).`;
    }
    if (pendingAtMe && !saved) return "Plateau introuvable dans ce navigateur : il faut jouer depuis le navigateur qui a placé la flotte.";
    const report = pendingAtMe ? `L'adversaire a tiré en ${cellName(pending)} : ${answer ? "touché" : "raté"} (annoncé automatiquement). ` : "";
    if (lastHitToLose || iShotAll) {
      actions.appendChild(button("Continuer vers la révélation", () => tx("Fin des tirs", () => state.arena.navalTurn(m.id, answer, 0))));
      return report + (lastHitToLose ? "Votre dernier bateau est coulé." : "Vous avez visé toutes les cases.") + " Place à la vérification des plateaux.";
    }
    return report + `À vous de tirer : cliquez une case du plateau adverse (temps restant : ${mm}).`;
  }
  // phase 2 : révélation
  const myRev = Number(n[`reveal${mine}`]), theirRev = Number(n[`reveal${theirs}`]);
  if (myRev === 0) {
    actions.appendChild(button("Révéler mon plateau", async () => {
      if (!saved) return notify("Plateau introuvable dans ce navigateur : il faut révéler depuis le navigateur qui a placé la flotte.", true);
      const s = saved.ships;
      await tx("Révélation du plateau", () => state.arena.revealNavalBoard(m.id, s.map((x) => x.x), s.map((x) => x.y), s.map((x) => x.v), saved.salt));
    }));
    return "Fin des tirs. Révélez votre plateau : le contrat vérifie que chacun a annoncé ses touchés honnêtement.";
  }
  if (late && myRev === 1 && theirRev === 0) lateButton(actions, m.id);
  return `Plateau révélé. En attente de la révélation adverse (délai : ${mm}).`;
}

// Rafraîchit l'écran de la partie après un clic de placement (sans transaction).
function renderGameSafe() {
  renderGame().catch((e) => console.error(e));
}
