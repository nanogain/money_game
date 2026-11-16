// Déploie le faux USDC (si besoin) et le contrat des mini-jeux, puis écrit frontend/config.js.
// Usage : npx hardhat run scripts/deploy.js --network localhost
//         USDC_ADDRESS=0x... MOVE_TIMEOUT=600 npx hardhat run scripts/deploy.js --network baseSepolia
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const { ethers, network } = hre;
  const [deployer] = await ethers.getSigners();
  const timeout = Number(process.env.MOVE_TIMEOUT || 600);
  console.log(`Réseau : ${network.name} — déployeur : ${deployer.address}`);

  let usdcAddress = process.env.USDC_ADDRESS;
  let mock = false;
  if (!usdcAddress) {
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    await usdc.waitForDeployment();
    usdcAddress = await usdc.getAddress();
    mock = true;
    console.log(`MockUSDC : ${usdcAddress}`);
  }
  const arena = await (await ethers.getContractFactory("MiniJeuxArena")).deploy(usdcAddress, timeout);
  await arena.waitForDeployment();
  const arenaAddress = await arena.getAddress();
  console.log(`MiniJeuxArena : ${arenaAddress} (délai par coup : ${timeout} s)`);

  const { chainId } = await ethers.provider.getNetwork();
  const arenaAbi = (await hre.artifacts.readArtifact("MiniJeuxArena")).abi;
  const usdcAbi = (await hre.artifacts.readArtifact("MockUSDC")).abi;
  const config = { chainId: Number(chainId), network: network.name, arena: arenaAddress, usdc: usdcAddress, mockUsdc: mock, moveTimeout: timeout };
  const out = `// Généré par scripts/deploy.js\nwindow.APP_CONFIG = ${JSON.stringify(config, null, 2)};\nwindow.ARENA_ABI = ${JSON.stringify(arenaAbi)};\nwindow.USDC_ABI = ${JSON.stringify(usdcAbi)};\n`;
  fs.writeFileSync(path.join(__dirname, "..", "frontend", "config.js"), out);
  console.log("frontend/config.js écrit.");
}

main().catch((e) => { console.error(e); process.exit(1); });
