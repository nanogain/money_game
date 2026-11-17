const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DES = 3, NAVALE = 4;
const STAKE = 10_000_000n;
const TIMEOUT = 600;
const coder = ethers.AbiCoder.defaultAbiCoder();

describe("Nouveaux jeux", function () {
  let usdc, arena, alice, bob, carol, chainId, arenaAddr;

  beforeEach(async () => {
    [, alice, bob, carol] = await ethers.getSigners();
    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    arena = await (await ethers.getContractFactory("MiniJeuxArena")).deploy(await usdc.getAddress(), TIMEOUT);
    arenaAddr = await arena.getAddress();
    chainId = (await ethers.provider.getNetwork()).chainId;
    for (const s of [alice, bob, carol]) {
      await usdc.connect(s).faucet(1000_000_000n);
      await usdc.connect(s).approve(arenaAddr, ethers.MaxUint256);
    }
  });

  async function newMatch(game) {
    await arena.connect(alice).createMatch(game, STAKE);
    const id = await arena.matchCount();
    await arena.connect(bob).joinMatch(id);
    return id;
  }
  const bal = (s) => usdc.balanceOf(s.address);
  const POT_NET = STAKE * 2n - (STAKE * 2n * 200n) / 10_000n;

  // ---------------------------------------------------------------- dés
  describe("duel de dés", () => {
    // Même calcul que le navigateur : l'empreinte ne passe jamais par le nœud RPC.
    const diceHashLocal = (id, round, player, secret) =>
      ethers.keccak256(coder.encode(["string", "address", "uint256", "uint256", "uint8", "address", "bytes32"],
        ["des", arenaAddr, chainId, id, round, player, secret]));
    const sec = (n) => ethers.zeroPadValue(ethers.toBeHex(n), 32);

    it("l'empreinte calculée localement est identique à celle du contrat", async () => {
      expect(diceHashLocal(1, 0, alice.address, sec(7))).to.equal(await arena.diceHash(1, 0, alice.address, sec(7)));
    });

    it("le plus haut dé gagne, l'égalité relance", async () => {
      const id = await newMatch(DES);
      let n = 1;
      for (let guard = 0; guard < 20; guard++) {
        const round = (await arena.getMatch(id)).moves;
        const a = sec(n++), b = sec(n++);
        await arena.connect(alice).commitDice(id, diceHashLocal(id, round, alice.address, a));
        await arena.connect(bob).commitDice(id, diceHashLocal(id, round, bob.address, b));
        await arena.connect(alice).revealDice(id, a);
        const tx = await arena.connect(bob).revealDice(id, b);
        const rc = await tx.wait();
        const ev = rc.logs.map((l) => { try { return arena.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "DiceRolled");
        const [dA, dB] = [Number(ev.args.dieCreator), Number(ev.args.dieOpponent)];
        expect(dA).to.be.within(1, 6);
        expect(dB).to.be.within(1, 6);
        const m = await arena.getMatch(id);
        if (dA === dB) {
          expect(m.status).to.equal(1);
          expect(m.moves).to.equal(round + 1n);
          continue;
        }
        expect(m.status).to.equal(2);
        expect(m.winner).to.equal(dA > dB ? alice.address : bob.address);
        return;
      }
      throw new Error("trop d'égalités");
    });

    it("refuse une empreinte nulle et un mauvais secret", async () => {
      const id = await newMatch(DES);
      await expect(arena.connect(alice).commitDice(id, ethers.ZeroHash)).to.be.revertedWithCustomError(arena, "InvalidMove");
      await arena.connect(alice).commitDice(id, diceHashLocal(id, 0, alice.address, sec(1)));
      await arena.connect(bob).commitDice(id, diceHashLocal(id, 0, bob.address, sec(2)));
      await expect(arena.connect(alice).revealDice(id, sec(99))).to.be.revertedWithCustomError(arena, "InvalidMove");
    });

    it("celui qui ne révèle pas perd après le délai", async () => {
      const id = await newMatch(DES);
      await arena.connect(alice).commitDice(id, diceHashLocal(id, 0, alice.address, sec(1)));
      await arena.connect(bob).commitDice(id, diceHashLocal(id, 0, bob.address, sec(2)));
      await arena.connect(alice).revealDice(id, sec(1));
      await time.increase(TIMEOUT + 1);
      await arena.connect(carol).claimTimeout(id);
      expect((await arena.getMatch(id)).winner).to.equal(alice.address);
    });

    it("dés refusés par play() et inversement", async () => {
      const id = await newMatch(DES);
      await expect(arena.connect(bob).play(id, 0)).to.be.revertedWithCustomError(arena, "InvalidState");
    });
  });

  // ---------------------------------------------------------------- bataille navale
  describe("bataille navale", () => {
    // Flotte A : lignes 0..3 depuis la colonne 0 (horizontaux) ; flotte B : colonnes 0..3 depuis la ligne 0 (verticaux)
    const FLEET_H = { xs: [0, 0, 0, 0], ys: [0, 1, 2, 3], v: [false, false, false, false] };
    const FLEET_V = { xs: [0, 1, 2, 3], ys: [0, 0, 0, 0], v: [true, true, true, true] };
    const cellsOf = (f) => {
      const sizes = [4, 3, 3, 2], out = [];
      for (let s = 0; s < 4; s++) for (let k = 0; k < sizes[s]; k++) out.push(f.v[s] ? (f.ys[s] + k) * 8 + f.xs[s] : f.ys[s] * 8 + f.xs[s] + k);
      return out;
    };
    const SALT_A = ethers.zeroPadValue("0xaa", 32), SALT_B = ethers.zeroPadValue("0xbb", 32);
    const navalHashLocal = (id, player, f, salt) =>
      ethers.keccak256(coder.encode(["string", "address", "uint256", "uint256", "address", "uint8[4]", "uint8[4]", "bool[4]", "bytes32"],
        ["navale", arenaAddr, chainId, id, player, f.xs, f.ys, f.v, salt]));

    async function setup(fa = FLEET_H, fb = FLEET_V) {
      const id = await newMatch(NAVALE);
      await arena.connect(alice).commitNavalBoard(id, navalHashLocal(id, alice.address, fa, SALT_A));
      await arena.connect(bob).commitNavalBoard(id, navalHashLocal(id, bob.address, fb, SALT_B));
      return id;
    }

    // Joue une partie où chacun répond honnêtement (sauf `liar`, qui annonce toujours « raté »).
    async function playOut(id, shotsBob, shotsAlice, fa = FLEET_H, fb = FLEET_V, liar = null) {
      const boardA = new Set(cellsOf(fa)), boardB = new Set(cellsOf(fb));
      let lastShotAtA = null, lastShotAtB = null;
      let i = 0, j = 0;
      for (let turn = 0; turn < 200; turn++) {
        const n = await arena.naval(id);
        if (n.phase !== 1n) return;
        const m = await arena.getMatch(id);
        if (m.turn === bob.address) {
          const hit = lastShotAtB !== null && boardB.has(lastShotAtB) && liar !== bob;
          const cell = shotsBob[i++] ?? 0; // plateau entièrement visé : le contrat ignore le tir
          await arena.connect(bob).navalTurn(id, hit, cell);
          lastShotAtA = cell;
        } else {
          const hit = lastShotAtA !== null && boardA.has(lastShotAtA) && liar !== alice;
          const cell = shotsAlice[j++] ?? 0;
          await arena.connect(alice).navalTurn(id, hit, cell);
          lastShotAtB = cell;
        }
      }
    }

    it("l'empreinte calculée localement est identique à celle du contrat", async () => {
      expect(navalHashLocal(5, bob.address, FLEET_V, SALT_B)).to.equal(await arena.navalHash(5, bob.address, FLEET_V.xs, FLEET_V.ys, FLEET_V.v, SALT_B));
    });

    it("couler toute la flotte puis révéler : le vainqueur reçoit le pot moins 2 %", async () => {
      const id = await setup();
      // Bob vise exactement la flotte d'Alice, Alice tire dans le vide (lignes du bas)
      const shotsBob = cellsOf(FLEET_H);
      const shotsAlice = Array.from({ length: 64 }, (_, k) => 63 - k);
      await playOut(id, shotsBob, shotsAlice);
      const n = await arena.naval(id);
      expect(n.phase).to.equal(2);
      const b0 = await bal(bob);
      await arena.connect(bob).revealNavalBoard(id, FLEET_V.xs, FLEET_V.ys, FLEET_V.v, SALT_B);
      expect((await arena.getMatch(id)).status).to.equal(1); // attend la révélation d'Alice
      await arena.connect(alice).revealNavalBoard(id, FLEET_H.xs, FLEET_H.ys, FLEET_H.v, SALT_A);
      const m = await arena.getMatch(id);
      expect(m.winner).to.equal(bob.address);
      expect(await bal(bob)).to.equal(b0 + POT_NET);
    });

    it("refuse les tirs hors tour, hors plateau ou en double", async () => {
      const id = await setup();
      await expect(arena.connect(alice).navalTurn(id, false, 0)).to.be.revertedWithCustomError(arena, "NotYourTurn");
      await expect(arena.connect(bob).navalTurn(id, false, 64)).to.be.revertedWithCustomError(arena, "InvalidMove");
      await arena.connect(bob).navalTurn(id, false, 10);
      await arena.connect(alice).navalTurn(id, false, 20);
      await expect(arena.connect(bob).navalTurn(id, false, 10)).to.be.revertedWithCustomError(arena, "InvalidMove");
    });

    it("pas de tir avant que les deux plateaux soient engagés, empreinte nulle refusée", async () => {
      const id = await newMatch(NAVALE);
      await expect(arena.connect(alice).commitNavalBoard(id, ethers.ZeroHash)).to.be.revertedWithCustomError(arena, "InvalidMove");
      await arena.connect(alice).commitNavalBoard(id, navalHashLocal(id, alice.address, FLEET_H, SALT_A));
      await expect(arena.connect(bob).navalTurn(id, false, 0)).to.be.revertedWithCustomError(arena, "InvalidState");
    });

    it("un menteur (qui annonce toujours « raté ») est démasqué à la révélation et perd", async () => {
      const id = await setup();
      const all = Array.from({ length: 64 }, (_, k) => k);
      // Alice ment : Bob vise tout le plateau, la partie passe en révélation quand il a tout visé
      await playOut(id, all, all.slice().reverse(), FLEET_H, FLEET_V, alice);
      expect((await arena.naval(id)).phase).to.equal(2);
      await arena.connect(alice).revealNavalBoard(id, FLEET_H.xs, FLEET_H.ys, FLEET_H.v, SALT_A);
      const m = await arena.getMatch(id);
      expect(m.status).to.equal(2);
      expect(m.winner).to.equal(bob.address);
    });

    it("une flotte invalide (bateaux superposés) est considérée comme triche", async () => {
      const bad = { xs: [0, 0, 0, 0], ys: [0, 0, 2, 3], v: [false, false, false, false] };
      const id = await setup(bad, FLEET_V);
      const shotsBob = Array.from({ length: 64 }, (_, k) => 63 - k);
      const shotsAlice = cellsOf(FLEET_V);
      await playOut(id, shotsBob, shotsAlice, bad, FLEET_V);
      expect((await arena.naval(id)).phase).to.equal(2);
      await arena.connect(alice).revealNavalBoard(id, bad.xs, bad.ys, bad.v, SALT_A);
      expect((await arena.getMatch(id)).winner).to.equal(bob.address);
    });

    it("mauvais sel à la révélation : refusé, on peut réessayer", async () => {
      const id = await setup();
      await playOut(id, cellsOf(FLEET_H), Array.from({ length: 64 }, (_, k) => 63 - k));
      await expect(arena.connect(alice).revealNavalBoard(id, FLEET_H.xs, FLEET_H.ys, FLEET_H.v, SALT_B)).to.be.revertedWithCustomError(arena, "InvalidMove");
      await arena.connect(alice).revealNavalBoard(id, FLEET_H.xs, FLEET_H.ys, FLEET_H.v, SALT_A);
    });

    it("délais : joueur inactif au combat, et vainqueur honnête si l'autre ne révèle pas", async () => {
      let id = await setup();
      await arena.connect(bob).navalTurn(id, false, 0);
      await time.increase(TIMEOUT + 1);
      await arena.claimTimeout(id);
      expect((await arena.getMatch(id)).winner).to.equal(bob.address);

      id = await setup();
      await playOut(id, cellsOf(FLEET_H), Array.from({ length: 64 }, (_, k) => 63 - k));
      await arena.connect(bob).revealNavalBoard(id, FLEET_V.xs, FLEET_V.ys, FLEET_V.v, SALT_B);
      await time.increase(TIMEOUT + 1);
      await arena.claimTimeout(id);
      expect((await arena.getMatch(id)).winner).to.equal(bob.address);
    });

    it("placement : celui qui a engagé son plateau gagne si l'autre ne le fait pas", async () => {
      const id = await newMatch(NAVALE);
      await arena.connect(bob).commitNavalBoard(id, navalHashLocal(id, bob.address, FLEET_V, SALT_B));
      await time.increase(TIMEOUT + 1);
      await arena.claimTimeout(id);
      expect((await arena.getMatch(id)).winner).to.equal(bob.address);
    });
  });
});
