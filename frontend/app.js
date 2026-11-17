/* global ethers, NETWORKS, ARENA_ABI, USDC_ABI, switchNetwork */
// Réseau utilisé : blockchain locale si le site tourne sur localhost, Base Sepolia sinon (?chain=… pour forcer).
const PARAMS = new URLSearchParams(location.search);
const IS_LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const CHAIN_ID = Number(PARAMS.get("chain") || (IS_LOCAL ? 31337 : 84532));
// Adresses : celles de config.js, ou celles enregistrées par deploy.html dans ce navigateur.
const SAVED = JSON.parse(localStorage.getItem(`arene-deploiement-${CHAIN_ID}`) || "null");
const APP_CONFIG = { ...NETWORKS[CHAIN_ID], ...(NETWORKS[CHAIN_ID]?.arena ? {} : SAVED || {}), chainId: CHAIN_ID };
APP_CONFIG.network = APP_CONFIG.name;
const GAMES = ["Pierre-Feuille-Ciseaux", "Morpion", "Puissance 4", "Duel de dés", "Bataille navale"];
// Icône et règles affichées pour chaque jeu (un jeu absent de cette liste s'affiche quand même, sans règles).
const GAME_INFO = {
  0: { icon: "✊", rules: "Chacun choisit pierre, feuille ou ciseaux en secret, puis révèle son coup. La pierre bat les ciseaux, les ciseaux battent la feuille, la feuille bat la pierre. Égalité : on rejoue une manche." },
  1: { icon: "⭕", rules: "Grille de 3 × 3. Le premier qui aligne 3 symboles (ligne, colonne ou diagonale) gagne. Grille pleine sans alignement : match nul." },
  2: { icon: "🔴", rules: "Grille de 7 colonnes. On choisit une colonne, le jeton tombe tout en bas. Le premier qui aligne 4 jetons (ligne, colonne ou diagonale) gagne." },
  3: { icon: "🎲", rules: "Chacun lance un dé. Le résultat combine un secret de chaque joueur : personne ne peut le truquer. Le plus haut dé gagne, égalité : on relance." },
  4: { icon: "🚢", rules: "Plateau de 8 × 8, bateaux de 4, 3, 3 et 2 cases, placés en secret. Chacun tire à son tour ; le premier qui coule toute la flotte adverse gagne. À la fin, les plateaux sont révélés et le contrat vérifie que personne n'a menti." },
};
const gameName = (g) => GAMES[Number(g)] || `Jeu n° ${Number(g)}`;
const gameIcon = (g) => GAME_INFO[Number(g)]?.icon || "🎲";
const STATUS = ["Ouverte", "En cours", "Terminée", "Annulée"];
const PFC_MOVES = { 1: "✊", 2: "✋", 3: "✌️" };
const PFC_NAMES = { 1: "Pierre", 2: "Feuille", 3: "Ciseaux" };
const ZERO = ethers.ZeroAddress;
const DECIMALS = 6;
const FEE_BPS = 200n; // 2 % du pot, comme dans le contrat
const HISTORY_PAGE = 10;
const ETH_FAUCET = "https://portal.cdp.coinbase.com/onchain-tools/faucet";

const state = {
  provider: null, signer: null, account: null, arena: null, usdc: null, readArena: null, reader: null,
  matches: [], current: null, busy: false, filter: "all", historyShown: HISTORY_PAGE,
  owner: null, fees: 0n, eth: null, usdcBal: null, now: 0, clockOffset: 0,
  boards: {}, lastCells: {}, invite: PARAMS.get("partie") ? Number(PARAMS.get("partie")) : null,
};
const $ = (id) => document.getElementById(id);
const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
const fmt = (v) => Number(ethers.formatUnits(v, DECIMALS)).toLocaleString("fr-FR", { maximumFractionDigits: 2 });
const signed = (v) => (v > 0n ? "+" : v < 0n ? "−" : "") + fmt(v < 0n ? -v : v);
const same = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const netPrize = (stake) => { const pot = BigInt(stake) * 2n; return pot - (pot * FEE_BPS) / 10000n; };
const txLink = (hash) => (APP_CONFIG.explorer && hash ? `${APP_CONFIG.explorer}/tx/${hash}` : "");
const addrLink = (a) => (APP_CONFIG.explorer ? `<a href="${APP_CONFIG.explorer}/address/${a}" target="_blank" rel="noopener">${short(a)}</a>` : short(a));
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const nowSec = () => Math.floor(Date.now() / 1000) + state.clockOffset;

function notify(msg, error = false, link = "") {
  const n = $("notice");
  n.textContent = msg;
  if (link) {
    const a = document.createElement("a");
    a.href = link; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Voir la transaction";
    n.appendChild(a);
  }
  n.className = "notice" + (error ? " error" : "");
  if (!error) setTimeout(() => { if (n.textContent.startsWith(msg)) n.classList.add("hidden"); }, 8000);
}

function errMsg(e) {
  const m = e?.shortMessage || e?.info?.error?.message || e?.message || String(e);
  const custom = {
    NotYourTurn: "Ce n'est pas votre tour.",
    InvalidMove: "Coup invalide.",
    InvalidState: "Action impossible dans l'état actuel de la partie.",
    NotPlayer: "Vous ne participez pas à cette partie.",
    TooEarly: "Le délai n'est pas encore dépassé.",
    OwnableUnauthorizedAccount: "Seul le propriétaire du contrat peut faire cela.",
  };
  for (const k in custom) if (m.includes(k)) return custom[k];
  if (m.includes("user rejected") || m.includes("ACTION_REJECTED")) return "Transaction refusée dans le wallet.";
  if (m.includes("insufficient funds")) return "Pas assez d'ETH pour payer les frais de transaction.";
  return m;
}

