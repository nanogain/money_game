// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title MiniJeuxArena
/// @notice Mini-jeux à deux joueurs avec mise en USDC. Toute la logique des jeux est
///         dans le contrat : aucun oracle ni serveur ne décide du vainqueur.
///         Jeux : Pierre-Feuille-Ciseaux (coups cachés puis révélés), Morpion, Puissance 4.
contract MiniJeuxArena is ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    enum GameType { PierreFeuilleCiseaux, Morpion, Puissance4, DuelDeDes, BatailleNavale }
    enum Status { Open, Active, Finished, Cancelled }

    struct Match {
        GameType game;
        Status status;
        address creator;   // joueur 1
        address opponent;  // joueur 2
        uint256 stake;     // mise de CHAQUE joueur
        address turn;      // jeux de plateau : à qui de jouer
        uint64 lastActionAt;
        uint8 moves;       // nombre de coups joués (plateau) / manche (PFC)
        uint256 board;     // plateau, 2 bits par case : 0 vide, 1 joueur 1, 2 joueur 2
        address winner;    // address(0) + Finished = match nul (remboursé)
    }

    // Pierre-Feuille-Ciseaux : 1 = pierre, 2 = feuille, 3 = ciseaux
    struct PfcState {
        bytes32 commitCreator;
        bytes32 commitOpponent;
        uint8 revealCreator;
        uint8 revealOpponent;
    }

    // Duel de dés : chaque joueur engage un secret aléatoire, puis le révèle.
    // Les dés sont tirés de la combinaison des deux secrets : aucun joueur ne peut choisir le résultat.
    struct DiceState {
        bytes32 commitCreator;
        bytes32 commitOpponent;
        bytes32 secretCreator;
        bytes32 secretOpponent;
        bool revealedCreator;
        bool revealedOpponent;
        uint8 lastDieCreator;  // dernier lancer (affichage)
        uint8 lastDieOpponent;
    }

    // Bataille navale sur 8x8 (cases 0-63 = ligne*8 + colonne), flotte : 4, 3, 3, 2 cases.
    // Chaque joueur engage l'empreinte de son plateau, annonce « touché / raté » à chaque tir,
    // puis révèle son plateau à la fin : le contrat vérifie la flotte et toutes ses annonces.
    struct NavalState {
        bytes32 commitCreator;
        bytes32 commitOpponent;
        uint64 shotsByCreator;  // cases visées par le créateur (sur le plateau adverse)
        uint64 hitsByCreator;   // parmi elles, celles annoncées « touché » par l'adversaire
        uint64 shotsByOpponent;
        uint64 hitsByOpponent;
        uint8 phase;            // 0 placement, 1 combat, 2 révélation
        uint8 pendingCell;      // dernier tir en attente de réponse
        bool hasPending;
        uint8 revealCreator;    // 0 pas encore, 1 honnête, 2 tricheur
        uint8 revealOpponent;
    }

    uint8 public constant NAVAL_SHIP_CELLS = 12; // 4 + 3 + 3 + 2

    uint256 public constant FEE_BPS = 200; // 2 %
    uint256 public constant BPS = 10_000;
    /// @dev Mise minimale par joueur (0,01 USDC à 6 décimales). En dessous, les 2 % de frais
    ///      seraient arrondis à zéro.
    uint256 public constant MIN_STAKE = 10_000;
    /// @dev Au-delà de ce nombre de manches nulles au Pierre-Feuille-Ciseaux, match nul et
    ///      remboursement (le compteur de manches tient sur 8 bits).
    uint8 public constant MAX_PFC_ROUNDS = 100;

    IERC20 public immutable token;
    uint256 public immutable moveTimeout; // délai max pour jouer, en secondes

    uint256 public matchCount;
    uint256 public feesAccrued;
    mapping(uint256 => Match) public matches;
    mapping(uint256 => PfcState) public pfc;
    mapping(uint256 => DiceState) public dice;
    mapping(uint256 => NavalState) public naval;
    /// @notice Gains qui n'ont pas pu être virés automatiquement (ex. adresse bloquée par
    ///         l'émetteur du jeton). Récupérables avec withdraw().
    mapping(address => uint256) public owed;

    /// @notice Clé de session : une adresse jetable (générée et gardée dans le navigateur) que
    ///         chaque joueur autorise, pour une partie donnée, à jouer ses coups à sa place.
    ///         Les coups partent alors sans fenêtre de confirmation du wallet.
    ///         La clé ne peut QUE jouer cette partie (coups, révélations, abandon, annulation de
    ///         l'annonce) : elle ne touche jamais aux fonds, les gains vont toujours au joueur.
    struct SessionKeys {
        address creator;
        address opponent;
    }
    mapping(uint256 => SessionKeys) public sessionKeys;

    event MatchCreated(uint256 indexed id, address indexed creator, GameType game, uint256 stake);
    event MatchJoined(uint256 indexed id, address indexed opponent);
    event MatchCancelled(uint256 indexed id);
    event Moved(uint256 indexed id, address indexed player, uint8 position);
    event PfcCommitted(uint256 indexed id, address indexed player, uint8 round);
    event PfcRevealed(uint256 indexed id, address indexed player, uint8 move, uint8 round);
    event PfcRoundDraw(uint256 indexed id, uint8 round);
    event MatchFinished(uint256 indexed id, address winner, uint256 payout, uint256 fee);
    event FeesWithdrawn(address to, uint256 amount);
    event DiceCommitted(uint256 indexed id, address indexed player, uint8 round);
    event DiceRevealed(uint256 indexed id, address indexed player, uint8 round);
    event DiceRolled(uint256 indexed id, uint8 round, uint8 dieCreator, uint8 dieOpponent);
    event NavalBoardCommitted(uint256 indexed id, address indexed player);
    event NavalShot(uint256 indexed id, address indexed shooter, uint8 cell);
    event NavalAnswered(uint256 indexed id, address indexed defender, uint8 cell, bool hit);
    event NavalRevealed(uint256 indexed id, address indexed player, bool honest);
    event PaymentDeferred(address indexed to, uint256 amount);
    event Withdrawn(address indexed from, address indexed to, uint256 amount);
    event SessionKeySet(uint256 indexed id, address indexed player, address key);

    error InvalidState();
    error NotPlayer();
    error NotYourTurn();
    error InvalidMove();
    error TooEarly();
    error StakeTooLow();

    constructor(IERC20 _token, uint256 _moveTimeout) Ownable(msg.sender) {
        token = _token;
        moveTimeout = _moveTimeout;
    }

    // ------------------------------------------------------------------ annonces

    /// @notice Publier une annonce : choisit le jeu et dépose sa mise.
    function createMatch(GameType game, uint256 stake) external nonReentrant returns (uint256 id) {
        id = _create(game, stake);
    }

    /// @notice Publier une annonce et autoriser une clé de session pour cette partie, en une
    ///         seule transaction. L'ETH envoyé (facultatif) est transféré à la clé pour payer
    ///         le gaz de ses coups.
    function createMatchWithSession(GameType game, uint256 stake, address sessionKey)
        external
        payable
        nonReentrant
        returns (uint256 id)
    {
        id = _create(game, stake);
        _setSessionKey(id, msg.sender, sessionKey);
    }

    function _create(GameType game, uint256 stake) internal returns (uint256 id) {
        if (stake < MIN_STAKE) revert StakeTooLow();
        id = ++matchCount;
        Match storage m = matches[id];
        m.game = game;
        m.status = Status.Open;
        m.creator = msg.sender;
        m.stake = stake;
        m.lastActionAt = uint64(block.timestamp);
        token.safeTransferFrom(msg.sender, address(this), stake);
        emit MatchCreated(id, msg.sender, game, stake);
    }

    /// @notice Annuler sa propre annonce tant que personne ne l'a acceptée (mise remboursée).
    function cancelMatch(uint256 id) external nonReentrant {
        Match storage m = matches[id];
        if (m.status != Status.Open) revert InvalidState();
        if (_player(id) != m.creator) revert NotPlayer(); // la mise revient toujours au créateur
        m.status = Status.Cancelled;
        token.safeTransfer(m.creator, m.stake);
        emit MatchCancelled(id);
    }

    /// @notice Accepter une annonce : dépose la même mise. L'accepteur joue en premier.
    function joinMatch(uint256 id) external nonReentrant {
        _join(id);
    }

    /// @notice Accepter une annonce et autoriser une clé de session, en une seule transaction.
    function joinMatchWithSession(uint256 id, address sessionKey) external payable nonReentrant {
        _join(id);
        _setSessionKey(id, msg.sender, sessionKey);
    }

    /// @notice Autoriser (ou remplacer) sa clé de session pour une partie, par exemple après un
    ///         changement de navigateur. Seul le wallet du joueur peut le faire.
    function setSessionKey(uint256 id, address sessionKey) external payable nonReentrant {
        Match storage m = matches[id];
        if (m.status != Status.Open && m.status != Status.Active) revert InvalidState();
        if (msg.sender != m.creator && msg.sender != m.opponent) revert NotPlayer();
        _setSessionKey(id, msg.sender, sessionKey);
    }

    function _join(uint256 id) internal {
        Match storage m = matches[id];
        if (m.status != Status.Open) revert InvalidState();
        if (msg.sender == m.creator || msg.sender == sessionKeys[id].creator) revert NotPlayer();
        m.opponent = msg.sender;
        m.status = Status.Active;
        m.turn = msg.sender;
        m.lastActionAt = uint64(block.timestamp);
        token.safeTransferFrom(msg.sender, address(this), m.stake);
        emit MatchJoined(id, msg.sender);
    }

    // ------------------------------------------------------------------ clés de session

    function _setSessionKey(uint256 id, address player, address key) internal {
        Match storage m = matches[id];
        SessionKeys storage k = sessionKeys[id];
        if (key != address(0)) {
            // La clé ne doit se confondre avec aucun autre acteur de la partie.
            if (key == m.creator || key == m.opponent) revert InvalidMove();
            if (key == (player == m.creator ? k.opponent : k.creator)) revert InvalidMove();
        }
        if (player == m.creator) k.creator = key;
        else k.opponent = key;
        emit SessionKeySet(id, player, key);
        if (msg.value > 0) {
            // Petit montant d'ETH pour le gaz des coups joués par la clé.
            if (key == address(0)) revert InvalidMove();
            (bool ok, ) = key.call{value: msg.value}("");
            if (!ok) revert InvalidMove();
        }
    }

    /// @dev Joueur au nom duquel agit l'appelant : lui-même, ou le joueur qui a autorisé cette
    ///      clé de session pour cette partie. Pour un inconnu, renvoie l'appelant (les contrôles
    ///      habituels le rejettent ensuite).
    function _player(uint256 id) internal view returns (address) {
        Match storage m = matches[id];
        if (msg.sender == m.creator || msg.sender == m.opponent) return msg.sender;
        SessionKeys storage k = sessionKeys[id];
        if (msg.sender == k.creator) return m.creator;
        if (msg.sender == k.opponent) return m.opponent;
        return msg.sender;
    }

    // ------------------------------------------------------------------ jeux de plateau

    /// @notice Jouer un coup. Morpion : case 0-8. Puissance 4 : colonne 0-6.
    function play(uint256 id, uint8 position) external nonReentrant {
        address player = _player(id);
        Match storage m = matches[id];
        if (m.status != Status.Active || (m.game != GameType.Morpion && m.game != GameType.Puissance4)) revert InvalidState();
        if (player != m.turn) revert NotYourTurn();
        uint256 mark = player == m.creator ? 1 : 2;

        bool won;
        uint8 maxMoves;
        if (m.game == GameType.Morpion) {
            if (position > 8 || _cell(m.board, position) != 0) revert InvalidMove();
            m.board = _setCell(m.board, position, mark);
            won = _morpionWin(m.board, mark);
            maxMoves = 9;
        } else {
            if (position > 6) revert InvalidMove();
            uint256 idx = type(uint256).max;
            for (uint256 row = 0; row < 6; row++) {
                uint256 i = row * 7 + position;
                if (_cell(m.board, i) == 0) { idx = i; break; }
            }
            if (idx == type(uint256).max) revert InvalidMove(); // colonne pleine
            m.board = _setCell(m.board, idx, mark);
            won = _p4Win(m.board, idx, mark);
            maxMoves = 42;
        }
        m.moves += 1;
        m.lastActionAt = uint64(block.timestamp);
        emit Moved(id, player, position);

        if (won) {
            _finish(id, player);
        } else if (m.moves == maxMoves) {
            _finish(id, address(0)); // match nul
        } else {
            m.turn = player == m.creator ? m.opponent : m.creator;
        }
    }

    // ------------------------------------------------------------------ pierre-feuille-ciseaux

    /// @notice Empreinte à envoyer à commitPfc. À calculer côté navigateur, le sel reste secret.
    ///         Elle inclut l'adresse du contrat et le réseau pour ne pas être réutilisable ailleurs.
    function pfcHash(uint256 id, uint8 round, address player, uint8 move, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, id, round, player, move, salt));
    }

    /// @notice Étape 1 : chaque joueur envoie son coup caché (empreinte).
    function commitPfc(uint256 id, bytes32 commitment) external nonReentrant {
        address player = _player(id);
        Match storage m = matches[id];
        if (m.status != Status.Active || m.game != GameType.PierreFeuilleCiseaux) revert InvalidState();
        // Une empreinte nulle ne compterait pas comme un coup mais repousserait le délai :
        // un joueur pourrait bloquer la partie indéfiniment.
        if (commitment == bytes32(0)) revert InvalidMove();
        PfcState storage s = pfc[id];
        if (player == m.creator) {
            if (s.commitCreator != 0) revert InvalidState();
            s.commitCreator = commitment;
        } else if (player == m.opponent) {
            if (s.commitOpponent != 0) revert InvalidState();
            s.commitOpponent = commitment;
        } else revert NotPlayer();
        m.lastActionAt = uint64(block.timestamp);
        emit PfcCommitted(id, player, m.moves);
    }

    /// @notice Étape 2 : une fois les deux coups cachés envoyés, chacun révèle son coup et son sel.
    function revealPfc(uint256 id, uint8 move, bytes32 salt) external nonReentrant {
        address player = _player(id);
        Match storage m = matches[id];
        if (m.status != Status.Active || m.game != GameType.PierreFeuilleCiseaux) revert InvalidState();
        PfcState storage s = pfc[id];
        if (s.commitCreator == 0 || s.commitOpponent == 0) revert InvalidState();
        if (move < 1 || move > 3) revert InvalidMove();
        bytes32 h = pfcHash(id, m.moves, player, move, salt);
        if (player == m.creator) {
            if (s.revealCreator != 0 || h != s.commitCreator) revert InvalidMove();
            s.revealCreator = move;
        } else if (player == m.opponent) {
            if (s.revealOpponent != 0 || h != s.commitOpponent) revert InvalidMove();
            s.revealOpponent = move;
        } else revert NotPlayer();
        m.lastActionAt = uint64(block.timestamp);
        emit PfcRevealed(id, player, move, m.moves);

        if (s.revealCreator != 0 && s.revealOpponent != 0) {
            uint8 a = s.revealCreator;
            uint8 b = s.revealOpponent;
            if (a == b) {
                // égalité : nouvelle manche
                emit PfcRoundDraw(id, m.moves);
                delete pfc[id];
                m.moves += 1;
                if (m.moves >= MAX_PFC_ROUNDS) _finish(id, address(0));
            } else if ((a == 1 && b == 3) || (a == 2 && b == 1) || (a == 3 && b == 2)) {
                _finish(id, m.creator);
            } else {
                _finish(id, m.opponent);
            }
        }
    }

    // ------------------------------------------------------------------ duel de dés

    /// @notice Empreinte à envoyer à commitDice. Le secret (32 octets aléatoires) reste dans le navigateur.
    ///         À calculer dans le navigateur (pas par un appel au contrat) pour que le secret ne quitte pas l'appareil.
    function diceHash(uint256 id, uint8 round, address player, bytes32 secret) public view returns (bytes32) {
        return keccak256(abi.encode("des", address(this), block.chainid, id, round, player, secret));
    }

    function commitDice(uint256 id, bytes32 commitment) external nonReentrant {
        address player = _player(id);
        Match storage m = matches[id];
        if (m.status != Status.Active || m.game != GameType.DuelDeDes) revert InvalidState();
        DiceState storage d = dice[id];
        if (commitment == 0) revert InvalidMove(); // sinon on pourrait repousser le délai indéfiniment
        if (player == m.creator) {
            if (d.commitCreator != 0) revert InvalidState();
            d.commitCreator = commitment;
        } else if (player == m.opponent) {
            if (d.commitOpponent != 0) revert InvalidState();
            d.commitOpponent = commitment;
        } else revert NotPlayer();
        m.lastActionAt = uint64(block.timestamp);
        emit DiceCommitted(id, player, m.moves);
    }

    function revealDice(uint256 id, bytes32 secret) external nonReentrant {
        address player = _player(id);
        Match storage m = matches[id];
        if (m.status != Status.Active || m.game != GameType.DuelDeDes) revert InvalidState();
        DiceState storage d = dice[id];
        if (d.commitCreator == 0 || d.commitOpponent == 0) revert InvalidState();
        bytes32 h = diceHash(id, m.moves, player, secret);
        if (player == m.creator) {
            if (d.revealedCreator || h != d.commitCreator) revert InvalidMove();
            d.revealedCreator = true;
            d.secretCreator = secret;
        } else if (player == m.opponent) {
            if (d.revealedOpponent || h != d.commitOpponent) revert InvalidMove();
            d.revealedOpponent = true;
            d.secretOpponent = secret;
        } else revert NotPlayer();
        m.lastActionAt = uint64(block.timestamp);
        emit DiceRevealed(id, player, m.moves);

        if (d.revealedCreator && d.revealedOpponent) {
            uint256 r = uint256(keccak256(abi.encode(d.secretCreator, d.secretOpponent)));
            uint8 a = uint8(r % 6) + 1;
            uint8 b = uint8((r >> 128) % 6) + 1;
            uint8 round = m.moves;
            emit DiceRolled(id, round, a, b);
            if (a == b) {
                // égalité : on relance (nouvelle manche, nouveaux secrets)
                delete dice[id];
                dice[id].lastDieCreator = a;
                dice[id].lastDieOpponent = b;
                m.moves = round + 1;
            } else {
                d.lastDieCreator = a;
                d.lastDieOpponent = b;
                _finish(id, a > b ? m.creator : m.opponent);
            }
        }
    }

    function _diceTimeout(uint256 id) internal {
        Match storage m = matches[id];
        DiceState storage d = dice[id];
        bool c;
        bool o;
        if (d.commitCreator == 0 || d.commitOpponent == 0) {
            c = d.commitCreator != 0;
            o = d.commitOpponent != 0;
        } else {
            c = d.revealedCreator;
            o = d.revealedOpponent;
        }
        if (c && !o) _finish(id, m.creator);
        else if (o && !c) _finish(id, m.opponent);
        else _finish(id, address(0));
    }

    // ------------------------------------------------------------------ bataille navale

    /// @notice Empreinte du plateau à envoyer à commitNavalBoard. Bateaux dans l'ordre 4, 3, 3, 2 cases ;
    ///         (x, y) = case de départ (colonne, ligne), vertical = vers le bas, sinon vers la droite.
    ///         À calculer dans le navigateur (pas par un appel au contrat) pour garder le plateau secret.
    function navalHash(
        uint256 id,
        address player,
        uint8[4] calldata xs,
        uint8[4] calldata ys,
        bool[4] calldata vertical,
        bytes32 salt
    ) public view returns (bytes32) {
        return keccak256(abi.encode("navale", address(this), block.chainid, id, player, xs, ys, vertical, salt));
    }

    /// @notice Placement : chaque joueur engage l'empreinte de son plateau (qui reste secret).
    function commitNavalBoard(uint256 id, bytes32 commitment) external nonReentrant {
        address player = _player(id);
        Match storage m = matches[id];
        NavalState storage n = naval[id];
        if (m.status != Status.Active || m.game != GameType.BatailleNavale || n.phase != 0) revert InvalidState();
        if (commitment == 0) revert InvalidMove();
        if (player == m.creator) {
            if (n.commitCreator != 0) revert InvalidState();
            n.commitCreator = commitment;
        } else if (player == m.opponent) {
            if (n.commitOpponent != 0) revert InvalidState();
            n.commitOpponent = commitment;
        } else revert NotPlayer();
        m.lastActionAt = uint64(block.timestamp);
        emit NavalBoardCommitted(id, player);
        if (n.commitCreator != 0 && n.commitOpponent != 0) n.phase = 1; // l'accepteur (m.turn) tire en premier
    }

    /// @notice Tour de jeu : répondre au tir adverse (touché ou non), puis tirer sur la case `cell`.
    ///         Au tout premier tir, `prevHit` est ignoré. Si cette réponse donne la victoire à
    ///         l'adversaire (ou si tout le plateau a été visé), la partie passe à la révélation.
    function navalTurn(uint256 id, bool prevHit, uint8 cell) external nonReentrant {
        address player = _player(id);
        Match storage m = matches[id];
        NavalState storage n = naval[id];
        if (m.status != Status.Active || m.game != GameType.BatailleNavale || n.phase != 1) revert InvalidState();
        if (player != m.turn) revert NotYourTurn();
        bool isCreator = player == m.creator;
        m.lastActionAt = uint64(block.timestamp);

        if (n.hasPending) {
            n.hasPending = false;
            uint64 bit = uint64(1) << n.pendingCell;
            if (prevHit) {
                if (isCreator) n.hitsByOpponent |= bit;
                else n.hitsByCreator |= bit;
            }
            emit NavalAnswered(id, player, n.pendingCell, prevHit);
            uint64 otherHits = isCreator ? n.hitsByOpponent : n.hitsByCreator;
            if (_popcount(otherHits) >= NAVAL_SHIP_CELLS) {
                n.phase = 2;
                m.turn = address(0);
                return;
            }
        }

        uint64 myShots = isCreator ? n.shotsByCreator : n.shotsByOpponent;
        if (myShots == type(uint64).max) {
            // plateau adverse entièrement visé sans couler la flotte : quelqu'un a menti, on vérifie
            n.phase = 2;
            m.turn = address(0);
            return;
        }
        if (cell > 63 || (myShots >> cell) & 1 == 1) revert InvalidMove();
        if (isCreator) n.shotsByCreator = myShots | (uint64(1) << cell);
        else n.shotsByOpponent = myShots | (uint64(1) << cell);
        n.pendingCell = cell;
        n.hasPending = true;
        m.turn = isCreator ? m.opponent : m.creator;
        emit NavalShot(id, player, cell);
    }

    /// @notice Fin de partie : chacun révèle son plateau. Le contrat vérifie que la flotte est valide
    ///         et que toutes les annonces « touché / raté » étaient vraies. Un tricheur perd.
    function revealNavalBoard(
        uint256 id,
        uint8[4] calldata xs,
        uint8[4] calldata ys,
        bool[4] calldata vertical,
        bytes32 salt
    ) external nonReentrant {
        address player = _player(id);
        Match storage m = matches[id];
        NavalState storage n = naval[id];
        if (m.status != Status.Active || m.game != GameType.BatailleNavale || n.phase != 2) revert InvalidState();
        bool isCreator = player == m.creator;
        if (!isCreator && player != m.opponent) revert NotPlayer();
        if ((isCreator ? n.revealCreator : n.revealOpponent) != 0) revert InvalidState();
        if (navalHash(id, player, xs, ys, vertical, salt) != (isCreator ? n.commitCreator : n.commitOpponent)) {
            revert InvalidMove(); // mauvais plateau ou mauvais sel : on peut réessayer
        }

        (bool valid, uint64 ships) = _navalBoard(xs, ys, vertical);
        // Les tirs reçus par ce joueur et ses annonces :
        uint64 shotsReceived = isCreator ? n.shotsByOpponent : n.shotsByCreator;
        uint64 hitsAnnounced = isCreator ? n.hitsByOpponent : n.hitsByCreator;
        bool honest = valid && (ships & shotsReceived) == hitsAnnounced;
        if (isCreator) n.revealCreator = honest ? 1 : 2;
        else n.revealOpponent = honest ? 1 : 2;
        m.lastActionAt = uint64(block.timestamp);
        emit NavalRevealed(id, player, honest);

        if (!honest) {
            // tricheur démasqué : l'autre gagne, sauf s'il a déjà été démasqué lui aussi
            uint8 other = isCreator ? n.revealOpponent : n.revealCreator;
            _finish(id, other == 2 ? address(0) : (isCreator ? m.opponent : m.creator));
        } else if (n.revealCreator == 1 && n.revealOpponent == 1) {
            _finish(id, _navalLeader(m, n));
        }
    }

    function _navalTimeout(uint256 id) internal {
        Match storage m = matches[id];
        NavalState storage n = naval[id];
        if (n.phase == 0) {
            bool c = n.commitCreator != 0;
            bool o = n.commitOpponent != 0;
            if (c && !o) _finish(id, m.creator);
            else if (o && !c) _finish(id, m.opponent);
            else _finish(id, address(0));
        } else if (n.phase == 1) {
            _finish(id, m.turn == m.creator ? m.opponent : m.creator); // celui qui devait jouer perd
        } else {
            // révélation : un joueur honnête l'emporte sur celui qui n'a pas révélé
            if (n.revealCreator == 1 && n.revealOpponent == 0) _finish(id, m.creator);
            else if (n.revealOpponent == 1 && n.revealCreator == 0) _finish(id, m.opponent);
            else _finish(id, address(0));
        }
    }

    /// @dev Celui qui a coulé toute la flotte adverse (address(0) si personne).
    function _navalLeader(Match storage m, NavalState storage n) internal view returns (address) {
        if (_popcount(n.hitsByCreator) >= NAVAL_SHIP_CELLS) return m.creator;
        if (_popcount(n.hitsByOpponent) >= NAVAL_SHIP_CELLS) return m.opponent;
        return address(0);
    }

    function _navalBoard(uint8[4] calldata xs, uint8[4] calldata ys, bool[4] calldata vertical)
        internal
        pure
        returns (bool valid, uint64 board)
    {
        uint8[4] memory sizes = [4, 3, 3, 2];
        for (uint256 s = 0; s < 4; s++) {
            uint256 x = xs[s];
            uint256 y = ys[s];
            uint256 len = sizes[s];
            if (vertical[s] ? (x > 7 || y + len > 8) : (y > 7 || x + len > 8)) return (false, 0);
            for (uint256 k = 0; k < len; k++) {
                uint256 cell = vertical[s] ? (y + k) * 8 + x : y * 8 + x + k;
                uint64 bit = uint64(1) << uint64(cell);
                if (board & bit != 0) return (false, 0); // bateaux superposés
                board |= bit;
            }
        }
        return (true, board);
    }

    function _popcount(uint64 v) internal pure returns (uint8 c) {
        while (v != 0) {
            v &= v - 1;
            c++;
        }
    }

    // ------------------------------------------------------------------ abandon et délais

    /// @notice Abandonner : l'adversaire gagne.
    function resign(uint256 id) external nonReentrant {
        address player = _player(id);
        Match storage m = matches[id];
        if (m.status != Status.Active) revert InvalidState();
        if (player == m.creator) _finish(id, m.opponent);
        else if (player == m.opponent) _finish(id, m.creator);
        else revert NotPlayer();
    }

    /// @notice Si un joueur ne joue plus pendant moveTimeout, n'importe qui peut clore la partie.
    ///         Plateau : celui qui devait jouer perd. PFC : celui qui a agi gagne ; si aucun
    ///         des deux n'a agi, les mises sont remboursées.
    function claimTimeout(uint256 id) external nonReentrant {
        Match storage m = matches[id];
        if (m.status != Status.Active) revert InvalidState();
        if (block.timestamp <= m.lastActionAt + moveTimeout) revert TooEarly();

        if (m.game == GameType.DuelDeDes) return _diceTimeout(id);
        if (m.game == GameType.BatailleNavale) return _navalTimeout(id);

        if (m.game != GameType.PierreFeuilleCiseaux) {
            _finish(id, m.turn == m.creator ? m.opponent : m.creator);
            return;
        }
        PfcState storage s = pfc[id];
        bool creatorDone;
        bool opponentDone;
        if (s.commitCreator == 0 || s.commitOpponent == 0) {
            creatorDone = s.commitCreator != 0;
            opponentDone = s.commitOpponent != 0;
        } else {
            creatorDone = s.revealCreator != 0;
            opponentDone = s.revealOpponent != 0;
        }
        if (creatorDone && !opponentDone) _finish(id, m.creator);
        else if (opponentDone && !creatorDone) _finish(id, m.opponent);
        else _finish(id, address(0));
    }

    // ------------------------------------------------------------------ frais

    /// @notice Récupérer des gains qui n'ont pas pu être virés automatiquement, vers l'adresse de son choix.
    function withdraw(address to) external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert InvalidState();
        owed[msg.sender] = 0;
        token.safeTransfer(to, amount);
        emit Withdrawn(msg.sender, to, amount);
    }

    /// @dev Le propriétaire ne peut pas renoncer : les frais resteraient bloqués pour toujours.
    function renounceOwnership() public pure override {
        revert InvalidState();
    }

    function withdrawFees(address to) external onlyOwner nonReentrant {
        uint256 amount = feesAccrued;
        feesAccrued = 0;
        token.safeTransfer(to, amount);
        emit FeesWithdrawn(to, amount);
    }

    // ------------------------------------------------------------------ lecture

    function getMatch(uint256 id) external view returns (Match memory) {
        return matches[id];
    }

    /// @notice Renvoie les parties [from, from+count) pour l'affichage.
    function getMatches(uint256 from, uint256 count) external view returns (Match[] memory list) {
        if (from == 0) from = 1;
        if (from > matchCount) return new Match[](0);
        uint256 end = from + count - 1;
        if (end > matchCount) end = matchCount;
        list = new Match[](end - from + 1);
        for (uint256 i = from; i <= end; i++) list[i - from] = matches[i];
    }

    // ------------------------------------------------------------------ interne

    function _finish(uint256 id, address winner) internal {
        Match storage m = matches[id];
        m.status = Status.Finished;
        m.winner = winner;
        m.turn = address(0);
        if (winner == address(0)) {
            // match nul : chacun récupère sa mise, pas de frais
            _pay(m.creator, m.stake);
            _pay(m.opponent, m.stake);
            emit MatchFinished(id, address(0), 0, 0);
            return;
        }
        uint256 pot = m.stake * 2;
        uint256 fee = (pot * FEE_BPS) / BPS;
        feesAccrued += fee;
        _pay(winner, pot - fee);
        emit MatchFinished(id, winner, pot - fee, fee);
    }

    /// @dev Vire un gain ; si le virement échoue (adresse bloquée par l'émetteur du jeton...),
    ///      le montant est mis de côté au lieu de bloquer la partie et la mise de l'autre joueur.
    function _pay(address to, uint256 amount) internal {
        if (!token.trySafeTransfer(to, amount)) {
            owed[to] += amount;
            emit PaymentDeferred(to, amount);
        }
    }

    function _cell(uint256 board, uint256 i) internal pure returns (uint256) {
        return (board >> (i * 2)) & 3;
    }

    function _setCell(uint256 board, uint256 i, uint256 v) internal pure returns (uint256) {
        return board | (v << (i * 2));
    }

    function _morpionWin(uint256 b, uint256 p) internal pure returns (bool) {
        uint8[24] memory l = [0,1,2, 3,4,5, 6,7,8, 0,3,6, 1,4,7, 2,5,8, 0,4,8, 2,4,6];
        for (uint256 k = 0; k < 24; k += 3) {
            if (_cell(b, l[k]) == p && _cell(b, l[k + 1]) == p && _cell(b, l[k + 2]) == p) return true;
        }
        return false;
    }

    function _p4Win(uint256 b, uint256 idx, uint256 p) internal pure returns (bool) {
        int256 r0 = int256(idx / 7);
        int256 c0 = int256(idx % 7);
        int256[4] memory dr = [int256(0), 1, 1, 1];
        int256[4] memory dc = [int256(1), 0, 1, -1];
        for (uint256 d = 0; d < 4; d++) {
            uint256 n = 1;
            for (int256 s = -1; s <= 1; s += 2) {
                int256 r = r0 + dr[d] * s;
                int256 c = c0 + dc[d] * s;
                while (r >= 0 && r < 6 && c >= 0 && c < 7 && _cell(b, uint256(r * 7 + c)) == p) {
                    n++;
                    r += dr[d] * s;
                    c += dc[d] * s;
                }
            }
            if (n >= 4) return true;
        }
        return false;
    }
}
