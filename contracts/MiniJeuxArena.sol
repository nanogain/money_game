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

    enum GameType { PierreFeuilleCiseaux, Morpion, Puissance4 }
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
    /// @notice Gains qui n'ont pas pu être virés automatiquement (ex. adresse bloquée par
    ///         l'émetteur du jeton). Récupérables avec withdraw().
    mapping(address => uint256) public owed;

    event MatchCreated(uint256 indexed id, address indexed creator, GameType game, uint256 stake);
    event MatchJoined(uint256 indexed id, address indexed opponent);
    event MatchCancelled(uint256 indexed id);
    event Moved(uint256 indexed id, address indexed player, uint8 position);
    event PfcCommitted(uint256 indexed id, address indexed player, uint8 round);
    event PfcRevealed(uint256 indexed id, address indexed player, uint8 move, uint8 round);
    event PfcRoundDraw(uint256 indexed id, uint8 round);
    event MatchFinished(uint256 indexed id, address winner, uint256 payout, uint256 fee);
    event FeesWithdrawn(address to, uint256 amount);
    event PaymentDeferred(address indexed to, uint256 amount);
    event Withdrawn(address indexed from, address indexed to, uint256 amount);

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
        if (msg.sender != m.creator) revert NotPlayer();
        m.status = Status.Cancelled;
        token.safeTransfer(m.creator, m.stake);
        emit MatchCancelled(id);
    }

    /// @notice Accepter une annonce : dépose la même mise. L'accepteur joue en premier.
    function joinMatch(uint256 id) external nonReentrant {
        Match storage m = matches[id];
        if (m.status != Status.Open) revert InvalidState();
        if (msg.sender == m.creator) revert NotPlayer();
        m.opponent = msg.sender;
        m.status = Status.Active;
        m.turn = msg.sender;
        m.lastActionAt = uint64(block.timestamp);
        token.safeTransferFrom(msg.sender, address(this), m.stake);
        emit MatchJoined(id, msg.sender);
    }

    // ------------------------------------------------------------------ jeux de plateau

    /// @notice Jouer un coup. Morpion : case 0-8. Puissance 4 : colonne 0-6.
    function play(uint256 id, uint8 position) external nonReentrant {
        Match storage m = matches[id];
        if (m.status != Status.Active || m.game == GameType.PierreFeuilleCiseaux) revert InvalidState();
        if (msg.sender != m.turn) revert NotYourTurn();
        uint256 mark = msg.sender == m.creator ? 1 : 2;

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
        emit Moved(id, msg.sender, position);

        if (won) {
            _finish(id, msg.sender);
        } else if (m.moves == maxMoves) {
            _finish(id, address(0)); // match nul
        } else {
            m.turn = msg.sender == m.creator ? m.opponent : m.creator;
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
        Match storage m = matches[id];
        if (m.status != Status.Active || m.game != GameType.PierreFeuilleCiseaux) revert InvalidState();
        // Une empreinte nulle ne compterait pas comme un coup mais repousserait le délai :
        // un joueur pourrait bloquer la partie indéfiniment.
        if (commitment == bytes32(0)) revert InvalidMove();
        PfcState storage s = pfc[id];
        if (msg.sender == m.creator) {
            if (s.commitCreator != 0) revert InvalidState();
            s.commitCreator = commitment;
        } else if (msg.sender == m.opponent) {
            if (s.commitOpponent != 0) revert InvalidState();
            s.commitOpponent = commitment;
        } else revert NotPlayer();
        m.lastActionAt = uint64(block.timestamp);
        emit PfcCommitted(id, msg.sender, m.moves);
    }

    /// @notice Étape 2 : une fois les deux coups cachés envoyés, chacun révèle son coup et son sel.
    function revealPfc(uint256 id, uint8 move, bytes32 salt) external nonReentrant {
        Match storage m = matches[id];
        if (m.status != Status.Active || m.game != GameType.PierreFeuilleCiseaux) revert InvalidState();
        PfcState storage s = pfc[id];
        if (s.commitCreator == 0 || s.commitOpponent == 0) revert InvalidState();
        if (move < 1 || move > 3) revert InvalidMove();
        bytes32 h = pfcHash(id, m.moves, msg.sender, move, salt);
        if (msg.sender == m.creator) {
            if (s.revealCreator != 0 || h != s.commitCreator) revert InvalidMove();
            s.revealCreator = move;
        } else if (msg.sender == m.opponent) {
            if (s.revealOpponent != 0 || h != s.commitOpponent) revert InvalidMove();
            s.revealOpponent = move;
        } else revert NotPlayer();
        m.lastActionAt = uint64(block.timestamp);
        emit PfcRevealed(id, msg.sender, move, m.moves);

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

    // ------------------------------------------------------------------ abandon et délais

    /// @notice Abandonner : l'adversaire gagne.
    function resign(uint256 id) external nonReentrant {
        Match storage m = matches[id];
        if (m.status != Status.Active) revert InvalidState();
        if (msg.sender == m.creator) _finish(id, m.opponent);
        else if (msg.sender == m.opponent) _finish(id, m.creator);
        else revert NotPlayer();
    }

    /// @notice Si un joueur ne joue plus pendant moveTimeout, n'importe qui peut clore la partie.
    ///         Plateau : celui qui devait jouer perd. PFC : celui qui a agi gagne ; si aucun
    ///         des deux n'a agi, les mises sont remboursées.
    function claimTimeout(uint256 id) external nonReentrant {
        Match storage m = matches[id];
        if (m.status != Status.Active) revert InvalidState();
        if (block.timestamp <= m.lastActionAt + moveTimeout) revert TooEarly();

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
