// Clés de session : les coups partent sans fenêtre de confirmation du wallet.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const PFC = 0, MORPION = 1, DES = 3, NAVALE = 4;
const PIERRE = 1, CISEAUX = 3;
const STAKE = 10_000_000n;
const TIMEOUT = 600;
const POT_NET = STAKE * 2n - (STAKE * 2n * 200n) / 10_000n;
const GAS = ethers.parseEther("0.01");

describe("Clés de session", function () {
  let usdc, arena, owner, alice, bob, carol, ka, kb;

  beforeEach(async () => {
    [owner, alice, bob, carol] = await ethers.getSigners();
    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    arena = await (await ethers.getContractFactory("MiniJeuxArena")).deploy(await usdc.getAddress(), TIMEOUT);
    for (const s of [alice, bob, carol]) {
      await usdc.connect(s).faucet(1000_000_000n);
      await usdc.connect(s).approve(await arena.getAddress(), ethers.MaxUint256);
    }
    // Clés jetables, comme celles générées dans le navigateur (sans ETH au départ).
    ka = ethers.Wallet.createRandom().connect(ethers.provider);
    kb = ethers.Wallet.createRandom().connect(ethers.provider);
  });

  async function sessionMatch(game) {
    await arena.connect(alice).createMatchWithSession(game, STAKE, ka.address, { value: GAS });
    const id = await arena.matchCount();
    await arena.connect(bob).joinMatchWithSession(id, kb.address, { value: GAS });
    return id;
  }

  it("une seule transaction : mise déposée, clé autorisée et approvisionnée en ETH", async () => {
    const id = await sessionMatch(MORPION);
    const k = await arena.sessionKeys(id);
    expect(k.creator).to.equal(ka.address);
    expect(k.opponent).to.equal(kb.address);
    expect(await ethers.provider.getBalance(ka.address)).to.equal(GAS);
    expect(await ethers.provider.getBalance(kb.address)).to.equal(GAS);
    expect(await usdc.balanceOf(await arena.getAddress())).to.equal(STAKE * 2n);
  });

  it("Morpion joué entièrement par les clés : le gain va au wallet du joueur", async () => {
    const id = await sessionMatch(MORPION);
    const before = await usdc.balanceOf(bob.address);
    // bob (accepteur) commence : X en 0, 1, 2
    await arena.connect(kb).play(id, 0);
    await arena.connect(ka).play(id, 3);
    await arena.connect(kb).play(id, 1);
    await arena.connect(ka).play(id, 4);
    await arena.connect(kb).play(id, 2);
    const m = await arena.getMatch(id);
    expect(m.winner).to.equal(bob.address);
    expect(await usdc.balanceOf(bob.address)).to.equal(before + POT_NET);
    expect(await usdc.balanceOf(kb.address)).to.equal(0n);
  });

  it("le wallet principal peut toujours jouer lui-même", async () => {
    const id = await sessionMatch(MORPION);
    await arena.connect(bob).play(id, 0);
    await arena.connect(ka).play(id, 3);
    expect((await arena.getMatch(id)).moves).to.equal(2);
  });

  it("une clé ne joue pas au tour de l'adversaire, ni dans une autre partie", async () => {
    const id = await sessionMatch(MORPION);
    await expect(arena.connect(ka).play(id, 0)).to.be.revertedWithCustomError(arena, "NotYourTurn");
    await arena.connect(carol).createMatch(MORPION, STAKE);
    const other = await arena.matchCount();
    await arena.connect(alice).joinMatch(other);
    // ka est la clé d'alice dans la partie `id`, pas dans `other`
    await expect(arena.connect(ka).play(other, 0)).to.be.revertedWithCustomError(arena, "NotYourTurn");
    await expect(arena.connect(ka).resign(other)).to.be.revertedWithCustomError(arena, "NotPlayer");
  });

  it("une clé ne peut ni retirer de fonds ni changer de clé", async () => {
    const id = await sessionMatch(MORPION);
    await expect(arena.connect(ka).withdraw(ka.address)).to.be.revertedWithCustomError(arena, "InvalidState");
    await expect(arena.connect(ka).setSessionKey(id, ka.address)).to.be.revertedWithCustomError(arena, "NotPlayer");
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
    // égalité possible : alors nouvelle manche, sinon partie terminée
    expect(Number(m.status) === 2 || Number(m.moves) === 1).to.equal(true);
  });

  it("Bataille navale : placement, tir et révélation par les clés", async () => {
    const id = await sessionMatch(NAVALE);
    const xs = [0, 0, 0, 0], ys = [0, 1, 2, 3], v = [false, false, false, false];
    const sa = ethers.id("na"), sb = ethers.id("nb");
    await arena.connect(ka).commitNavalBoard(id, await arena.navalHash(id, alice.address, xs, ys, v, sa));
    await arena.connect(kb).commitNavalBoard(id, await arena.navalHash(id, bob.address, xs, ys, v, sb));
    await arena.connect(kb).navalTurn(id, false, 0); // bob tire en A1
    await arena.connect(ka).navalTurn(id, true, 0); // alice : touché, tire en A1
    expect((await arena.naval(id)).hitsByOpponent).to.equal(1n);
    await arena.connect(kb).resign(id);
    expect((await arena.getMatch(id)).winner).to.equal(alice.address);
  });

  it("annulation d'annonce par la clé : la mise revient au créateur", async () => {
    await arena.connect(alice).createMatchWithSession(MORPION, STAKE, ka.address, { value: GAS });
    const id = await arena.matchCount();
    const before = await usdc.balanceOf(alice.address);
    await arena.connect(ka).cancelMatch(id);
    expect(await usdc.balanceOf(alice.address)).to.equal(before + STAKE);
  });

  it("changer de clé (nouveau navigateur) : l'ancienne ne marche plus", async () => {
    const id = await sessionMatch(MORPION);
    const kb2 = ethers.Wallet.createRandom().connect(ethers.provider);
    await arena.connect(bob).setSessionKey(id, kb2.address, { value: GAS });
    await expect(arena.connect(kb).play(id, 0)).to.be.revertedWithCustomError(arena, "NotYourTurn");
    await arena.connect(kb2).play(id, 0);
    expect((await arena.getMatch(id)).moves).to.equal(1);
  });

  it("refuse une clé qui se confond avec un joueur ou la clé adverse", async () => {
    await arena.connect(alice).createMatchWithSession(MORPION, STAKE, ka.address);
    const id = await arena.matchCount();
    await expect(arena.connect(bob).joinMatchWithSession(id, ka.address)).to.be.revertedWithCustomError(arena, "InvalidMove");
    await expect(arena.connect(bob).joinMatchWithSession(id, alice.address)).to.be.revertedWithCustomError(arena, "InvalidMove");
    await expect(arena.connect(bob).joinMatchWithSession(id, bob.address)).to.be.revertedWithCustomError(arena, "InvalidMove");
    await expect(arena.connect(alice).createMatchWithSession(MORPION, STAKE, alice.address)).to.be.revertedWithCustomError(arena, "InvalidMove");
  });

  it("la clé du créateur ne peut pas accepter l'annonce elle-même", async () => {
    await arena.connect(alice).createMatchWithSession(MORPION, STAKE, carol.address);
    const id = await arena.matchCount();
    await expect(arena.connect(carol).joinMatch(id)).to.be.revertedWithCustomError(arena, "NotPlayer");
  });

  it("refuse d'envoyer de l'ETH sans clé", async () => {
    await expect(arena.connect(alice).createMatchWithSession(MORPION, STAKE, ethers.ZeroAddress, { value: GAS }))
      .to.be.revertedWithCustomError(arena, "InvalidMove");
  });

  it("délai dépassé : la clé n'a pas de privilège particulier, le joueur absent perd", async () => {
    const id = await sessionMatch(MORPION);
    await time.increase(TIMEOUT + 1);
    const before = await usdc.balanceOf(alice.address);
    await arena.connect(ka).claimTimeout(id);
    expect(await usdc.balanceOf(alice.address)).to.equal(before + POT_NET);
  });
});