async function tx(label, fn, { session = false } = {}) {
  if (state.busy) return;
  state.busy = true;
  document.body.style.cursor = "progress";
  try {
    notify(session ? `${label} : envoi…` : `${label} : confirmez dans votre wallet…`);
    const t = await fn();
    notify(`${label} : transaction envoyée, en attente de confirmation…`, false, txLink(t.hash));
    await t.wait();
    notify(`${label} : confirmé ✔`, false, txLink(t.hash));
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
  if (!window.ethereum) {
    if (isMobile) location.href = metamaskDeepLink();
    else notify("Aucun wallet détecté. Installez MetaMask (metamask.io), puis rechargez la page.", true);
    return;
  }
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
  // Connexion demandée par le joueur : on enchaîne tout de suite sur l'activation de la session
  // (la seule confirmation), sauf si une session valide existe déjà pour ce navigateur.
  if (pick && state.account && (await sessionSupported()) && !sessionReady(1n) && state.eth > 0n) {
    await activateSession().catch(() => {});
  }
}

function metamaskDeepLink() {
  return `https://metamask.app.link/dapp/${location.host}${location.pathname}${location.search}`;
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
  state.reader = state.provider;
  state.readArena = state.arena;
  state.current = null;
  state.warnedEth = false;
  state.session = null;
  state.historyShown = HISTORY_PAGE;
  $("gameCard").hidden = true;
  $("account").textContent = short(state.account);
  $("account").title = state.account;
  setConnectedUi(true);
  await refresh();
}

// Sans wallet connecté, on lit quand même les annonces via le nœud public du réseau.
function useReadOnly() {
  state.provider = null; state.signer = null; state.account = null; state.arena = null; state.usdc = null;
  state.reader = null; state.readArena = null;
  if (!APP_CONFIG.arena || !APP_CONFIG.rpc) return;
  try {
    state.reader = new ethers.JsonRpcProvider(APP_CONFIG.rpc, APP_CONFIG.chainId, { staticNetwork: true });
    state.readArena = new ethers.Contract(APP_CONFIG.arena, ARENA_ABI, state.reader);
  } catch (e) { console.warn(e); }
}

async function disconnect() {
  // Retire l'autorisation donnée au site dans MetaMask (si le wallet le permet), puis vide l'affichage.
  try { await window.ethereum?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }); } catch { /* ancien wallet */ }
  localStorage.setItem(DISCONNECTED_KEY, "1");
  Object.assign(state, { matches: [], current: null, owner: null, eth: null, usdcBal: null });
  useReadOnly();
  $("account").textContent = "Non connecté";
  $("account").title = "";
  $("balance").textContent = "";
  $("gameCard").hidden = true;
  setConnectedUi(false);
  render();
  notify("Déconnecté. Cliquez « Connecter le wallet » pour choisir un compte.");
  refresh();
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

// Autorisation USDC donnée une seule fois (pour toutes les parties) : ensuite, publier ou
// relever un défi ne demande plus qu'une seule confirmation. Le contrat ne prélève jamais
// que la mise choisie, et uniquement quand vous publiez ou acceptez une annonce.
async function ensureAllowance(amount) {
  const allowance = await state.usdc.allowance(state.account, APP_CONFIG.arena);
  if (allowance >= amount) return;
  await tx("Autorisation des mises (une seule fois)", () => state.usdc.approve(APP_CONFIG.arena, ethers.MaxUint256));
}

// ------------------------------------------------------------------ session de jeu
// Une seule confirmation à la connexion : votre wallet autorise une clé jetable, créée et gardée
// dans ce navigateur, pour une durée limitée (7 jours par défaut) et un budget de mises plafonné.
// La même transaction envoie à la clé un tout petit peu d'ETH pour payer ses frais. Ensuite, la
// clé publie et relève les défis et joue vos coups : plus aucune fenêtre MetaMask.
// La clé ne peut envoyer de l'argent que dans des parties : les mises sont prises sur votre
// wallet, les gains et remboursements reviennent toujours sur votre wallet. Elle ne peut ni
// retirer, ni dépasser le budget, ni prolonger la session.

const SESSION_GAS = ethers.parseEther(String(APP_CONFIG.sessionGas || (CHAIN_ID === 31337 ? "0.05" : "0.0005")));
const SESSION_PREFS = "arene-session-reglages";
const sessionStoreKey = () => `arene-session:${APP_CONFIG.arena}:${state.account}`.toLowerCase();

let sessionSupport = null;
async function sessionSupported() {
  if (sessionSupport === null && state.readArena) {
    // Les contrats déployés avant cette version n'ont pas de sessions de jeu (l'appel est rejeté).
    // Une simple erreur réseau ne doit pas désactiver les sessions : on réessaiera.
    try {
      await state.readArena.sessions(ZERO);
      sessionSupport = true;
    } catch (e) {
      if (e?.code === "CALL_EXCEPTION" || e?.code === "BAD_DATA") sessionSupport = false;
      return false;
    }
  }
  return sessionSupport === true;
}

function sessionWallet() {
  if (!state.account || !APP_CONFIG.rpc) return null;
  let pk = localStorage.getItem(sessionStoreKey());
  if (!pk) {
    pk = ethers.Wallet.createRandom().privateKey;
    localStorage.setItem(sessionStoreKey(), pk);
  }
  state.rpc ||= new ethers.JsonRpcProvider(APP_CONFIG.rpc, APP_CONFIG.chainId, { staticNetwork: true });
  return new ethers.Wallet(pk, state.rpc);
}

// Lit la session du compte : { on, canStake, budget, expiresAt, gasOk }.
// Lecture via le nœud du wallet (plus fiable), sinon via le nœud public.
const readVia = (fn) => fn(state.provider || state.rpc).catch(() => fn(state.rpc));

async function loadSession() {
  if (!state.account || !(await sessionSupported())) return;
  const w = sessionWallet();
  if (!w) return;
  const account = state.account;
  const prev = state.session;
  // En cas d'erreur de lecture, on garde l'état précédent au lieu de repasser par MetaMask.
  const [s, bal, gasPrice] = await Promise.all([
    state.readArena.sessions(account),
    readVia((p) => p.getBalance(w.address)).catch(() => null),
    readVia((p) => p.send ? p.send("eth_gasPrice", []).then(BigInt) : p.getFeeData().then((f) => f.gasPrice)).catch(() => null),
  ]);
  if (!same(account, state.account)) return;
  const on = same(s.key, w.address);
  const expiresAt = Number(s.expiresAt);
  // De quoi payer la transaction la plus chère (révélation de la Bataille navale), avec marge.
  const gasOk = bal === null ? (prev?.gasOk ?? true) : gasPrice === null ? bal > 0n : bal >= gasPrice * 2n * 400000n;
  state.session = {
    on,
    expiresAt,
    budget: on ? s.budget : 0n,
    canStake: on && expiresAt > nowSec(),
    gasOk,
    gas: bal ?? prev?.gas ?? 0n,
  };
}

