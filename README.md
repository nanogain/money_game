# Arène : mini-jeux en duel avec mises en USDC

Deux joueurs misent la même somme en USDC, jouent une partie, et le contrat paie le gagnant
(pot moins 2 % de frais). **Aucun oracle ni serveur** : les règles des jeux sont dans le
smart contract, qui vérifie chaque coup et désigne lui-même le vainqueur.

## Les 5 jeux

| Jeu | Comment le résultat est garanti |
|---|---|
| Pierre-Feuille-Ciseaux | Chaque joueur envoie d'abord son coup **caché** (une empreinte), puis le révèle. Personne ne peut voir le coup de l'autre avant de jouer, ni changer d'avis après. Égalité : nouvelle manche. |
| Morpion | Chaque coup est une transaction. Le contrat refuse les coups illégaux et détecte l'alignement. |
| Puissance 4 | Pareil : le contrat fait tomber le jeton dans la colonne et détecte les 4 alignés. |
| Duel de dés | Chaque joueur engage un secret aléatoire, puis le révèle. Les deux dés sont tirés de la combinaison des deux secrets : aucun joueur ne peut choisir ni prévoir le résultat. Plus haut dé gagne, égalité : on relance. |
| Bataille navale | Plateau 8x8, bateaux de 4, 3, 3 et 2 cases. Chaque joueur engage l'empreinte de son plateau (qui reste secret), le site annonce automatiquement « touché / raté », puis les deux plateaux sont révélés à la fin : le contrat vérifie la flotte et chaque annonce. Un tricheur perd la partie. |

Règles communes :
- Celui qui accepte l'annonce joue en premier.
- Match nul : chacun récupère sa mise, sans frais.
- Un joueur qui ne joue plus pendant le délai (10 min par défaut) perd : son adversaire clique « Réclamer la victoire ».
  Au Pierre-Feuille-Ciseaux, si aucun des deux n'a agi, les mises sont remboursées.
- On peut annuler sa propre annonce tant que personne ne l'a acceptée.
- Les frais (2 % du pot) s'accumulent dans le contrat ; seul le propriétaire peut les retirer (`withdrawFees`).

## Confirmations du wallet

- **Connexion** : une confirmation dans MetaMask.
- **Première partie seulement** : une autorisation USDC (le contrat ne prélève jamais que la mise
  choisie, au moment où vous publiez ou acceptez une annonce).
- **Publier ou relever un défi** : une seule confirmation. Elle dépose la mise, autorise une
  **clé de session** pour cette partie et lui envoie un peu d'ETH pour le gaz (0,0005 ETH).
- **Coups, révélations, abandon, réclamation de victoire** : aucune confirmation. La clé de
  session, créée et gardée dans le navigateur, les envoie à votre place.

La clé de session ne peut que jouer la partie pour laquelle elle a été autorisée : elle ne peut ni
retirer des fonds, ni changer de clé, et les gains vont toujours au wallet du joueur. Depuis un
autre navigateur, le bouton « ⚡ Jouer sans confirmation » autorise une nouvelle clé (une
confirmation). Si la clé n'a plus d'ETH, les coups repassent par MetaMask.

## Contenu

- `contracts/MiniJeuxArena.sol` : le contrat (annonces, mises, jeux, frais, délais).
- `contracts/MockUSDC.sol` : jeton de test ARENETEST qui remplace l’USDC sur le réseau de test (avec un robinet gratuit). Il ne s’appelle pas « USDC » exprès : MetaMask signale comme trompeur un jeton qui en imite un autre.
- `test/` : tests automatiques (`npm test`).
- `scripts/deploy.js` : déploiement en ligne de commande + mise à jour de `frontend/config.js`.
- `scripts/export-frontend.js` : copie les ABI/bytecodes compilés dans `frontend/contracts.js`.
- `frontend/deploy.html` : déploiement des contrats depuis MetaMask.
- `frontend/` : site web statique (MetaMask, annonces, plateaux de jeu).

## Lancer en local

```bash
npm install
npx hardhat test                                          # les tests
npx hardhat node                                          # blockchain locale (terminal 1)
npx hardhat run scripts/deploy.js --network localhost     # terminal 2
cd frontend && python3 -m http.server 8080                # puis ouvrir http://localhost:8080
```
Sur `localhost`, le site utilise la blockchain locale ; ailleurs, Base Sepolia (forcer avec `?chain=31337` ou `?chain=84532`).
```
```
Dans MetaMask : ajouter le réseau `http://127.0.0.1:8545` (chainId 31337) et importer une des
clés de test affichées par `npx hardhat node`.

Note : `hardhat.config.js` utilise le compilateur Solidity installé par npm (paquet `solc`)
au lieu de le télécharger.

## Déployer sur le réseau de test Base Sepolia

Le site est publié automatiquement sur GitHub Pages à chaque mise à jour de `main`
(https://nanogain.github.io/money_game/). Sur ce site, le réseau utilisé est Base Sepolia.

Pour installer les contrats, sans partager aucune clé :
1. Ouvrir https://nanogain.github.io/money_game/deploy.html avec MetaMask (un peu d'ETH de test sur le compte).
2. Cliquer « Connecter MetaMask et déployer » et confirmer les 2 transactions.
   Le compte qui déploie devient propriétaire du contrat (retrait des 2 % de frais).
3. Reporter les adresses affichées dans `frontend/config.js` (entrée `84532`) pour que tous les joueurs
   utilisent les mêmes contrats. En attendant, le navigateur qui a déployé les garde en mémoire.

On peut aussi déployer en ligne de commande : `PRIVATE_KEY=0x... npx hardhat run scripts/deploy.js --network baseSepolia`.

### Déploiement actuel (Base Sepolia, 17/11/2026 soir : jeton ARENETEST + coups sans confirmation)

- Contrat des mini-jeux : [`0x82Fec22Bc63f9112AC779F5905E46ee7e97688fB`](https://sepolia.basescan.org/address/0x82Fec22Bc63f9112AC779F5905E46ee7e97688fB)
- Jeton de test ARENETEST : [`0x29c55083afe52e638222D2Aa694f5A2dC2c4eEa7`](https://sepolia.basescan.org/address/0x29c55083afe52e638222D2Aa694f5A2dC2c4eEa7)
- Propriétaire (retrait des frais) : `0x1290A4Ba39C7620d4Ff4F3a72a3A33d284AdFCF5`

ETH de test gratuit : robinet Coinbase, https://portal.cdp.coinbase.com/onchain-tools/faucet
(le robinet Alchemy exige de l'activité sur le réseau principal).

## Avant la production (réseau Base réel)

- Utiliser le vrai USDC de Base : `USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
- Faire auditer le contrat.
- Coût : chaque coup est une transaction (quelques centimes sur Base). Ça convient aux jeux
  au tour par tour ; un jeu en temps réel demanderait un serveur de jeu qui signe le résultat.
