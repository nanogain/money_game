/* global ethers, NETWORKS, ARENA_ABI, USDC_ABI */
// Réseau utilisé : blockchain locale si le site tourne sur localhost, Base Sepolia sinon (?chain=… pour forcer).
const IS_LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const CHAIN_ID = Number(new URLSearchParams(location.search).get("chain") || (IS_LOCAL ? 31337 : 84532));
// Adresses : celles de config.js, ou celles enregistrées par deploy.html dans ce navigateur.
const SAVED = JSON.parse(localStorage.getItem(`arene-deploiement-${CHAIN_ID}`) || "null");
const APP_CONFIG = { ...NETWORKS[CHAIN_ID], ...(NETWORKS[CHAIN_ID]?.arena ? {} : SAVED || {}), chainId: CHAIN_ID };
APP_CONFIG.network = APP_CONFIG.name;
const GAMES = ["Pierre-Feuille-Ciseaux", "Morpion", "Puissance 4"];
const STATUS = ["Ouverte", "En cours", "Terminée", "Annulée"];
const PFC_MOVES = { 1: "✊", 2: "✋", 3: "✌️" };
const PFC_NAMES = { 1: "Pierre", 2: "Feuille", 3: "Ciseaux" };
const ZERO = ethers.ZeroAddress;
const DECIMALS = 6;

const state = { provider: null, signer: null, account: null, arena: null, usdc: null, readArena: null, matches: [], current: null, busy: false };
const $ = (id) => document.getElementById(id);
const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
const fmt = (v) => Number(ethers.formatUnits(v, DECIMALS)).toLocaleString("fr-FR", { maximumFractionDigits: 2 });
const same = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();

function notify(msg, error = false) {
  const n = $("notice");
  n.textContent = msg;
  n.className = "notice" + (error ? " error" : "");
  if (!error) setTimeout(() => { if (n.textContent === msg) n.classList.add("hidden"); }, 6000);
}

function errMsg(e) {
  const m = e?.shortMessage || e?.info?.error?.message || e?.message || String(e);
  const custom = {
    NotYourTurn: "Ce n'est pas votre tour.",
    InvalidMove: "Coup invalide.",
    InvalidState: "Action impossible dans l'état actuel de la partie.",
    NotPlayer: "Vous ne participez pas à cette partie.",
    TooEarly: "Le délai n'est pas encore dépassé.",
  };
  for (const k in custom) if (m.includes(k)) return custom[k];
  if (m.includes("user rejected") || m.includes("ACTION_REJECTED")) return "Transaction refusée dans le wallet.";
  return m;
}

async function tx(label, fn) {
  if (state.busy) return;
  state.busy = true;
  document.body.style.cursor = "progress";
  try {
    notify(`${label} : confirmez dans votre wallet…`);
    const t = await fn();
    notify(`${label} : transaction envoyée, en attente de confirmation…`);
    await t.wait();
    notify(`${label} : confirmé ✔`);
  } catch (e) {
    notify(`${label} : ${errMsg(e)}`, true);
    throw e;
  } finally {
    state.busy = false;
    document.body.style.cursor = "";
    await refresh();
  }
}

// ------------------------------------------------------------------ wallet

// Le site mémorise si l'utilisateur s'est déconnecté, pour ne pas le reconnecter tout seul.
const DISCONNECTED_KEY = "arene-deconnecte";

// pick = true : ouvre la fenêtre MetaMask de choix des comptes (même si un compte est déjà autorisé).
// pick = false : reconnexion silencieuse au chargement, seulement avec un compte déjà autorisé.
async function connect({ pick = false } = {}) {
  if (!window.ethereum) return notify("Aucun wallet détecté. Installez MetaMask (metamask.io), puis rechargez la page.", true);
  if (!APP_CONFIG.arena) return notify("Les contrats ne sont pas encore déployés sur ce réseau. Ouvrez la page deploy.html pour les déployer.", true);
  if (pick) {
    try {
      await window.ethereum.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
    } catch (e) {
      // Wallet qui ne gère pas la fenêtre de choix : demande classique.
      if (e?.code === 4001) throw e;
      await window.ethereum.request({ method: "eth_requestAccounts" });
    }
    localStorage.removeItem(DISCONNECTED_KEY);
  }
  const accounts = await window.ethereum.request({ method: "eth_accounts" });
  if (!accounts.length) return pick ? notify("Aucun compte autorisé dans MetaMask.", true) : undefined;
  await useAccount(accounts[0]);
}

