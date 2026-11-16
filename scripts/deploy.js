// Déploie le faux USDC (si besoin) et le contrat des mini-jeux, puis met à jour frontend/config.js.
// Usage : npx hardhat run scripts/deploy.js --network localhost
// (Pour Base Sepolia, le plus simple est la page frontend/deploy.html, depuis MetaMask.)
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { exportFrontend } = require("./export-frontend");

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

  await exportFrontend();
  const { chainId } = await ethers.provider.getNetwork();
  const file = path.join(__dirname, "..", "frontend", "config.js");
  const src = fs.readFileSync(file, "utf8");
  const json = src.slice(src.indexOf("{"), src.lastIndexOf("}") + 1);
  const nets = JSON.parse(json);
  const key = String(chainId);
  nets[key] = { ...(nets[key] || { name: network.name, rpc: "", explorer: "" }), arena: arenaAddress, usdc: usdcAddress, mockUsdc: mock, moveTimeout: timeout };
  fs.writeFileSync(file, src.slice(0, src.indexOf("{")) + JSON.stringify(nets, null, 2) + ";\n");
  console.log("frontend/config.js mis à jour.");
}

main().catch((e) => { console.error(e); process.exit(1); });