// Pourquoi une action repasse par MetaMask (affiché pour comprendre).
function sessionWhyNot(stake = 0n) {
  const s = state.session;
  if (!sessionSupport) return "";
  if (!s || !s.on) return "Le jeu sans confirmation n'est pas activé sur ce navigateur : cliquez « Activer » dans la carte ⚡ en haut de la page.";
  if (!s.gasOk) return "La session n'a plus d'ETH pour payer les frais : renouvelez-la (carte ⚡).";
  if (stake > 0n && !s.canStake) return "La session est terminée : renouvelez-la (carte ⚡).";
  if (stake > 0n && s.budget < BigInt(stake)) return `Budget de session insuffisant (${fmt(s.budget)} USDC restants) : renouvelez-la (carte ⚡).`;
  if (stake > 0n && (state.allowance ?? 0n) < BigInt(stake)) return "L'autorisation du jeton manque : renouvelez la session (carte ⚡).";
  return "";
}

// La clé peut-elle agir maintenant ? (stake = mise à engager, 0 pour un coup)
function sessionReady(stake = 0n) {
  const s = state.session;
  if (!s || !s.on || !s.gasOk) return false;
  if (stake > 0n) return s.canStake && s.budget >= BigInt(stake) && (state.allowance ?? 0n) >= BigInt(stake);
  return true;
}

function sessionPrefs() {
  const p = JSON.parse(localStorage.getItem(SESSION_PREFS) || "null") || {};
  return { budget: p.budget || "100", days: p.days || 7 };
}

// Ouvre (ou renouvelle) la session : la seule confirmation demandée.
// La toute première fois, MetaMask demande aussi l'autorisation du jeton (une seule fois par compte).
async function activateSession() {
  if (!state.account || !(await sessionSupported())) return;
  const budgetTxt = $("sessionBudget")?.value || sessionPrefs().budget;
  const days = Number($("sessionDays")?.value || sessionPrefs().days);
  let budget;
  try { budget = ethers.parseUnits(budgetTxt, DECIMALS); } catch { return notify("Budget invalide.", true); }
  localStorage.setItem(SESSION_PREFS, JSON.stringify({ budget: budgetTxt, days }));
  const allowance = await state.usdc.allowance(state.account, APP_CONFIG.arena);
  if (allowance < budget) {
    notify("Première fois : MetaMask demande d'autoriser le contrat à prendre vos mises. Ensuite, une seule confirmation à la connexion.");
    await tx("Autorisation des mises (une seule fois)", () => state.usdc.approve(APP_CONFIG.arena, ethers.MaxUint256));
  }
  const w = sessionWallet();
  const bal = await state.rpc.getBalance(w.address).catch(() => 0n);
  let value = bal >= SESSION_GAS / 2n ? 0n : SESSION_GAS - bal;
  if (state.eth !== null && state.eth < value * 2n) value = 0n; // pas assez d'ETH : la clé ne pourra pas agir
  await tx("Activation du jeu sans confirmation", () => state.arena.openSession(w.address, budget, days * 86400, { value }));
}

async function closeSession() {
  await tx("Fin de la session", () => state.arena.closeSession());
}

// Transaction de jeu : envoyée par la clé de session si possible (aucune fenêtre), sinon par le wallet.
async function gameTx(id, label, method, ...args) {
  if (!sessionReady()) {
    const why = sessionWhyNot();
    return tx(label + (why ? ` (${why})` : ""), () => state.arena[method](...args));
  }
  const w = sessionWallet();
  return tx(label, () => state.arena.connect(w)[method](...args), { session: true });
}

function renderSession() {
  const card = $("sessionCard");
  const s = state.session;
  if (!card) return;
  const show = !!state.account && sessionSupport === true && s && !sessionReady(1n);
  card.hidden = !show;
  const info = $("sessionInfo");
  if (state.account && s && s.on && s.canStake) {
    const until = new Date(s.expiresAt * 1000).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
    info.textContent = `⚡ Sans confirmation · budget ${fmt(s.budget)} USDC · jusqu'au ${until}`;
    info.title = "Cliquez pour arrêter le jeu sans confirmation sur ce compte";
  } else {
    info.textContent = "";
  }
  if (!show) return;
  let why = "Une seule confirmation dans MetaMask, puis vous publiez, relevez des défis et jouez sans aucune autre fenêtre.";
  if (s.on && !s.canStake) why = "Votre session est terminée. Renouvelez-la (une confirmation) pour continuer à jouer sans MetaMask.";
  else if (s.on && s.budget < 10_000n) why = "Le budget de votre session est épuisé. Renouvelez-la (une confirmation).";
  else if (s.on && !s.gasOk) why = "Votre session n'a plus d'ETH pour payer les frais. Renouvelez-la (une confirmation).";
  $("sessionWhy").textContent = why;
  const p = sessionPrefs();
  if (document.activeElement !== $("sessionBudget")) $("sessionBudget").value = p.budget;
  $("sessionDays").value = String(p.days);
}

// ------------------------------------------------------------------ actions

async function createMatch() {
  if (!state.account) return notify("Connectez d'abord votre wallet.", true);
  const game = Number($("gameSelect").value);
  const raw = $("stakeInput").value;
  let stake;
  try { stake = ethers.parseUnits(raw, DECIMALS); } catch { return notify("Mise invalide.", true); }
  if (stake <= 0n) return notify("La mise doit être positive.", true);
  if (state.usdcBal !== null && stake > state.usdcBal) return notify(`Solde insuffisant : vous avez ${fmt(state.usdcBal)} USDC.`, true);
  const before = Number(await state.readArena.matchCount());
  if (sessionReady(stake)) {
    await tx("Publication de l'annonce", () => state.arena.connect(sessionWallet()).createMatchAsSession(game, stake), { session: true });
  } else {
    const why = sessionWhyNot(stake);
    await ensureAllowance(stake);
    await tx("Publication de l'annonce" + (why ? ` (${why})` : ""), () => state.arena.createMatch(game, stake));
  }
  // Propose tout de suite le lien à envoyer à un ami.
  const mine = state.matches.find((m) => m.id > before && same(m.creator, state.account) && Number(m.status) === 0);
  if (mine) notify(`Annonce n° ${mine.id} publiée ✔ Envoyez le lien d'invitation à un ami avec le bouton « Copier le lien ».`);
}