async function useAccount(account) {
  state.provider = new ethers.BrowserProvider(window.ethereum);
  const net = await state.provider.getNetwork();
  if (Number(net.chainId) !== APP_CONFIG.chainId) {
    try {
      await switchNetwork(APP_CONFIG);
      state.provider = new ethers.BrowserProvider(window.ethereum);
    } catch {
      return notify(`Mauvais réseau : passez votre wallet sur le réseau ${APP_CONFIG.network} (chainId ${APP_CONFIG.chainId}).`, true);
    }
  }
  state.signer = await state.provider.getSigner(account);
  state.account = await state.signer.getAddress();
  state.arena = new ethers.Contract(APP_CONFIG.arena, ARENA_ABI, state.signer);
  state.usdc = new ethers.Contract(APP_CONFIG.usdc, USDC_ABI, state.signer);
  state.readArena = state.arena;
  state.current = null;
  state.warnedEth = false;
  $("gameCard").hidden = true;
  $("account").textContent = short(state.account);
  $("account").title = state.account;
  setConnectedUi(true);
  await refresh();
}

async function disconnect() {
  // Retire l'autorisation donnée au site dans MetaMask (si le wallet le permet), puis vide l'affichage.
  try { await window.ethereum?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }); } catch { /* ancien wallet */ }
  localStorage.setItem(DISCONNECTED_KEY, "1");
  Object.assign(state, { provider: null, signer: null, account: null, arena: null, usdc: null, readArena: null, matches: [], current: null });
  $("account").textContent = "Non connecté";
  $("account").title = "";
  $("balance").textContent = "";
  $("gameCard").hidden = true;
  $("openList").innerHTML = "";
  $("myList").innerHTML = "";
  setConnectedUi(false);
  notify("Déconnecté. Cliquez « Connecter le wallet » pour choisir un compte.");
}

function setConnectedUi(connected) {
  $("connectBtn").classList.toggle("hidden", connected);
  $("switchBtn").classList.toggle("hidden", !connected);
  $("disconnectBtn").classList.toggle("hidden", !connected);
  $("faucetBtn").classList.toggle("hidden", !connected || !APP_CONFIG.mockUsdc);
}

// Changement de compte dans MetaMask : on suit le compte actif, sans recharger la page.
if (window.ethereum?.on) {
  window.ethereum.on("accountsChanged", (accounts) => {
    if (localStorage.getItem(DISCONNECTED_KEY)) return;
    if (!accounts.length) return disconnect();
    if (!same(accounts[0], state.account)) useAccount(accounts[0]).catch((e) => notify(errMsg(e), true));
  });
  window.ethereum.on("chainChanged", () => location.reload());
}

async function ensureAllowance(amount) {
  const allowance = await state.usdc.allowance(state.account, APP_CONFIG.arena);
  if (allowance >= amount) return;
  await tx("Autorisation USDC", () => state.usdc.approve(APP_CONFIG.arena, amount));
}

// ------------------------------------------------------------------ actions

async function createMatch() {
  if (!state.account) return notify("Connectez d'abord votre wallet.", true);
  const game = Number($("gameSelect").value);
  const raw = $("stakeInput").value;
  let stake;
  try { stake = ethers.parseUnits(raw, DECIMALS); } catch { return notify("Mise invalide.", true); }
  if (stake <= 0n) return notify("La mise doit être positive.", true);
  await ensureAllowance(stake);
  await tx("Publication de l'annonce", () => state.arena.createMatch(game, stake));
}

