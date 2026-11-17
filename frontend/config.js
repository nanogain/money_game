// Réseaux et adresses des contrats déployés.
// Après un déploiement, mettre ici les adresses (ou laisser scripts/deploy.js le faire).
window.NETWORKS = {
  "84532": {
    "name": "Base Sepolia (réseau de test)",
    "rpc": "https://sepolia.base.org",
    "explorer": "https://sepolia.basescan.org",
    "arena": "0x82Fec22Bc63f9112AC779F5905E46ee7e97688fB",
    "usdc": "0x29c55083afe52e638222D2Aa694f5A2dC2c4eEa7",
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
