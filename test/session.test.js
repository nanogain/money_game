// Session de jeu : une seule transaction à la connexion, puis mises et coups sans confirmation.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const PFC = 0, MORPION = 1, DES = 3, NAVALE = 4;
const PIERRE = 1, CISEAUX = 3;
const STAKE = 10_000_000n; // 10 USDC
const BUDGET = 50_000_000n; // 50 USDC
const WEEK = 7 * 24 * 3600;
const TIMEOUT = 600;
const POT_NET = STAKE * 2n - (STAKE * 2n * 200n) / 10_000n;
const GAS = ethers.parseEther("0.01");

describe("Sessions de jeu", function () {
  let usdc, arena, alice, bob, carol, ka, kb;

  beforeEach(async () => {
    [, alice, bob, carol] = await ethers.getSigners();
    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    arena = await (await ethers.getContractFactory("MiniJeuxArena")).deploy(await usdc.getAddress(), TIMEOUT);
    for (const s of [alice, bob, carol]) {
      await usdc.connect(s).faucet(1000_000_000n);
      await usdc.connect(s).approve(await arena.getAddress(), ethers.MaxUint256);
    }
    // Clés jetables, comme celles générées dans le navigateur (sans ETH au départ).
    ka = ethers.Wallet.createRandom().connect(ethers.provider);
    kb = ethers.Wallet.createRandom().connect(ethers.provider);
    await arena.connect(alice).openSession(ka.address, BUDGET, WEEK, { value: GAS });
    await arena.connect(bob).openSession(kb.address, BUDGET, WEEK, { value: GAS });
  });

  async function sessionMatch(game) {
    await arena.connect(ka).createMatchAsSession(game, STAKE);
    const id = await arena.matchCount();
    await arena.connect(kb).joinMatchAsSession(id);
    return id;
  }

  it("l'ouverture autorise la clé, fixe budget et durée, et lui envoie l'ETH de gaz", async () => {
    const s = await arena.sessions(alice.address);
    expect(s.key).to.equal(ka.address);
    expect(s.budget).to.equal(BUDGET);
    expect(await arena.sessionOwner(ka.address)).to.equal(alice.address);
    expect(await ethers.provider.getBalance(ka.address)).to.equal(GAS);
  });

  it("la clé publie et relève : mises prélevées sur les wallets, budget décompté", async () => {
    const a0 = await usdc.balanceOf(alice.address);
    const id = await sessionMatch(MORPION);
    const m = await arena.getMatch(id);
    expect(m.creator).to.equal(alice.address);
    expect(m.opponent).to.equal(bob.address);
    expect(await usdc.balanceOf(alice.address)).to.equal(a0 - STAKE);
    expect((await arena.sessions(alice.address)).budget).to.equal(BUDGET - STAKE);
  });

  it("Morpion joué entièrement par les clés : le gain va au wallet du joueur", async () => {
    const id = await sessionMatch(MORPION);
    const before = await usdc.balanceOf(bob.address);
    await arena.connect(kb).play(id, 0);
    await arena.connect(ka).play(id, 3);
    await arena.connect(kb).play(id, 1);
    await arena.connect(ka).play(id, 4);
    await arena.connect(kb).play(id, 2);
    expect((await arena.getMatch(id)).winner).to.equal(bob.address);
    expect(await usdc.balanceOf(bob.address)).to.equal(before + POT_NET);
    expect(await usdc.balanceOf(kb.address)).to.equal(0n);
  });

  it("budget dépassé : refusé", async () => {
    await arena.connect(ka).createMatchAsSession(MORPION, BUDGET);
    await expect(arena.connect(ka).createMatchAsSession(MORPION, STAKE)).to.be.revertedWithCustomError(arena, "BudgetExceeded");
  });

  it("session expirée : plus de nouvelles mises, mais les coups en cours restent possibles", async () => {
    const id = await sessionMatch(MORPION);
    await time.increase(WEEK + 1);
    await expect(arena.connect(ka).createMatchAsSession(MORPION, STAKE)).to.be.revertedWithCustomError(arena, "SessionExpired");
    await arena.connect(kb).play(id, 0);
    expect((await arena.getMatch(id)).moves).to.equal(1);
  });

  it("une clé ne peut ni retirer, ni rouvrir/fermer une session pour son joueur", async () => {
    await expect(arena.connect(ka).withdraw(ka.address)).to.be.revertedWithCustomError(arena, "InvalidState");
    await ethers.provider.send("hardhat_setBalance", [ka.address, "0xDE0B6B3A7640000"]);
    // openSession appelé par la clé ouvre une session pour la CLÉ (sans argent), jamais pour alice
    await expect(arena.connect(ka).openSession(ka.address, BUDGET, WEEK)).to.be.revertedWithCustomError(arena, "InvalidMove");
    await expect(arena.connect(ka).closeSession()).to.be.revertedWithCustomError(arena, "InvalidState");
    expect((await arena.sessions(alice.address)).budget).to.equal(BUDGET);
  });

  it("la clé n'agit pas dans les parties des autres", async () => {
    await arena.connect(carol).createMatch(MORPION, STAKE);
    const id = await arena.matchCount();
    await arena.connect(bob).joinMatch(id);
    await expect(arena.connect(ka).play(id, 0)).to.be.revertedWithCustomError(arena, "NotYourTurn");
    await expect(arena.connect(ka).resign(id)).to.be.revertedWithCustomError(arena, "NotPlayer");
  });

  it("une clé ne relève pas l'annonce de son propre joueur", async () => {
    await arena.connect(alice).createMatch(MORPION, STAKE);
    const id = await arena.matchCount();
    await expect(arena.connect(ka).joinMatchAsSession(id)).to.be.revertedWithCustomError(arena, "NotPlayer");
  });

  it("annonce inexistante : refusée", async () => {
    await expect(arena.connect(kb).joinMatchAsSession(99)).to.be.revertedWithCustomError(arena, "InvalidState");
    await expect(arena.connect(bob).joinMatch(99)).to.be.revertedWithCustomError(arena, "InvalidState");
  });

  it("fermer la session ou en ouvrir une nouvelle désactive l'ancienne clé", async () => {
    const id = await sessionMatch(MORPION);
    const kb2 = ethers.Wallet.createRandom().connect(ethers.provider);
    await arena.connect(bob).openSession(kb2.address, BUDGET, WEEK, { value: GAS });
    expect(await arena.sessionOwner(kb.address)).to.equal(ethers.ZeroAddress);
    await expect(arena.connect(kb).play(id, 0)).to.be.revertedWithCustomError(arena, "NotYourTurn");
    await arena.connect(kb2).play(id, 0);
    await arena.connect(alice).closeSession();
    await expect(arena.connect(ka).play(id, 3)).to.be.revertedWithCustomError(arena, "NotYourTurn");
    await expect(arena.connect(ka).createMatchAsSession(MORPION, STAKE)).to.be.revertedWithCustomError(arena, "NotPlayer");
    await arena.connect(alice).play(id, 3); // le wallet peut toujours jouer lui-même
  });

  it("refuse une clé déjà prise par un autre joueur, la sienne propre, ou une durée de plus de 30 jours", async () => {
    await expect(arena.connect(carol).openSession(ka.address, BUDGET, WEEK)).to.be.revertedWithCustomError(arena, "InvalidMove");
    await expect(arena.connect(carol).openSession(carol.address, BUDGET, WEEK)).to.be.revertedWithCustomError(arena, "InvalidMove");
    await expect(arena.connect(carol).openSession(ethers.Wallet.createRandom().address, BUDGET, 31 * 24 * 3600)).to.be.revertedWithCustomError(arena, "InvalidMove");
  });

  it("annulation par la clé : la mise revient au wallet du créateur", async () => {
    await arena.connect(ka).createMatchAsSession(MORPION, STAKE);
    const id = await arena.matchCount();
    const before = await usdc.balanceOf(alice.address);
    await arena.connect(ka).cancelMatch(id);
    expect(await usdc.balanceOf(alice.address)).to.equal(before + STAKE);
    expect(await usdc.balanceOf(ka.address)).to.equal(0n);
  });

  it("Pierre-Feuille-Ciseaux par les clés : l'empreinte reste liée au joueur", async () => {
    const id = await sessionMatch(PFC);
    const sa = ethers.id("sel-a"), sb = ethers.id("sel-b");
    await arena.connect(ka).commitPfc(id, await arena.pfcHash(id, 0, alice.address, PIERRE, sa));
    await arena.connect(kb).commitPfc(id, await arena.pfcHash(id, 0, bob.address, CISEAUX, sb));
    await arena.connect(ka).revealPfc(id, PIERRE, sa);
    await arena.connect(kb).revealPfc(id, CISEAUX, sb);
    expect((await arena.getMatch(id)).winner).to.equal(alice.address);
  });

  it("Duel de dés par les clés", async () => {
    const id = await sessionMatch(DES);
    const sa = ethers.id("a"), sb = ethers.id("b");
    await arena.connect(ka).commitDice(id, await arena.diceHash(id, 0, alice.address, sa));
    await arena.connect(kb).commitDice(id, await arena.diceHash(id, 0, bob.address, sb));
    await arena.connect(ka).revealDice(id, sa);
    await arena.connect(kb).revealDice(id, sb);
    const m = await arena.getMatch(id);
    expect(Number(m.status) === 2 || Number(m.moves) === 1).to.equal(true);
  });

  it("Bataille navale : placement et tirs par les clés", async () => {
    const id = await sessionMatch(NAVALE);
    const xs = [0, 0, 0, 0], ys = [0, 1, 2, 3], v = [false, false, false, false];
    const sa = ethers.id("na"), sb = ethers.id("nb");
    await arena.connect(ka).commitNavalBoard(id, await arena.navalHash(id, alice.address, xs, ys, v, sa));
    await arena.connect(kb).commitNavalBoard(id, await arena.navalHash(id, bob.address, xs, ys, v, sb));
    await arena.connect(kb).navalTurn(id, false, 0);
    await arena.connect(ka).navalTurn(id, true, 0);
    expect((await arena.naval(id)).hitsByOpponent).to.equal(1n);
    await arena.connect(kb).resign(id);
    expect((await arena.getMatch(id)).winner).to.equal(alice.address);
  });
});
