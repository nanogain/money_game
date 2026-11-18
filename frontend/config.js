// Réseaux et adresses des contrats déployés.
// Après un déploiement, mettre ici les adresses (ou laisser scripts/deploy.js le faire).
window.NETWORKS = {
  "84532": {
    "name": "Base Sepolia (réseau de test)",
    "rpc": "https://sepolia.base.org",
    "explorer": "https://sepolia.basescan.org",
    "arena": "0xb1A2F551134e626ECA2B848C24530d809836bF1B",
    "usdc": "0xC47637630D30590e6688291614166d0BCaD72e3B",
    "mockUsdc": true,
    "moveTimeout": 600,
    "entryPoint": "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
    "accountFactory": "0x0991b6ba910731413e1D44C65067dD97317d52aD",
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
