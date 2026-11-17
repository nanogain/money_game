// Réseaux et adresses des contrats déployés.
// Après un déploiement, mettre ici les adresses (ou laisser scripts/deploy.js le faire).
window.NETWORKS = {
  "84532": {
    "name": "Base Sepolia (réseau de test)",
    "rpc": "https://sepolia.base.org",
    "explorer": "https://sepolia.basescan.org",
    "arena": "0x5bd54641eFD0d58E2f251600454c8c506ef4E280",
    "usdc": "0x742680c7d095a387443564B0907C5B1b1Da56388",
    "mockUsdc": true,
    "moveTimeout": 600
  },
  "31337": {
    "name": "Blockchain locale (Hardhat)",
    "rpc": "http://127.0.0.1:8545",
    "explorer": "",
    "arena": "",
    "usdc": "",
    "mockUsdc": true,
    "moveTimeout": 600
  }
};