async function joinMatch(id, stake) {
  await ensureAllowance(stake);
  await tx("Acceptation du défi", () => state.arena.joinMatch(id));
  openGame(id);
}

const cancelMatch = (id) => tx("Annulation", () => state.arena.cancelMatch(id));
const play = (id, pos) => tx("Coup", () => state.arena.play(id, pos));
const resign = (id) => tx("Abandon", () => state.arena.resign(id));
const claimTimeout = (id) => tx("Victoire par délai", () => state.arena.claimTimeout(id));

function secretKey(id, round) {
  return `pfc:${APP_CONFIG.arena}:${id}:${round}:${state.account}`.toLowerCase();
}

async function pfcCommit(id, round, move) {
  const salt = ethers.hexlify(ethers.randomBytes(32));
  const hash = await state.arena.pfcHash(id, round, state.account, move, salt);
  // Le coup et le sel restent dans ce navigateur jusqu'à la révélation.
  localStorage.setItem(secretKey(id, round), JSON.stringify({ move, salt }));
  await tx(`Coup caché (${PFC_NAMES[move]})`, () => state.arena.commitPfc(id, hash));
}

async function pfcReveal(id, round) {
  const saved = JSON.parse(localStorage.getItem(secretKey(id, round)) || "null");
  if (!saved) return notify("Coup introuvable dans ce navigateur : il faut révéler depuis le navigateur qui a joué.", true);
  await tx("Révélation", () => state.arena.revealPfc(id, saved.move, saved.salt));
}

// ------------------------------------------------------------------ affichage

async function refresh() {
  if (!state.readArena) return;
  try {
    const [count, bal, block] = await Promise.all([
      state.readArena.matchCount(),
      state.usdc.balanceOf(state.account),
      state.provider.getBlock("latest"),
    ]);
    state.now = Number(block.timestamp);
    const eth = await state.provider.getBalance(state.account);
    $("balance").textContent = `${fmt(bal)} USDC · ${Number(ethers.formatEther(eth)).toFixed(4)} ETH`;
    if (eth === 0n && !state.warnedEth) {
      state.warnedEth = true;
      notify("Votre wallet n'a pas d'ETH : il en faut un tout petit peu pour payer les frais de transaction. Sur le réseau de test, il est gratuit (voir le guide).", true);
    }
    const n = Number(count);
    const list = [];
    for (let from = 1; from <= n; from += 100) {
      const chunk = await state.readArena.getMatches(from, 100);
      chunk.forEach((m, i) => list.push({ id: from + i, ...m.toObject() }));
    }
    if (!state.account) return; // déconnecté pendant le chargement
    state.matches = list;
    renderLists();
    if (state.current) await renderGame();
  } catch (e) {
    console.error(e);
  }
}

