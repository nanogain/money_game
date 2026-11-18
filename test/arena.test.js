const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const PFC = 0, MORPION = 1, P4 = 2;
const PIERRE = 1, FEUILLE = 2, CISEAUX = 3;
const STAKE = 10_000_000n; // 10 USDC
const TIMEOUT = 600;

describe("MiniJeuxArena", function () {
  let usdc, arena, owner, alice, bob, carol;

  beforeEach(async () => {
    [owner, alice, bob, carol] = await ethers.getSigners();
    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    arena = await (await ethers.getContractFactory("MiniJeuxArena")).deploy(await usdc.getAddress(), TIMEOUT);
    for (const s of [alice, bob, carol]) {
      await usdc.connect(s).faucet(1000_000_000n);
      await usdc.connect(s).approve(await arena.getAddress(), ethers.MaxUint256);
    }
  });

  async function newMatch(game) {
    await arena.connect(alice).createMatch(game, STAKE);
    const id = await arena.matchCount();
    await arena.connect(bob).joinMatch(id);
    return id;
  }

  const bal = (s) => usdc.balanceOf(s.address);
  const POT_NET = STAKE * 2n - (STAKE * 2n * 200n) / 10_000n; // 19,6 USDC

  describe("annonces", () => {
    it("crée, accepte et bloque les mises", async () => {
      await arena.connect(alice).createMatch(MORPION, STAKE);
      expect(await usdc.balanceOf(await arena.getAddress())).to.equal(STAKE);
      await arena.connect(bob).joinMatch(1);
      expect(await usdc.balanceOf(await arena.getAddress())).to.equal(STAKE * 2n);
      const m = await arena.getMatch(1);
      expect(m.status).to.equal(1);
      expect(m.turn).to.equal(bob.address);
    });

    it("annulation remboursée seulement si personne n'a accepté", async () => {
      const before = await bal(alice);
      await arena.connect(alice).createMatch(MORPION, STAKE);
      await expect(arena.connect(bob).cancelMatch(1)).to.be.revertedWithCustomError(arena, "NotPlayer");
      await arena.connect(alice).cancelMatch(1);
      expect(await bal(alice)).to.equal(before);
      await expect(arena.connect(bob).joinMatch(1)).to.be.revertedWithCustomError(arena, "InvalidState");
    });

    it("on ne peut pas accepter sa propre annonce ni une partie déjà prise", async () => {
      await arena.connect(alice).createMatch(P4, STAKE);
      await expect(arena.connect(alice).joinMatch(1)).to.be.revertedWithCustomError(arena, "NotPlayer");
      await arena.connect(bob).joinMatch(1);
      await expect(arena.connect(carol).joinMatch(1)).to.be.revertedWithCustomError(arena, "InvalidState");
    });

    it("liste les parties", async () => {
      await arena.connect(alice).createMatch(PFC, STAKE);
      await arena.connect(alice).createMatch(P4, STAKE * 2n);
      const list = await arena.getMatches(1, 50);
      expect(list.length).to.equal(2);
      expect(list[1].stake).to.equal(STAKE * 2n);
    });
  });

  describe("morpion", () => {
    it("le vainqueur reçoit le pot moins 2 %", async () => {
      const id = await newMatch(MORPION);
      const before = await bal(bob);
      // bob (X) : 0,1,2 ; alice : 3,4
      await arena.connect(bob).play(id, 0);
      await arena.connect(alice).play(id, 3);
      await arena.connect(bob).play(id, 1);
      await arena.connect(alice).play(id, 4);
      await expect(arena.connect(bob).play(id, 2)).to.emit(arena, "MatchFinished").withArgs(id, bob.address, POT_NET, 400_000n);
      expect(await bal(bob)).to.equal(before + POT_NET);
      // les 2 % arrivent automatiquement sur l'adresse de réception (le propriétaire par défaut)
      expect(await usdc.balanceOf(owner.address)).to.equal(400_000n);
      expect(await arena.feesAccrued()).to.equal(0n);
    });

    it("refuse les coups hors tour, case prise ou hors plateau", async () => {
      const id = await newMatch(MORPION);
      await expect(arena.connect(alice).play(id, 0)).to.be.revertedWithCustomError(arena, "NotYourTurn");
      await arena.connect(bob).play(id, 4);
      await expect(arena.connect(alice).play(id, 4)).to.be.revertedWithCustomError(arena, "InvalidMove");
      await expect(arena.connect(alice).play(id, 9)).to.be.revertedWithCustomError(arena, "InvalidMove");
      await expect(arena.connect(carol).play(id, 1)).to.be.revertedWithCustomError(arena, "NotYourTurn");
    });

    it("match nul : chacun est remboursé, pas de frais", async () => {
      const id = await newMatch(MORPION);
      const a0 = await bal(alice), b0 = await bal(bob);
      // X=bob O=alice -> X O X / X O O / O X X
      const seq = [[bob, 0], [alice, 1], [bob, 2], [alice, 4], [bob, 3], [alice, 5], [bob, 7], [alice, 6], [bob, 8]];
      for (const [p, c] of seq) await arena.connect(p).play(id, c);
      const m = await arena.getMatch(id);
      expect(m.status).to.equal(2);
      expect(m.winner).to.equal(ethers.ZeroAddress);
      expect(await bal(alice)).to.equal(a0 + STAKE);
      expect(await bal(bob)).to.equal(b0 + STAKE);
      expect(await arena.feesAccrued()).to.equal(0);
    });
  });

  describe("puissance 4", () => {
    it("victoire verticale", async () => {
      const id = await newMatch(P4);
      for (let i = 0; i < 3; i++) {
        await arena.connect(bob).play(id, 3);
        await arena.connect(alice).play(id, 4);
      }
      await arena.connect(bob).play(id, 3);
      expect((await arena.getMatch(id)).winner).to.equal(bob.address);
    });

    it("victoire en diagonale", async () => {
      const id = await newMatch(P4);
      // bob vise la diagonale (0,0) (1,1) (2,2) (3,3)
      const seq = [[bob, 0], [alice, 1], [bob, 1], [alice, 2], [bob, 2], [alice, 3], [bob, 2], [alice, 3], [bob, 3], [alice, 6]];
      for (const [p, c] of seq) await arena.connect(p).play(id, c);
      expect((await arena.getMatch(id)).status).to.equal(1);
      await arena.connect(bob).play(id, 3);
      expect((await arena.getMatch(id)).winner).to.equal(bob.address);
    });

    it("victoire horizontale par le créateur", async () => {
      const id = await newMatch(P4);
      const seq = [[bob, 0], [alice, 1], [bob, 0], [alice, 2], [bob, 0], [alice, 3], [bob, 6]];
      for (const [p, c] of seq) await arena.connect(p).play(id, c);
      await arena.connect(alice).play(id, 4);
      expect((await arena.getMatch(id)).winner).to.equal(alice.address);
    });

    it("refuse une colonne pleine", async () => {
      const id = await newMatch(P4);
      for (let i = 0; i < 3; i++) {
        await arena.connect(bob).play(id, 0);
        await arena.connect(alice).play(id, 0);
      }
      await expect(arena.connect(bob).play(id, 0)).to.be.revertedWithCustomError(arena, "InvalidMove");
      await expect(arena.connect(bob).play(id, 7)).to.be.revertedWithCustomError(arena, "InvalidMove");
    });
  });

  describe("pierre-feuille-ciseaux", () => {
    const salt = (n) => ethers.zeroPadValue(ethers.toBeHex(n), 32);
    async function commit(id, s, move, n) {
      const round = (await arena.getMatch(id)).moves;
      const h = await arena.pfcHash(id, round, s.address, move, salt(n));
      await arena.connect(s).commitPfc(id, h);
    }

    it("pierre bat ciseaux", async () => {
      const id = await newMatch(PFC);
      await commit(id, alice, PIERRE, 1);
      await commit(id, bob, CISEAUX, 2);
      await arena.connect(alice).revealPfc(id, PIERRE, salt(1));
      await arena.connect(bob).revealPfc(id, CISEAUX, salt(2));
      expect((await arena.getMatch(id)).winner).to.equal(alice.address);
    });

    it("on ne peut pas révéler un autre coup que celui engagé", async () => {
      const id = await newMatch(PFC);
      await commit(id, alice, PIERRE, 1);
      await commit(id, bob, CISEAUX, 2);
      await expect(arena.connect(alice).revealPfc(id, FEUILLE, salt(1))).to.be.revertedWithCustomError(arena, "InvalidMove");
      await expect(arena.connect(alice).revealPfc(id, PIERRE, salt(9))).to.be.revertedWithCustomError(arena, "InvalidMove");
    });

    it("pas de révélation avant que les deux aient joué", async () => {
      const id = await newMatch(PFC);
      await commit(id, alice, PIERRE, 1);
      await expect(arena.connect(alice).revealPfc(id, PIERRE, salt(1))).to.be.revertedWithCustomError(arena, "InvalidState");
    });

    it("égalité : nouvelle manche, puis victoire", async () => {
      const id = await newMatch(PFC);
      await commit(id, alice, FEUILLE, 1);
      await commit(id, bob, FEUILLE, 2);
      await arena.connect(alice).revealPfc(id, FEUILLE, salt(1));
      await expect(arena.connect(bob).revealPfc(id, FEUILLE, salt(2))).to.emit(arena, "PfcRoundDraw");
      expect((await arena.getMatch(id)).moves).to.equal(1);
      await commit(id, alice, FEUILLE, 3);
      await commit(id, bob, CISEAUX, 4);
      await arena.connect(bob).revealPfc(id, CISEAUX, salt(4));
      await arena.connect(alice).revealPfc(id, FEUILLE, salt(3));
      expect((await arena.getMatch(id)).winner).to.equal(bob.address);
    });

    it("joueur qui ne révèle pas : l'autre gagne après le délai", async () => {
      const id = await newMatch(PFC);
      await commit(id, alice, PIERRE, 1);
      await commit(id, bob, CISEAUX, 2);
      await arena.connect(bob).revealPfc(id, CISEAUX, salt(2));
      await expect(arena.claimTimeout(id)).to.be.revertedWithCustomError(arena, "TooEarly");
      await time.increase(TIMEOUT + 1);
      await arena.connect(carol).claimTimeout(id);
      expect((await arena.getMatch(id)).winner).to.equal(bob.address);
    });

    it("personne ne joue : remboursement", async () => {
      const id = await newMatch(PFC);
      const a0 = await bal(alice);
      await time.increase(TIMEOUT + 1);
      await arena.claimTimeout(id);
      expect(await bal(alice)).to.equal(a0 + STAKE);
    });
  });

  describe("abandon et délai", () => {
    it("joueur inactif au plateau : il perd", async () => {
      const id = await newMatch(MORPION);
      await arena.connect(bob).play(id, 4);
      await time.increase(TIMEOUT + 1);
      await arena.claimTimeout(id);
      expect((await arena.getMatch(id)).winner).to.equal(bob.address);
    });

    it("abandon", async () => {
      const id = await newMatch(P4);
      await expect(arena.connect(carol).resign(id)).to.be.revertedWithCustomError(arena, "NotPlayer");
      await arena.connect(bob).resign(id);
      expect((await arena.getMatch(id)).winner).to.equal(alice.address);
    });

    it("seul le propriétaire retire les frais", async () => {
      await expect(arena.connect(alice).withdrawFees(alice.address)).to.be.revertedWithCustomError(arena, "OwnableUnauthorizedAccount");
    });
  });
});
