// Tests ajoutés par la revue de sécurité.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const PFC = 0, MORPION = 1;
const PIERRE = 1, CISEAUX = 3;
const STAKE = 10_000_000n; // 10 USDC
const TIMEOUT = 600;
const POT_NET = STAKE * 2n - (STAKE * 2n * 200n) / 10_000n;

describe("Revue de sécurité", function () {
  let usdc, arena, owner, alice, bob, carol;

  beforeEach(async () => {
    [owner, alice, bob, carol] = await ethers.getSigners();
    usdc = await (await ethers.getContractFactory("BlacklistUSDC")).deploy();
    arena = await (await ethers.getContractFactory("MiniJeuxArena")).deploy(await usdc.getAddress(), TIMEOUT);
    for (const s of [alice, bob, carol]) {
      await usdc.mint(s.address, 1000_000_000n);
      await usdc.connect(s).approve(await arena.getAddress(), ethers.MaxUint256);
    }
  });

  async function newMatch(game, stake = STAKE) {
    await arena.connect(alice).createMatch(game, stake);
    const id = await arena.matchCount();
    await arena.connect(bob).joinMatch(id);
    return id;
  }

  const salt = (n) => ethers.zeroPadValue(ethers.toBeHex(n), 32);
  async function commit(id, round, signer, move, n) {
    const h = await arena.pfcHash(id, round, signer.address, move, salt(n));
    await arena.connect(signer).commitPfc(id, h);
  }

  describe("empreinte nulle (blocage de partie)", () => {
    it("refuse une empreinte nulle", async () => {
      const id = await newMatch(PFC);
      await expect(arena.connect(bob).commitPfc(id, ethers.ZeroHash)).to.be.revertedWithCustomError(arena, "InvalidMove");
    });

    it("le joueur qui refuse de jouer ne peut plus repousser le délai", async () => {
      const id = await newMatch(PFC);
      await commit(id, 0, alice, PIERRE, 1);
      await time.increase(TIMEOUT - 10);
      await expect(arena.connect(bob).commitPfc(id, ethers.ZeroHash)).to.be.reverted;
      await time.increase(20);
      const before = await usdc.balanceOf(alice.address);
      await arena.connect(carol).claimTimeout(id);
      expect(await usdc.balanceOf(alice.address)).to.equal(before + POT_NET);
    });
  });

  describe("virement impossible vers un joueur", () => {
    it("match nul : l'autre joueur est quand même remboursé", async () => {
      const id = await newMatch(PFC);
      await usdc.setBlocked(alice.address, true);
      await time.increase(TIMEOUT + 1);
      const bobBefore = await usdc.balanceOf(bob.address);
      await expect(arena.claimTimeout(id)).to.emit(arena, "PaymentDeferred").withArgs(alice.address, STAKE);
      expect(await usdc.balanceOf(bob.address)).to.equal(bobBefore + STAKE);
      expect(await arena.owed(alice.address)).to.equal(STAKE);
    });

    it("le gagnant bloqué récupère ses gains vers une autre adresse", async () => {
      const id = await newMatch(MORPION);
      await usdc.setBlocked(bob.address, true);
      await arena.connect(bob).play(id, 0);
      await arena.connect(alice).play(id, 3);
      await arena.connect(bob).play(id, 1);
      await arena.connect(alice).play(id, 4);
      await arena.connect(bob).play(id, 2); // la partie se termine malgré le blocage
      expect((await arena.getMatch(id)).status).to.equal(2);
      expect(await arena.owed(bob.address)).to.equal(POT_NET);
      await expect(arena.connect(alice).withdraw(alice.address)).to.be.revertedWithCustomError(arena, "InvalidState");
      await arena.connect(bob).withdraw(carol.address);
      expect(await arena.owed(bob.address)).to.equal(0);
      expect(await usdc.balanceOf(carol.address)).to.equal(1000_000_000n + POT_NET);
      await expect(arena.connect(bob).withdraw(carol.address)).to.be.revertedWithCustomError(arena, "InvalidState");
    });

    it("le contrat garde exactement les mises en jeu + les frais + les sommes dues", async () => {
      const id = await newMatch(MORPION);
      await usdc.setBlocked(bob.address, true);
      await arena.connect(alice).resign(id);
      const held = await usdc.balanceOf(await arena.getAddress());
      expect(held).to.equal((await arena.feesAccrued()) + (await arena.owed(bob.address)));
    });
  });

  describe("mise minimale", () => {
    it("refuse une mise trop petite pour payer les frais", async () => {
      await expect(arena.connect(alice).createMatch(MORPION, 0)).to.be.revertedWithCustomError(arena, "StakeTooLow");
      await expect(arena.connect(alice).createMatch(MORPION, 9_999)).to.be.revertedWithCustomError(arena, "StakeTooLow");
      const id = await newMatch(MORPION, 10_000n);
      await arena.connect(alice).resign(id);
      expect(await arena.feesAccrued()).to.equal(400n);
    });
  });

  describe("propriétaire", () => {
    it("le transfert de propriété doit être accepté par la nouvelle adresse", async () => {
      await arena.transferOwnership(carol.address);
      expect(await arena.owner()).to.equal(owner.address);
      await expect(arena.connect(bob).acceptOwnership()).to.be.revertedWithCustomError(arena, "OwnableUnauthorizedAccount");
      await arena.connect(carol).acceptOwnership();
      expect(await arena.owner()).to.equal(carol.address);
    });

    it("on ne peut pas renoncer à la propriété (frais bloqués)", async () => {
      await expect(arena.renounceOwnership()).to.be.revertedWithCustomError(arena, "InvalidState");
    });

    it("le propriétaire ne peut prendre que les frais, jamais les mises", async () => {
      await newMatch(MORPION);
      await arena.withdrawFees(owner.address);
      expect(await usdc.balanceOf(owner.address)).to.equal(0);
      expect(await usdc.balanceOf(await arena.getAddress())).to.equal(STAKE * 2n);
    });
  });

  describe("empreinte Pierre-Feuille-Ciseaux", () => {
    it("liée au contrat et au réseau, et identique au calcul du navigateur", async () => {
      const id = 1n, round = 0, move = CISEAUX, s = salt(42);
      const onChain = await arena.pfcHash(id, round, alice.address, move, s);
      const { chainId } = await ethers.provider.getNetwork();
      const local = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256", "uint256", "uint8", "address", "uint8", "bytes32"],
        [await arena.getAddress(), chainId, id, round, alice.address, move, s]));
      expect(onChain).to.equal(local);
      const other = await (await ethers.getContractFactory("MiniJeuxArena")).deploy(await usdc.getAddress(), TIMEOUT);
      expect(await other.pfcHash(id, round, alice.address, move, s)).to.not.equal(onChain);
    });

    it("trop de manches nulles : match nul et remboursement", async () => {
      this.timeout(120_000);
      const id = await newMatch(PFC);
      const a0 = await usdc.balanceOf(alice.address);
      const b0 = await usdc.balanceOf(bob.address);
      const max = Number(await arena.MAX_PFC_ROUNDS());
      for (let r = 0; r < max; r++) {
        await commit(id, r, alice, PIERRE, 2 * r + 1);
        await commit(id, r, bob, PIERRE, 2 * r + 2);
        await arena.connect(alice).revealPfc(id, PIERRE, salt(2 * r + 1));
        await arena.connect(bob).revealPfc(id, PIERRE, salt(2 * r + 2));
      }
      const m = await arena.getMatch(id);
      expect(m.status).to.equal(2);
      expect(m.winner).to.equal(ethers.ZeroAddress);
      expect(await usdc.balanceOf(alice.address)).to.equal(a0 + STAKE);
      expect(await usdc.balanceOf(bob.address)).to.equal(b0 + STAKE);
    });
  });
});
