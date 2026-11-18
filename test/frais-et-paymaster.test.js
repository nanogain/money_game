// Frais versés automatiquement + session signée + comptes de jeu ERC-4337 payés par un paymaster.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const MORPION = 1;
const STAKE = 10_000_000n;
const FEE = (STAKE * 2n * 200n) / 10_000n;
const WEEK = 7 * 24 * 3600;

// Une seule signature : un permit du budget au profit du contrat de prélèvement de la session.
async function sessionPermit(arena, usdc, player, key, budget, duration, deadline) {
  const { chainId } = await ethers.provider.getNetwork();
  const spender = await arena.sessionSpender(player.address, key, duration);
  const sig = ethers.Signature.from(await player.signTypedData(
    { name: "Jeton de test Arene", version: "1", chainId, verifyingContract: await usdc.getAddress() },
    { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    { owner: player.address, spender, value: budget, nonce: await usdc.nonces(player.address), deadline }));
  return [player.address, key, budget, duration, deadline, sig.v, sig.r, sig.s];
}

describe("Frais automatiques", function () {
  let usdc, arena, owner, alice, bob, carol;
  beforeEach(async () => {
    [owner, alice, bob, carol] = await ethers.getSigners();
    usdc = await (await ethers.getContractFactory("BlacklistUSDC")).deploy();
    arena = await (await ethers.getContractFactory("MiniJeuxArena")).deploy(await usdc.getAddress(), 600);
    for (const s of [alice, bob]) {
      await usdc.mint(s.address, 1000_000_000n);
      await usdc.connect(s).approve(await arena.getAddress(), ethers.MaxUint256);
    }
  });
  async function play() {
    await arena.connect(alice).createMatch(MORPION, STAKE);
    const id = await arena.matchCount();
    await arena.connect(bob).joinMatch(id);
    return arena.connect(alice).resign(id);
  }

  it("les 2 % arrivent sur l'adresse de réception choisie, à chaque fin de partie", async () => {
    expect(await arena.feeRecipient()).to.equal(owner.address);
    await arena.setFeeRecipient(carol.address);
    await expect(play()).to.emit(arena, "FeePaid").withArgs(1n, carol.address, FEE);
    expect(await usdc.balanceOf(carol.address)).to.equal(FEE);
    expect(await arena.feesAccrued()).to.equal(0n);
  });

  it("seul le propriétaire choisit l'adresse, jamais l'adresse zéro", async () => {
    await expect(arena.connect(alice).setFeeRecipient(alice.address)).to.be.revertedWithCustomError(arena, "OwnableUnauthorizedAccount");
    await expect(arena.setFeeRecipient(ethers.ZeroAddress)).to.be.revertedWithCustomError(arena, "InvalidMove");
  });

  it("virement impossible : les frais restent dans le contrat sans bloquer la partie", async () => {
    await arena.setFeeRecipient(carol.address);
    await usdc.setBlocked(carol.address, true);
    const before = await usdc.balanceOf(bob.address);
    await play();
    expect(await usdc.balanceOf(bob.address)).to.equal(before - STAKE + STAKE * 2n - FEE); // mise puis pot
    expect(await arena.feesAccrued()).to.equal(FEE);
    await arena.withdrawFees(owner.address);
    expect(await usdc.balanceOf(owner.address)).to.equal(FEE);
  });
});

describe("Session ouverte par une seule signature (sans ETH pour le joueur)", function () {
  let usdc, arena, alice, bob, relayer;
  beforeEach(async () => {
    [, alice, bob, relayer] = await ethers.getSigners();
    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    arena = await (await ethers.getContractFactory("MiniJeuxArena")).deploy(await usdc.getAddress(), 600);
    for (const s of [alice, bob]) await usdc.faucetTo(s.address, 1000_000_000n);
  });

  it("n'importe qui peut transmettre la signature ; elle ne sert qu'une fois", async () => {
    const key = ethers.Wallet.createRandom().address;
    const args = await sessionPermit(arena, usdc, alice, key, STAKE * 2n, WEEK, (await time.latest()) + 3600);
    await arena.connect(relayer).openSessionByPermit(...args);
    const s = await arena.sessions(alice.address);
    expect(s.key).to.equal(key);
    expect(s.budget).to.equal(STAKE * 2n);
    await expect(arena.connect(relayer).openSessionByPermit(...args)).to.be.revertedWithCustomError(arena, "NotPlayer");
  });

  it("refuse une signature d'un autre compte, une clé, un budget ou une durée modifiés", async () => {
    const key = ethers.Wallet.createRandom().address;
    const deadline = (await time.latest()) + 3600;
    const byBob = await sessionPermit(arena, usdc, bob, key, STAKE, WEEK, deadline);
    await expect(arena.openSessionByPermit(alice.address, ...byBob.slice(1))).to.be.revertedWithCustomError(arena, "NotPlayer");
    const good = await sessionPermit(arena, usdc, alice, key, STAKE, WEEK, deadline);
    const other = ethers.Wallet.createRandom().address;
    await expect(arena.openSessionByPermit(good[0], other, ...good.slice(2))).to.be.revertedWithCustomError(arena, "NotPlayer");
    await expect(arena.openSessionByPermit(good[0], key, STAKE * 10n, ...good.slice(3))).to.be.revertedWithCustomError(arena, "NotPlayer");
    await expect(arena.openSessionByPermit(good[0], key, STAKE, WEEK * 2, ...good.slice(4))).to.be.revertedWithCustomError(arena, "NotPlayer");
    await time.increase(7200);
    await expect(arena.openSessionByPermit(...good)).to.be.revertedWithCustomError(arena, "NotPlayer"); // signature expirée
  });

  it("la clé ne peut prélever que des mises, dans la limite du budget, et plus rien après fermeture", async () => {
    const keyW = ethers.Wallet.createRandom().connect(ethers.provider);
    await relayer.sendTransaction({ to: keyW.address, value: ethers.parseEther("1") });
    await arena.openSessionByPermit(...await sessionPermit(arena, usdc, alice, keyW.address, STAKE, WEEK, (await time.latest()) + 3600));
    const spender = (await arena.sessions(alice.address)).spender;
    // le contrat de prélèvement n'obéit qu'à l'arène
    const sp = await ethers.getContractAt("SessionSpender", spender);
    await expect(sp.connect(keyW).pull(await usdc.getAddress(), alice.address, 1n)).to.be.reverted;
    await arena.connect(keyW).createMatchAsSession(MORPION, STAKE);
    expect(await usdc.balanceOf(alice.address)).to.equal(1000_000_000n - STAKE);
    await expect(arena.connect(keyW).createMatchAsSession(MORPION, STAKE)).to.be.revertedWithCustomError(arena, "BudgetExceeded");
    await arena.connect(alice).closeSession();
    await expect(arena.connect(keyW).createMatchAsSession(MORPION, 1_000_000n)).to.be.revertedWithCustomError(arena, "NotPlayer");
    // une ancienne signature ne rouvre pas la session (numéro de session consommé)
    expect(await arena.sessionNonces(alice.address)).to.equal(1n);
  });
});

describe("Comptes de jeu ERC-4337 + paymaster", function () {
  let ep, factory, paymaster, usdc, arena, bundler, player, owner;

  beforeEach(async () => {
    [bundler] = await ethers.getSigners();
    ep = await (await ethers.getContractFactory("EntryPoint")).deploy();
    factory = await (await ethers.getContractFactory("SimpleAccountFactory")).deploy(await ep.getAddress());
    paymaster = await (await ethers.getContractFactory("OpenPaymaster")).deploy(await ep.getAddress());
    await paymaster.deposit({ value: ethers.parseEther("1") });
    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    arena = await (await ethers.getContractFactory("MiniJeuxArena")).deploy(await usdc.getAddress(), 600);
    // joueur SANS ETH : seulement des jetons
    player = ethers.Wallet.createRandom().connect(ethers.provider);
    await usdc.faucetTo(player.address, 1000_000_000n);
    owner = ethers.Wallet.createRandom(); // clé de session du navigateur, sans ETH non plus
  });

  const accountAddr = () => factory["getAddress(address,uint256)"](owner.address, 0);
  const pad = (v, n = 16) => ethers.zeroPadValue(ethers.toBeHex(v), n);

  async function sendOp(calls) {
    const sender = await accountAddr();
    const deployed = (await ethers.provider.getCode(sender)) !== "0x";
    const acct = await ethers.getContractAt("SimpleAccount", sender);
    const callData = calls.length === 1
      ? acct.interface.encodeFunctionData("execute", [calls[0].to, 0, calls[0].data])
      : acct.interface.encodeFunctionData("executeBatch", [calls.map((c) => c.to), calls.map(() => 0), calls.map((c) => c.data)]);
    const initCode = deployed ? "0x" : ethers.concat([await factory.getAddress(), factory.interface.encodeFunctionData("createAccount", [owner.address, 0])]);
    const op = {
      sender,
      nonce: await ep.getNonce(sender, 0),
      initCode,
      callData,
      accountGasLimits: ethers.concat([pad(1_000_000), pad(1_000_000)]),
      preVerificationGas: 100_000,
      gasFees: ethers.concat([pad(1_000_000_000), pad(2_000_000_000)]),
      paymasterAndData: ethers.concat([await paymaster.getAddress(), pad(300_000), pad(100_000)]),
      signature: "0x",
    };
    const hash = await ep.getUserOpHash(op);
    op.signature = await owner.signMessage(ethers.getBytes(hash));
    const tx = await ep.connect(bundler).handleOps([op], bundler.address);
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => { try { return ep.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "UserOperationEvent");
    expect(ev.args.success, "UserOperation réussie").to.equal(true);
  }

  it("le joueur signe UNE fois puis joue sans jamais avoir d'ETH", async () => {
    const key = await accountAddr();
    // 1) une seule signature, gratuite : le permit du budget de la session
    const args = await sessionPermit(arena, usdc, player, key, 50_000_000n, WEEK, (await time.latest()) + 3600);
    // 2) le compte de jeu l'envoie, frais payés par le paymaster
    await sendOp([{ to: await arena.getAddress(), data: arena.interface.encodeFunctionData("openSessionByPermit", args) }]);
    expect((await arena.sessions(player.address)).key).to.equal(key);
    // 3) publier une annonce : mise prise sur le wallet du joueur
    await sendOp([{ to: await arena.getAddress(), data: arena.interface.encodeFunctionData("createMatchAsSession", [MORPION, STAKE]) }]);
    const m = await arena.getMatch(1);
    expect(m.creator).to.equal(player.address);
    expect(await usdc.balanceOf(player.address)).to.equal(1000_000_000n - STAKE);
    expect(await ethers.provider.getBalance(player.address)).to.equal(0n);
    // 4) jetons de test sans confirmation
    await sendOp([{ to: await usdc.getAddress(), data: usdc.interface.encodeFunctionData("faucetTo", [player.address, 1_000_000n]) }]);
    expect(await usdc.balanceOf(player.address)).to.equal(1000_000_000n - STAKE + 1_000_000n);
  });
});
