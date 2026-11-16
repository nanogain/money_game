# Arène : mini-jeux en duel avec mises en USDC

Deux joueurs misent la même somme en USDC, jouent une partie, et le contrat paie le gagnant
(pot moins 2 % de frais). **Aucun oracle ni serveur** : les règles des jeux sont dans le
smart contract, qui vérifie chaque coup et désigne lui-même le vainqueur.

## Les 3 jeux

| Jeu | Comment le résultat est garanti |
|---|---|
| Pierre-Feuille-Ciseaux | Chaque joueur envoie d'abord son coup **caché** (une empreinte), puis le révèle. Personne ne peut voir le coup de l'autre avant de jouer, ni changer d'avis après. Égalité : nouvelle manche. |
| Morpion | Chaque coup est une transaction. Le contrat refuse les coups illégaux et détecte l'alignement. |
| Puissance 4 | Pareil : le contrat fait tomber le jeton dans la colonne et détecte les 4 alignés. |

Règles communes :
- Celui qui accepte l'annonce joue en premier.
- Match nul : chacun récupère sa mise, sans frais.
- Un joueur qui ne joue plus pendant le délai (10 min par défaut) perd : son adversaire clique « Réclamer la victoire ».
  Au Pierre-Feuille-Ciseaux, si aucun des deux n'a agi, les mises sont remboursées.
- On peut annuler sa propre annonce tant que personne ne l'a acceptée.
- Les frais (2 % du pot) s'accumulent dans le contrat ; seul le propriétaire peut les retirer (`withdrawFees`).

## Contenu

- `contracts/MiniJeuxArena.sol` : le contrat (annonces, mises, jeux, frais, délais).
- `contracts/MockUSDC.sol` : faux USDC pour les tests (avec un robinet gratuit).
- `test/arena.test.js` : 20 tests automatiques.
- `scripts/deploy.js` : déploiement + génération de `frontend/config.js`.
- `frontend/` : site web statique (MetaMask, annonces, plateaux de jeu).

## Lancer en local

```bash
npm install
npx hardhat test                                          # les tests
npx hardhat node                                          # blockchain locale (terminal 1)
npx hardhat run scripts/deploy.js --network localhost     # terminal 2
cd frontend && python3 -m http.server 8080                # puis ouvrir http://localhost:8080
```
Dans MetaMask : ajouter le réseau `http://127.0.0.1:8545` (chainId 31337) et importer une des
clés de test affichées par `npx hardhat node`.

Note : `hardhat.config.js` utilise le compilateur Solidity installé par npm (paquet `solc`)
au lieu de le télécharger.

## Déployer sur le réseau de test Base Sepolia

```bash
PRIVATE_KEY=0x... npx hardhat run scripts/deploy.js --network baseSepolia
```
Il faut un peu d'ETH de test Base Sepolia sur ce compte (robinets gratuits). Sans `USDC_ADDRESS`,
le script déploie le faux USDC, ce qui permet aux testeurs de s'en servir gratuitement.
Ensuite, mettre le dossier `frontend/` sur n'importe quel hébergement statique.

## Avant la production (réseau Base réel)

- Utiliser le vrai USDC de Base : `USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
- Faire auditer le contrat.
- Coût : chaque coup est une transaction (quelques centimes sur Base). Ça convient aux jeux
  au tour par tour ; un jeu en temps réel demanderait un serveur de jeu qui signe le résultat.