function renderLists() {
  const open = state.matches.filter((m) => Number(m.status) === 0).reverse();
  const mine = state.matches.filter((m) => same(m.creator, state.account) || same(m.opponent, state.account)).reverse();

  const openList = $("openList");
  openList.innerHTML = open.length ? "" : '<p class="muted small">Aucune annonce pour le moment. Publiez la vôtre !</p>';
  for (const m of open) {
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `<div class="meta"><strong>${GAMES[Number(m.game)]}</strong><span class="muted small">#${m.id} · par ${short(m.creator)}</span></div><div><strong>${fmt(m.stake)} USDC</strong></div>`;
    const btn = document.createElement("button");
    if (same(m.creator, state.account)) {
      btn.textContent = "Annuler";
      btn.className = "ghost";
      btn.onclick = () => cancelMatch(m.id);
    } else {
      btn.textContent = "Relever le défi";
      btn.onclick = () => joinMatch(m.id, m.stake);
    }
    el.appendChild(btn);
    openList.appendChild(el);
  }

  const myList = $("myList");
  myList.innerHTML = mine.length ? "" : '<p class="muted small">Vous n\'avez pas encore de partie.</p>';
  for (const m of mine) {
    const st = Number(m.status);
    let tag = STATUS[st];
    let cls = "";
    if (st === 2) {
      if (m.winner === ZERO) tag = "Match nul";
      else if (same(m.winner, state.account)) { tag = "Gagnée"; cls = "win"; }
      else { tag = "Perdue"; cls = "lose"; }
    } else if (st === 1 && Number(m.game) !== 0 && same(m.turn, state.account)) tag = "À vous de jouer";
    const el = document.createElement("div");
    el.className = "item";
    const vs = same(m.creator, state.account) ? m.opponent : m.creator;
    el.innerHTML = `<div class="meta"><strong>${GAMES[Number(m.game)]}</strong><span class="muted small">#${m.id} · ${vs === ZERO ? "en attente d'un adversaire" : "contre " + short(vs)} · ${fmt(m.stake)} USDC</span></div><span class="tag ${cls}">${tag}</span>`;
    if (st === 1 || st === 2) {
      const btn = document.createElement("button");
      btn.textContent = st === 1 ? "Jouer" : "Voir";
      btn.className = st === 1 ? "" : "ghost";
      btn.onclick = () => openGame(m.id);
      el.appendChild(btn);
    }
    myList.appendChild(el);
  }
}

function openGame(id) {
  state.current = Number(id);
  $("gameCard").hidden = false;
  renderGame();
  $("gameCard").scrollIntoView({ behavior: "smooth" });
}

function cellOf(board, i) {
  return Number((BigInt(board) >> BigInt(i * 2)) & 3n);
}

function button(label, onclick, cls = "") {
  const b = document.createElement("button");
  b.textContent = label;
  b.className = cls;
  b.onclick = onclick;
  return b;
}

