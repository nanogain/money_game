// Réseaux et adresses des contrats déployés.
// Après un déploiement, mettre ici les adresses (ou laisser scripts/deploy.js le faire).
window.NETWORKS = {
  "84532": {
    "name": "Base Sepolia (réseau de test)",
    "rpc": "https://sepolia.base.org",
    "explorer": "https://sepolia.basescan.org",
    "arena": "0xde99AAa6e81708322325E65A7FA8C82b66C17D18",
    "usdc": "0xe977639ADA11121eD56B699AdbE1067626a38dF3",
    "mockUsdc": true,
    "moveTimeout": 600,
    "entryPoint": "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    "accountFactory": "0x5a43E08Dd7B2c778085c2C2Cd2E4d62833F6Ab17",
    "paymasterUrl": "https://api.developer.coinbase.com/rpc/v1/base-sepolia/IaODr1KXEfob5yccCgRPKLXPNaBacGAu"
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
