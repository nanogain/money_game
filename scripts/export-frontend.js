// Copie les ABI et bytecodes compilés dans frontend/contracts.js
// (utilisé par le site et par la page de déploiement depuis MetaMask).
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function exportFrontend() {
  await hre.run("compile", { quiet: true });
  const arena = await hre.artifacts.readArtifact("MiniJeuxArena");
  const usdc = await hre.artifacts.readArtifact("MockUSDC");
  const out =
    "// Généré par scripts/export-frontend.js — ne pas modifier à la main.\n" +
    `window.ARENA_ABI = ${JSON.stringify(arena.abi)};\n` +
    `window.USDC_ABI = ${JSON.stringify(usdc.abi)};\n` +
    `window.ARENA_BYTECODE = "${arena.bytecode}";\n` +
    `window.USDC_BYTECODE = "${usdc.bytecode}";\n`;
  fs.writeFileSync(path.join(__dirname, "..", "frontend", "contracts.js"), out);
  console.log("frontend/contracts.js écrit.");
}

module.exports = { exportFrontend };
if (require.main === module) exportFrontend().catch((e) => { console.error(e); process.exit(1); });
