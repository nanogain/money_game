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

  // Comptes de jeu ERC-4337 : fabrique de comptes (sur tous les réseaux) ; en local seulement,
  // EntryPoint v0.7 et un paymaster qui paie tout (le faux bundler scripts/mock-bundler.js s'en sert).
  let entryPoint = process.env.ENTRYPOINT || "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
  let localPaymaster = "";
  if (network.name === "localhost" || network.name === "hardhat") {
    const ep = await (await ethers.getContractFactory("EntryPoint")).deploy();
    await ep.waitForDeployment();
    entryPoint = await ep.getAddress();
    const pm = await (await ethers.getContractFactory("OpenPaymaster")).deploy(entryPoint);
    await pm.waitForDeployment();
    await (await pm.deposit({ value: ethers.parseEther("10") })).wait();
    localPaymaster = await pm.getAddress();
  }
  const factory = await (await ethers.getContractFactory("SimpleAccountFactory")).deploy(entryPoint);
  await factory.waitForDeployment();
  const accountFactory = await factory.getAddress();
  console.log(`Fabrique de comptes de jeu : ${accountFactory} (EntryPoint ${entryPoint})`);

  await exportFrontend();
  const { chainId } = await ethers.provider.getNetwork();
  const file = path.join(__dirname, "..", "frontend", "config.js");
  const src = fs.readFileSync(file, "utf8");
  const json = src.slice(src.indexOf("{"), src.lastIndexOf("}") + 1);
  const nets = JSON.parse(json);
  const key = String(chainId);
  nets[key] = { ...(nets[key] || { name: network.name, rpc: "", explorer: "" }), arena: arenaAddress, usdc: usdcAddress, mockUsdc: mock, moveTimeout: timeout, entryPoint, accountFactory };
  if (localPaymaster) Object.assign(nets[key], { paymasterUrl: "http://127.0.0.1:8547", localPaymaster });
  fs.writeFileSync(file, src.slice(0, src.indexOf("{")) + JSON.stringify(nets, null, 2) + ";\n");
  console.log("frontend/config.js mis à jour.");
}

main().catch((e) => { console.error(e); process.exit(1); });