async function renderGame() {
  const m = state.matches.find((x) => x.id === state.current);
  if (!m) return;
  const game = Number(m.game);
  const st = Number(m.status);
  const me = same(m.creator, state.account) ? 1 : same(m.opponent, state.account) ? 2 : 0;
  const myTurn = st === 1 && same(m.turn, state.account);
  $("gameTitle").textContent = `${GAMES[game]} #${m.id} · ${fmt(m.stake)} USDC chacun`;
  const board = $("gameBoard");
  const actions = $("gameActions");
  board.innerHTML = "";
  actions.innerHTML = "";
  const deadline = Number(m.lastActionAt) + APP_CONFIG.moveTimeout;
  const late = state.now > deadline;
  const remaining = Math.max(0, deadline - state.now);
  const mm = `${Math.floor(remaining / 60)} min ${remaining % 60} s`;

  let status = "";
  if (st === 2) {
    const pot = BigInt(m.stake) * 2n;
    const net = pot - (pot * 200n) / 10000n;
    status = m.winner === ZERO ? "Match nul : les mises ont été remboursées."
      : same(m.winner, state.account) ? `Victoire ! Vous avez reçu ${fmt(net)} USDC.` : `Défaite. ${short(m.winner)} a remporté ${fmt(net)} USDC.`;
  } else if (st === 0) status = "En attente d'un adversaire.";

  if (game === 0) {
    const s = (await state.readArena.pfc(m.id)).toObject();
    const round = Number(m.moves);
    const myCommit = me === 1 ? s.commitCreator : s.commitOpponent;
    const theirCommit = me === 1 ? s.commitOpponent : s.commitCreator;
    const myReveal = Number(me === 1 ? s.revealCreator : s.revealOpponent);
    const theirReveal = Number(me === 1 ? s.revealOpponent : s.revealCreator);
    const empty = ethers.ZeroHash;
    if (st === 1) {
      const roundTxt = round > 0 ? `Manche ${round + 1} (égalité${round > 1 ? "s" : ""} avant). ` : "";
      if (myCommit === empty) {
        status = roundTxt + "Choisissez votre coup. Il reste caché tant que les deux joueurs n'ont pas joué.";
        const wrap = document.createElement("div");
        wrap.className = "pfc";
        for (const mv of [1, 2, 3]) {
          const b = button(PFC_MOVES[mv], () => pfcCommit(m.id, round, mv));
          b.title = PFC_NAMES[mv];
          wrap.appendChild(b);
        }
        board.appendChild(wrap);
      } else if (theirCommit === empty) {
        status = roundTxt + `Coup envoyé. En attente de l'adversaire (délai : ${mm}).`;
      } else if (myReveal === 0) {
        const saved = JSON.parse(localStorage.getItem(secretKey(m.id, round)) || "null");
        status = roundTxt + `Les deux coups sont joués. Révélez le vôtre${saved ? ` (${PFC_NAMES[saved.move]})` : ""} pour connaître le résultat.`;
        actions.appendChild(button("Révéler mon coup", () => pfcReveal(m.id, round)));
      } else {
        status = roundTxt + `Vous avez révélé ${PFC_NAMES[myReveal]}. En attente de la révélation adverse (délai : ${mm}).`;
      }
      const iActed = myCommit !== empty && (theirCommit === empty || myReveal !== 0);
      const theyActed = theirCommit !== empty && (myCommit === empty || theirReveal !== 0);
      if (late && iActed && !theyActed) actions.appendChild(button("Réclamer la victoire (adversaire inactif)", () => claimTimeout(m.id)));
    }
  } else {
    const p4 = game === 2;
    const grid = document.createElement("div");
    grid.className = "board " + (p4 ? "p4" : "morpion");
    const rows = p4 ? 6 : 3, cols = p4 ? 7 : 3;
    for (let r = rows - 1; r >= 0; r--) {
      for (let c = 0; c < cols; c++) {
        const idx = p4 ? r * 7 + c : (rows - 1 - r) * 3 + c;
        const v = cellOf(m.board, idx);
        const cell = document.createElement("div");
        cell.className = `cell ${v === 1 ? "p1" : v === 2 ? "p2" : ""}`;
        if (!p4) cell.textContent = v === 1 ? "O" : v === 2 ? "X" : "";
        const pos = p4 ? c : idx;
        if (myTurn && (p4 || v === 0)) cell.onclick = () => play(m.id, pos);
        else cell.classList.add("disabled");
        cell.dataset.pos = pos;
        grid.appendChild(cell);
      }
    }
    board.appendChild(grid);
    if (st === 1) {
      const mine = p4 ? (me === 1 ? "rouge" : "jaune") : (me === 1 ? "O" : "X");
      status = myTurn ? `À vous de jouer (vous êtes ${mine}). Temps restant : ${mm}.` : `Tour de l'adversaire (vous êtes ${mine}). Délai restant : ${mm}.`;
      if (!myTurn && late) actions.appendChild(button("Réclamer la victoire (adversaire inactif)", () => claimTimeout(m.id)));
    }
  }
  if (st === 1 && me) actions.appendChild(button("Abandonner", () => { if (confirm("Abandonner ? L'adversaire remporte le pot.")) resign(m.id); }, "danger"));
  $("gameStatus").textContent = status;
}

// ------------------------------------------------------------------ démarrage

$("connectBtn").onclick = () => connect({ pick: true }).catch((e) => notify(errMsg(e), true));
$("switchBtn").onclick = () => connect({ pick: true }).catch((e) => notify(errMsg(e), true));
$("disconnectBtn").onclick = () => disconnect();
$("createBtn").onclick = () => createMatch().catch(() => {});
$("closeGame").onclick = () => { state.current = null; $("gameCard").hidden = true; };
$("faucetBtn").onclick = () => tx("USDC de test", () => state.usdc.faucet(ethers.parseUnits("1000", DECIMALS))).catch(() => {});
$("footer").textContent = `Contrat ${short(APP_CONFIG.arena)} · réseau ${APP_CONFIG.network} · frais plateforme 2 %`;
setInterval(() => { if (!state.busy) refresh(); }, 3000);
if (!localStorage.getItem(DISCONNECTED_KEY)) connect().catch(() => {});
