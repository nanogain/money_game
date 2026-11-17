// Réseaux et adresses des contrats déployés.
// Après un déploiement, mettre ici les adresses (ou laisser scripts/deploy.js le faire).
window.NETWORKS = {
  "84532": {
    "name": "Base Sepolia (réseau de test)",
    "rpc": "https://sepolia.base.org",
    "explorer": "https://sepolia.basescan.org",
    "arena": "0xCd0d44D59feb129B3E8A832B3Cc9d41990811288",
    "usdc": "0x64E6cD88fA2e5EAC0Dd57932A1CeAbF95F590186",
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