async function joinMatch(id, stake) {
  if (!state.account) return connect({ pick: true }).catch((e) => notify(errMsg(e), true));
  if (state.usdcBal !== null && BigInt(stake) > state.usdcBal) return notify(`Solde insuffisant : il faut ${fmt(stake)} USDC, vous en avez ${fmt(state.usdcBal)}.`, true);
  if (sessionReady(stake)) {
    await tx("Acceptation du défi", () => state.arena.connect(sessionWallet()).joinMatchAsSession(id), { session: true });
  } else {
    const why = sessionWhyNot(stake);
    await ensureAllowance(stake);
    await tx("Acceptation du défi" + (why ? ` (${why})` : ""), () => state.arena.joinMatch(id));
  }
  openGame(id);
}

const cancelMatch = (id) => gameTx(id, "Annulation", "cancelMatch", id);
const play = (id, pos) => gameTx(id, "Coup", "play", id, pos);
const resign = (id) => gameTx(id, "Abandon", "resign", id);
const claimTimeout = (id) => gameTx(id, "Victoire par délai", "claimTimeout", id);
const withdrawFees = () => tx("Retrait des frais", () => state.arena.withdrawFees(state.account));

function inviteLink(id) {
  const u = new URL(location.href);
  u.search = "";
  if (PARAMS.get("chain")) u.searchParams.set("chain", PARAMS.get("chain"));
  u.searchParams.set("partie", id);
  return u.toString();
}

async function copyInvite(id, btn) {
  const link = inviteLink(id);
  try {
    if (navigator.share && isMobile) await navigator.share({ title: "Défi sur Arène", url: link });
    else { await navigator.clipboard.writeText(link); btn.textContent = "Lien copié ✔"; setTimeout(() => (btn.textContent = "Copier le lien"), 2000); }
  } catch {
    prompt("Copiez ce lien et envoyez-le :", link);
  }
}

function secretKey(id, round) {
  return `pfc:${APP_CONFIG.arena}:${id}:${round}:${state.account}`.toLowerCase();
}

// Empreinte calculée dans le navigateur : le coup et le sel ne sont jamais envoyés au nœud
// RPC avant la révélation. Doit rester identique à pfcHash() du contrat.
let hashBindsContract = null;
async function localPfcHash(id, round, player, move, salt) {
  if (hashBindsContract === null) {
    // Les contrats déployés après la revue de sécurité exposent MIN_STAKE et lient l'empreinte
    // à l'adresse du contrat et au réseau ; les anciens non.
    hashBindsContract = await state.arena.MIN_STAKE().then(() => true, () => false);
  }
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const data = hashBindsContract
    ? coder.encode(["address", "uint256", "uint256", "uint8", "address", "uint8", "bytes32"],
        [await state.arena.getAddress(), CHAIN_ID, id, round, player, move, salt])
    : coder.encode(["uint256", "uint8", "address", "uint8", "bytes32"], [id, round, player, move, salt]);
  return ethers.keccak256(data);
}

async function pfcCommit(id, round, move) {
  const salt = ethers.hexlify(ethers.randomBytes(32));
  const hash = await localPfcHash(id, round, state.account, move, salt);
  // Le coup et le sel restent dans ce navigateur jusqu'à la révélation.
  localStorage.setItem(secretKey(id, round), JSON.stringify({ move, salt }));
  await gameTx(id, `Coup caché (${PFC_NAMES[move]})`, "commitPfc", id, hash);
}

async function pfcReveal(id, round) {
  const saved = JSON.parse(localStorage.getItem(secretKey(id, round)) || "null");
  if (!saved) return notify("Coup introuvable dans ce navigateur : il faut révéler depuis le navigateur qui a joué.", true);
  await gameTx(id, "Révélation", "revealPfc", id, saved.move, saved.salt);
}

// ------------------------------------------------------------------ lecture de la blockchain

async function refresh() {
  if (!state.readArena) return render();
  const account = state.account;
  const stillSame = () => (account || "").toLowerCase() === (state.account || "").toLowerCase();
  try {
    const [count, block] = await Promise.all([state.readArena.matchCount(), state.reader.getBlock("latest")]);
    state.now = Number(block.timestamp);
    state.clockOffset = state.now - Math.floor(Date.now() / 1000);
    if (account) {
      const [bal, eth, owner, fees] = await Promise.all([
        state.usdc.balanceOf(account),
        state.provider.getBalance(account),
        state.owner ? state.owner : state.readArena.owner().catch(() => ZERO),
        state.readArena.feesAccrued().catch(() => 0n),
      ]);
      const allowance = await state.usdc.allowance(account, APP_CONFIG.arena).catch(() => 0n);
      await loadSession().catch((e) => console.warn(e));
      if (!stillSame()) return; // compte changé pendant le chargement
      state.usdcBal = bal; state.eth = eth; state.owner = owner; state.fees = fees; state.allowance = allowance;
      $("balance").textContent = `${fmt(bal)} USDC · ${Number(ethers.formatEther(eth)).toFixed(4)} ETH`;
      if (eth === 0n && !state.warnedEth) {
        state.warnedEth = true;
        notify("Votre wallet n'a pas d'ETH : il en faut un tout petit peu pour payer les frais de transaction. Sur le réseau de test, il est gratuit (voir « Bien démarrer »).", true);
      }
    }
    const n = Number(count);
    const list = [];
    for (let from = 1; from <= n; from += 100) {
      const chunk = await state.readArena.getMatches(from, Math.min(100, n - from + 1));
      chunk.forEach((m, i) => list.push({ id: from + i, ...m.toObject() }));
    }
    if (!stillSame()) return; // connexion changée pendant le chargement
    trackMoves(list);
    state.matches = list;
    handleInvite();
    render();
    if (state.current) await renderGame();
  } catch (e) {
    console.error(e);
  }
}

// Repère la dernière case jouée en comparant le plateau avec celui de la lecture précédente.
function trackMoves(list) {
  for (const m of list) {
    const b = BigInt(m.board);
    const prev = state.boards[m.id];
    if (prev !== undefined && prev !== b) {
      const diff = prev ^ b;
      for (let i = 0; i < 128; i++) if ((diff >> BigInt(i * 2)) & 3n) state.lastCells[m.id] = i;
    }
    state.boards[m.id] = b;
  }
}

// Lien d'invitation (?partie=12) : met l'annonce en avant, ou ouvre la partie si on y joue.
function handleInvite() {
  if (!state.invite) return;
  const m = state.matches.find((x) => x.id === state.invite);
  if (!m) return;
  const st = Number(m.status);
  if (st === 0 && !same(m.creator, state.account)) {
    notify(`Vous êtes invité à un défi : ${gameName(m.game)}, ${fmt(m.stake)} USDC chacun. ${state.account ? "Cliquez « Relever le défi »." : "Connectez votre wallet pour l'accepter."}`);
    state.filter = "all";
    setTimeout(() => document.querySelector(`[data-match="${m.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
    state.highlight = m.id;
  } else if (state.account && (same(m.creator, state.account) || same(m.opponent, state.account)) && st !== 3) {
    openGame(m.id);
  } else if (st !== 0) {
    notify(`Le défi n° ${m.id} n'est plus disponible (${STATUS[st].toLowerCase()}).`);
  }
  state.invite = null;
}

// ------------------------------------------------------------------ affichage

// Résultat d'une partie terminée pour le joueur connecté : gain net en USDC.
function outcome(m) {
  const st = Number(m.status);
  if (st === 3) return { label: "Annulée", cls: "", gain: 0n };
  if (st !== 2) return null;
  if (m.winner === ZERO) return { label: "Match nul", cls: "", gain: 0n, draw: true };
  if (same(m.winner, state.account)) return { label: "Gagnée", cls: "win", gain: netPrize(m.stake) - BigInt(m.stake), win: true };
  return { label: "Perdue", cls: "lose", gain: -BigInt(m.stake), loss: true };
}

function render() {
  renderGuide();
  renderSession();
  renderCreate();
  renderFilter();
  renderLists();
  renderStats();
  renderOwner();
  renderFooter();
}

function renderGuide() {
  const connected = !!state.account;
  const hasEth = state.eth !== null && state.eth > 0n;
  const hasUsdc = state.usdcBal !== null && state.usdcBal > 0n;
  const dismissed = localStorage.getItem("arene-guide-masque") === "1";
  $("guideCard").hidden = dismissed || (connected && hasEth && hasUsdc);
  $("step1").classList.toggle("done", connected);
  $("step2").classList.toggle("done", connected && hasEth);
  $("step3").classList.toggle("done", connected && hasUsdc);

  const s1 = $("step1Txt");
  if (connected) s1.textContent = `Compte ${short(state.account)} connecté.`;
  else if (window.ethereum) s1.innerHTML = "Cliquez « Connecter le wallet » en haut de la page.";
  else if (isMobile) s1.innerHTML = `Sur téléphone, ouvrez ce site dans l'application MetaMask : <a href="${metamaskDeepLink()}">ouvrir dans MetaMask</a>.`;
  else s1.innerHTML = 'Installez l\'extension <a href="https://metamask.io/download/" target="_blank" rel="noopener">MetaMask</a>, créez un compte, puis rechargez cette page.';

  const s2 = $("step2Txt");
  if (IS_LOCAL || CHAIN_ID === 31337) s2.textContent = "Sur la blockchain locale, les comptes de test ont déjà de l'ETH.";
  else s2.innerHTML = `L'ETH sert à payer les frais de transaction (quelques centimes). Gratuit sur le réseau de test : <a href="${ETH_FAUCET}" target="_blank" rel="noopener">robinet Coinbase</a>, choisissez « Base Sepolia » et collez votre adresse${connected ? ` (<a href="#" id="copyAddr">copier mon adresse</a>)` : ""}.`;
  const ca = $("copyAddr");
  if (ca) ca.onclick = (e) => { e.preventDefault(); navigator.clipboard?.writeText(state.account); ca.textContent = "adresse copiée ✔"; };

  const s3 = $("step3Txt");
  if (APP_CONFIG.mockUsdc) {
    s3.innerHTML = "Ce sont de faux USDC, sans valeur, pour essayer.";
    if (connected && !hasUsdc) {
      const b = button("Recevoir 1 000 USDC de test", () => $("faucetBtn").click());
      b.disabled = !hasEth;
      if (!hasEth) b.title = "Il faut d'abord un peu d'ETH de test";
      s3.appendChild(document.createElement("br"));
      s3.appendChild(b);
    }
  } else s3.textContent = "Il faut des USDC sur ce réseau pour miser.";
}

function renderCreate() {
  const g = Number($("gameSelect").value);
  $("gameRules").textContent = GAME_INFO[g]?.rules || "";
  let stake = 0n;
  try { stake = ethers.parseUnits($("stakeInput").value || "0", DECIMALS); } catch { /* saisie en cours */ }
  $("stakeHint").innerHTML = stake > 0n
    ? `Si vous gagnez, vous recevez <strong>${fmt(netPrize(stake))} USDC</strong> (les deux mises moins 2 % de frais), soit <span class="gain pos">${signed(netPrize(stake) - stake)} USDC</span> de gain. Match nul : chacun récupère sa mise.`
    : "Le gagnant reçoit les deux mises moins 2 % de frais. Match nul : chacun récupère sa mise.";
}

function renderFilter() {
  const wrap = $("gameFilter");
  const open = state.matches.filter((m) => Number(m.status) === 0);
  const games = [...new Set(open.map((m) => Number(m.game)))].sort();
  if (state.filter !== "all" && !games.includes(state.filter)) state.filter = "all";
  wrap.innerHTML = "";
  if (games.length < 2) return;
  const chip = (label, value) => {
    const b = button(label, () => { state.filter = value; render(); }, "chip" + (state.filter === value ? " on" : ""));
    wrap.appendChild(b);
  };
  chip(`Tous (${open.length})`, "all");
  for (const g of games) chip(`${gameIcon(g)} ${gameName(g)}`, g);
}

function renderLists() {
  const connected = !!state.account;
  const open = state.matches.filter((m) => Number(m.status) === 0 && (state.filter === "all" || Number(m.game) === state.filter)).reverse();
  // Mes annonces en premier dans la liste des annonces.
  open.sort((a, b) => (same(b.creator, state.account) ? 1 : 0) - (same(a.creator, state.account) ? 1 : 0));
  const mine = state.matches.filter((m) => connected && (same(m.creator, state.account) || same(m.opponent, state.account)));
  const active = mine.filter((m) => Number(m.status) === 1).reverse();
  const myTurn = (m) => isMyTurn(m);
  active.sort((a, b) => (myTurn(b) ? 1 : 0) - (myTurn(a) ? 1 : 0));
  const history = mine.filter((m) => Number(m.status) >= 2).reverse();

  const openList = $("openList");
  openList.innerHTML = "";
  if (!state.readArena) openList.innerHTML = '<p class="muted small">Connectez votre wallet pour voir les annonces.</p>';
  else if (!open.length) openList.innerHTML = '<p class="muted small">Aucune annonce pour le moment. Publiez la vôtre !</p>';
  for (const m of open) {
    const own = same(m.creator, state.account);
    const el = document.createElement("div");
    el.className = "item" + (own ? " mine" : "") + (state.highlight === m.id ? " highlight" : "");
    el.dataset.match = m.id;
    el.innerHTML = `<span class="icon">${gameIcon(m.game)}</span><div class="meta"><strong>${esc(gameName(m.game))} · ${fmt(m.stake)} USDC</strong><span class="muted small">n° ${m.id} · ${own ? "votre annonce" : "par " + short(m.creator)} · gain si victoire <span class="gain pos">${signed(netPrize(m.stake) - BigInt(m.stake))} USDC</span></span></div>`;
    const side = document.createElement("div");
    side.className = "side";
    if (own) {
      const share = button("Copier le lien", () => copyInvite(m.id, share), "ghost");
      side.appendChild(share);
      side.appendChild(button("Annuler", () => cancelMatch(m.id).catch(() => {}), "ghost"));
    } else {
      side.appendChild(button(connected ? "Relever le défi" : "Se connecter pour jouer", () => joinMatch(m.id, m.stake).catch(() => {})));
    }
    el.appendChild(side);
    openList.appendChild(el);
  }

  $("activeCard").hidden = !connected || !active.length;
  const myList = $("myList");
  myList.innerHTML = "";
  for (const m of active) {
    const turn = myTurn(m);
    const vs = same(m.creator, state.account) ? m.opponent : m.creator;
    const el = document.createElement("div");
    el.className = "item" + (turn ? " yourturn" : "");
    el.innerHTML = `<span class="icon">${gameIcon(m.game)}</span><div class="meta"><strong>${esc(gameName(m.game))} · ${fmt(m.stake)} USDC</strong><span class="muted small">n° ${m.id} · contre ${short(vs)} · <span data-deadline="${deadlineOf(m)}"></span></span></div>`;
    const side = document.createElement("div");
    side.className = "side";
    const tag = document.createElement("span");
    tag.className = "tag" + (turn ? " turn" : "");
    tag.textContent = turn ? "À vous de jouer" : "Tour de l'adversaire";
    side.appendChild(tag);
    side.appendChild(button(turn ? "Jouer" : "Voir", () => openGame(m.id), turn ? "" : "ghost"));
    el.appendChild(side);
    myList.appendChild(el);
  }

  $("historyCard").hidden = !connected || !history.length;
  const hist = $("historyList");
  hist.innerHTML = "";
  for (const m of history.slice(0, state.historyShown)) {
    const o = outcome(m);
    const vs = same(m.creator, state.account) ? m.opponent : m.creator;
    const el = document.createElement("div");
    el.className = "item";
    const gain = o.gain === 0n ? '<span class="gain">0 USDC</span>' : `<span class="gain ${o.gain > 0n ? "pos" : "neg"}">${signed(o.gain)} USDC</span>`;
    el.innerHTML = `<span class="icon">${gameIcon(m.game)}</span><div class="meta"><strong>${esc(gameName(m.game))} · ${fmt(m.stake)} USDC</strong><span class="muted small">n° ${m.id} · ${vs === ZERO ? "sans adversaire" : "contre " + short(vs)}</span></div>`;
    const side = document.createElement("div");
    side.className = "side";
    side.innerHTML = `<span class="tag ${o.cls}">${o.label}</span>${gain}`;
    if (Number(m.status) === 2) side.appendChild(button("Revoir", () => openGame(m.id), "ghost"));
    el.appendChild(side);
    hist.appendChild(el);
  }
  $("historyMore").classList.toggle("hidden", history.length <= state.historyShown);

  // Bandeau et titre de l'onglet quand c'est à vous de jouer.
  const turns = active.filter(myTurn);
  const banner = $("turnBanner");
  banner.classList.toggle("hidden", !turns.length);
  if (turns.length) {
    banner.innerHTML = `<span>🎯 <strong>C'est à vous de jouer</strong> dans ${turns.length > 1 ? turns.length + " parties" : "une partie"}.</span>`;
    if (!(state.current && turns.some((m) => m.id === state.current))) banner.appendChild(button("Y aller", () => openGame(turns[0].id)));
  }
  document.title = (turns.length ? `(${turns.length}) À vous de jouer · ` : "") + "Arène — mini-jeux avec mises";
}

function renderStats() {
  const connected = !!state.account;
  const done = state.matches.filter((m) => connected && Number(m.status) === 2 && (same(m.creator, state.account) || same(m.opponent, state.account)));
  $("statsCard").hidden = !done.length;
  if (!done.length) return;
  let w = 0, d = 0, l = 0, net = 0n;
  for (const m of done) { const o = outcome(m); if (o.win) w++; else if (o.draw) d++; else l++; net += o.gain; }
  $("stPlayed").textContent = done.length;
  $("stRecord").textContent = `${w} / ${d} / ${l}`;
  $("stRate").textContent = w + l ? Math.round((w / (w + l)) * 100) + " %" : "—";
  const el = $("stNet");
  el.textContent = signed(net);
  el.className = "stat-val gain " + (net > 0n ? "pos" : net < 0n ? "neg" : "");
}

function renderOwner() {
  const isOwner = !!state.account && same(state.owner, state.account);
  $("ownerCard").hidden = !isOwner;
  if (!isOwner) return;
  const finished = state.matches.filter((m) => Number(m.status) === 2);
  let total = 0n, volume = 0n;
  for (const m of state.matches) if (Number(m.status) === 1 || Number(m.status) === 2) volume += BigInt(m.stake) * 2n;
  for (const m of finished) if (m.winner !== ZERO) total += (BigInt(m.stake) * 2n * FEE_BPS) / 10000n;
  $("ownFees").textContent = fmt(state.fees);
  $("ownTotal").textContent = fmt(total);
  $("ownGames").textContent = finished.length;
  $("ownVolume").textContent = fmt(volume);
  $("withdrawBtn").disabled = state.fees === 0n;
}

function renderFooter() {
  const played = state.matches.filter((m) => Number(m.status) === 1 || Number(m.status) === 2).length;
  const parts = [`Contrat ${APP_CONFIG.arena ? addrLink(APP_CONFIG.arena) : "non déployé"}`, `réseau ${esc(APP_CONFIG.network || "?")}`, "frais plateforme 2 %"];
  if (state.matches.length) parts.push(`${played} partie${played > 1 ? "s" : ""} jouée${played > 1 ? "s" : ""}`);
  $("footer").innerHTML = parts.join(" · ");
}

function isMyTurn(m) {
  if (Number(m.status) !== 1 || !state.account) return false;
  if (Number(m.game) === 3) return false; // Duel de dés : les deux joueurs agissent en même temps
  if (Number(m.game) !== 0) return same(m.turn, state.account);
  // Pierre-Feuille-Ciseaux : à vous si vous n'avez pas encore joué (ou révélé) cette manche.
  const s = state.pfcCache?.[m.id];
  if (!s) return false;
  const me = same(m.creator, state.account) ? 1 : 2;
  const myCommit = me === 1 ? s.commitCreator : s.commitOpponent;
  const theirCommit = me === 1 ? s.commitOpponent : s.commitCreator;
  const myReveal = Number(me === 1 ? s.revealCreator : s.revealOpponent);
  return myCommit === ethers.ZeroHash || (theirCommit !== ethers.ZeroHash && myReveal === 0);
}

const deadlineOf = (m) => Number(m.lastActionAt) + Number(APP_CONFIG.moveTimeout || 600);

function countdownText(deadline) {
  const r = deadline - nowSec();
  if (r <= 0) return "délai dépassé";
  const min = Math.floor(r / 60), s = r % 60;
  return `${min} min ${String(s).padStart(2, "0")} s restantes`;
}

// Met à jour les comptes à rebours chaque seconde, sans attendre la prochaine lecture.
function tickClocks() {
  for (const el of document.querySelectorAll("[data-deadline]")) el.textContent = countdownText(Number(el.dataset.deadline));
}

// État Pierre-Feuille-Ciseaux des parties en cours (pour savoir à qui c'est le tour).
async function loadPfcStates() {
  if (!state.account || !state.readArena) return;
  const ids = state.matches.filter((m) => Number(m.status) === 1 && Number(m.game) === 0 && (same(m.creator, state.account) || same(m.opponent, state.account))).map((m) => m.id);
  const res = await Promise.all(ids.map((id) => state.readArena.pfc(id).then((s) => [id, s.toObject()]).catch(() => null)));
  state.pfcCache = Object.fromEntries(res.filter(Boolean));
}

function openGame(id) {
  state.current = Number(id);
  $("gameCard").hidden = false;
  renderGame();
  renderLists();
  $("gameCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

function cellOf(board, i) {
  return Number((BigInt(board) >> BigInt(i * 2)) & 3n);
}

// Cases de l'alignement gagnant (pour les surligner en fin de partie).
function winningCells(game, board, mark) {
  if (game === 1) {
    const L = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
    for (const l of L) if (l.every((i) => cellOf(board, i) === mark)) return l;
  } else if (game === 2) {
    const at = (r, c) => (r >= 0 && r < 6 && c >= 0 && c < 7 ? cellOf(board, r * 7 + c) : -1);
    for (let r = 0; r < 6; r++) for (let c = 0; c < 7; c++) {
      for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
        const cells = [0, 1, 2, 3].map((k) => [r + dr * k, c + dc * k]);
        if (cells.every(([rr, cc]) => at(rr, cc) === mark)) return cells.map(([rr, cc]) => rr * 7 + cc);
      }
    }
  }
  return [];
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
  $("gameTitle").textContent = `${gameIcon(game)} ${gameName(game)} n° ${m.id} · ${fmt(m.stake)} USDC chacun`;
  const vs = me === 1 ? m.opponent : m.creator;
  $("gameVs").innerHTML = vs && vs !== ZERO ? `Adversaire : ${addrLink(vs)} · pot ${fmt(BigInt(m.stake) * 2n)} USDC, le gagnant reçoit ${fmt(netPrize(m.stake))} USDC` : "";
  const board = $("gameBoard");
  const actions = $("gameActions");
  board.innerHTML = "";
  actions.innerHTML = "";
  const deadline = deadlineOf(m);
  const late = nowSec() > deadline;
  const clock = `<span data-deadline="${deadline}">${countdownText(deadline)}</span>`;

  let status = "";
  if (st === 2) {
    const net = netPrize(m.stake);
    status = m.winner === ZERO ? "Match nul : les mises ont été remboursées."
      : same(m.winner, state.account) ? `🏆 Victoire ! Vous avez reçu ${fmt(net)} USDC.` : `Défaite. ${short(m.winner)} a remporté ${fmt(net)} USDC.`;
  } else if (st === 0) status = "En attente d'un adversaire.";

  if (game >= 3) {
    // Duel de dés et Bataille navale : voir games-extra.js
    status = (await renderExtraGame(m, { game, st, me, late, mm: clock, board, actions })) || status;
  } else if (game === 0) {
    const s = (await state.readArena.pfc(m.id)).toObject();
    if (state.current !== m.id) return;
    board.innerHTML = "";
    const round = Number(m.moves);
    const myCommit = me === 1 ? s.commitCreator : s.commitOpponent;
    const theirCommit = me === 1 ? s.commitOpponent : s.commitCreator;
    const myReveal = Number(me === 1 ? s.revealCreator : s.revealOpponent);
    const theirReveal = Number(me === 1 ? s.revealOpponent : s.revealCreator);
    const empty = ethers.ZeroHash;
    if (st === 1) {
      const roundTxt = round > 0 ? `Manche ${round + 1} (égalité${round > 1 ? "s" : ""} avant). ` : "";
      if (myCommit === empty) {
        status = roundTxt + `Choisissez votre coup. Il reste caché tant que les deux joueurs n'ont pas joué. Temps : ${clock}.`;
        const wrap = document.createElement("div");
        wrap.className = "pfc";
        for (const mv of [1, 2, 3]) {
          const b = button("", () => pfcCommit(m.id, round, mv).catch(() => {}));
          b.innerHTML = `${PFC_MOVES[mv]}<span>${PFC_NAMES[mv]}</span>`;
          b.title = PFC_NAMES[mv];
          wrap.appendChild(b);
        }
        board.appendChild(wrap);
      } else if (theirCommit === empty) {
        status = roundTxt + `Coup envoyé. En attente de l'adversaire (${clock}).`;
      } else if (myReveal === 0) {
        const saved = JSON.parse(localStorage.getItem(secretKey(m.id, round)) || "null");
        status = roundTxt + `Les deux coups sont joués. Révélez le vôtre${saved ? ` (${PFC_NAMES[saved.move]})` : ""} pour connaître le résultat (${clock}).`;
        actions.appendChild(button("Révéler mon coup", () => pfcReveal(m.id, round).catch(() => {})));
      } else {
        status = roundTxt + `Vous avez révélé ${PFC_NAMES[myReveal]}. En attente de la révélation adverse (${clock}).`;
      }
      const iActed = myCommit !== empty && (theirCommit === empty || myReveal !== 0);
      const theyActed = theirCommit !== empty && (myCommit === empty || theirReveal !== 0);
      if (late && iActed && !theyActed) actions.appendChild(button("Réclamer la victoire (adversaire inactif)", () => claimTimeout(m.id).catch(() => {})));
    } else if (st === 2 && myReveal && theirReveal) {
      const res = document.createElement("div");
      res.className = "pfc-result";
      res.innerHTML = `<div><span class="mv">${PFC_MOVES[myReveal]}</span>Vous : ${PFC_NAMES[myReveal]}</div><strong>contre</strong><div><span class="mv">${PFC_MOVES[theirReveal]}</span>Adversaire : ${PFC_NAMES[theirReveal]}</div>`;
      board.appendChild(res);
    }
  } else if (game === 1 || game === 2) {
    const p4 = game === 2;
    const grid = document.createElement("div");
    grid.className = "board " + (p4 ? "p4" : "morpion");
    const rows = p4 ? 6 : 3, cols = p4 ? 7 : 3;
    const winMark = st === 2 && m.winner !== ZERO ? (same(m.winner, m.creator) ? 1 : 2) : 0;
    const win = winMark ? winningCells(game, m.board, winMark) : [];
    const last = state.lastCells[m.id];
    for (let r = rows - 1; r >= 0; r--) {
      for (let c = 0; c < cols; c++) {
        const idx = p4 ? r * 7 + c : (rows - 1 - r) * 3 + c;
        const v = cellOf(m.board, idx);
        const cell = document.createElement("div");
        cell.className = `cell ${v === 1 ? "p1" : v === 2 ? "p2" : ""}${win.includes(idx) ? " winline" : ""}${idx === last && v ? " last" : ""}`;
        if (!p4) cell.textContent = v === 1 ? "O" : v === 2 ? "X" : "";
        const pos = p4 ? c : idx;
        if (myTurn && (p4 || v === 0)) cell.onclick = () => play(m.id, pos).catch(() => {});
        else cell.classList.add("disabled");
        cell.dataset.pos = pos;
        grid.appendChild(cell);
      }
    }
    board.appendChild(grid);
    if (st === 1) {
      const mine = p4 ? (me === 1 ? "rouge" : "jaune") : (me === 1 ? "O" : "X");
      status = myTurn ? `À vous de jouer (vous êtes ${mine}). ${p4 ? "Touchez une colonne. " : ""}Temps : ${clock}.` : `Tour de l'adversaire (vous êtes ${mine}). Délai : ${clock}.`;
      if (!myTurn && late) actions.appendChild(button("Réclamer la victoire (adversaire inactif)", () => claimTimeout(m.id).catch(() => {})));
    }
  }
  if (st === 1 && me) actions.appendChild(button("Abandonner", () => { if (confirm("Abandonner ? L'adversaire remporte le pot.")) resign(m.id).catch(() => {}); }, "danger"));
  if ((st === 0 || st === 1) && me && sessionReady()) status += ' <span class="muted small">⚡ Vos coups partent sans confirmation du wallet.</span>';
  $("gameStatus").innerHTML = status;
}

// ------------------------------------------------------------------ démarrage

$("connectBtn").onclick = () => connect({ pick: true }).catch((e) => notify(errMsg(e), true));
$("switchBtn").onclick = () => connect({ pick: true }).catch((e) => notify(errMsg(e), true));
$("disconnectBtn").onclick = () => disconnect();
$("createBtn").onclick = () => createMatch().catch(() => {});
$("closeGame").onclick = () => { state.current = null; $("gameCard").hidden = true; renderLists(); };
$("faucetBtn").onclick = () => {
  const amount = ethers.parseUnits("1000", DECIMALS);
  // Avec une session active, la clé distribue les jetons de test au joueur sans fenêtre MetaMask.
  const viaSession = sessionReady() && state.usdc.interface.getFunction("faucetTo");
  const send = viaSession
    ? tx("Jetons de test", () => state.usdc.connect(sessionWallet()).faucetTo(state.account, amount), { session: true })
    : tx("Jetons de test", () => state.usdc.faucet(amount));
  send.catch(() => {});
};
$("sessionBtn").onclick = () => activateSession().catch(() => {});
$("sessionInfo").onclick = () => { if (confirm("Arrêter le jeu sans confirmation sur ce compte ? (une confirmation MetaMask)")) closeSession().catch(() => {}); };
$("withdrawBtn").onclick = () => withdrawFees().catch(() => {});
$("historyMore").onclick = () => { state.historyShown += HISTORY_PAGE; renderLists(); };
$("guideClose").onclick = () => { localStorage.setItem("arene-guide-masque", "1"); renderGuide(); };
$("gameSelect").onchange = renderCreate;
$("stakeInput").oninput = renderCreate;

// Lecture régulière : toutes les 3 s avec un wallet, toutes les 10 s sans (nœud public).
let lastRead = 0;
setInterval(async () => {
  tickClocks();
  const every = state.account ? 3000 : 10000;
  if (state.busy || Date.now() - lastRead < every) return;
  lastRead = Date.now();
  await loadPfcStates().catch(() => {});
  refresh();
}, 1000);

useReadOnly();
render();
if (!localStorage.getItem(DISCONNECTED_KEY) && window.ethereum) connect().catch(() => refresh());
else refresh();
