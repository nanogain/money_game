/* global ethers, APP_CONFIG, ACCOUNT_FACTORY_ABI, SIMPLE_ACCOUNT_ABI */
// Comptes de jeu ERC-4337 (EntryPoint v0.7) dont les frais sont payés par le paymaster de la
// plateforme (Coinbase CDP, ERC-7677). La clé de session du navigateur signe des « UserOperations »
// envoyées au bundler : le joueur n'a besoin d'aucun ETH.

const ENTRYPOINT_ABI = [
  "function getNonce(address sender, uint192 key) view returns (uint256)",
  "function getUserOpHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) op) view returns (bytes32)",
];
// Signature factice bien formée (d'une clé jetable), utilisée seulement pour estimer le gaz :
// le compte la juge invalide sans échouer, comme l'attendent les bundlers.
const DUMMY_SIG = new ethers.Wallet(ethers.id("arene-signature-factice")).signingKey.sign(ethers.id("estimation")).serialized;

const aaEnabled = () => !!(APP_CONFIG.paymasterUrl && APP_CONFIG.entryPoint && APP_CONFIG.accountFactory);
const hex = (v) => ethers.toBeHex(BigInt(v));
const pad16 = (v) => ethers.zeroPadValue(ethers.toBeHex(BigInt(v || 0)), 16);

let rpcId = 0;
async function bundlerCall(method, params) {
  const res = await fetch(APP_CONFIG.paymasterUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`Paymaster : ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

// Adresse du compte de jeu contrôlé par une clé (même avant sa création : adresse prévisible).
const accountCache = {};
async function gameAccountAddress(provider, ownerAddr) {
  if (accountCache[ownerAddr]) return accountCache[ownerAddr];
  const f = new ethers.Contract(APP_CONFIG.accountFactory, ACCOUNT_FACTORY_ABI, provider);
  return (accountCache[ownerAddr] = await f["getAddress(address,uint256)"](ownerAddr, 0));
}

function packOp(op) {
  return {
    sender: op.sender,
    nonce: op.nonce,
    initCode: op.factory ? ethers.concat([op.factory, op.factoryData]) : "0x",
    callData: op.callData,
    accountGasLimits: ethers.concat([pad16(op.verificationGasLimit), pad16(op.callGasLimit)]),
    preVerificationGas: op.preVerificationGas,
    gasFees: ethers.concat([pad16(op.maxPriorityFeePerGas), pad16(op.maxFeePerGas)]),
    paymasterAndData: op.paymaster
      ? ethers.concat([op.paymaster, pad16(op.paymasterVerificationGasLimit), pad16(op.paymasterPostOpGasLimit), op.paymasterData || "0x"])
      : "0x",
    signature: op.signature,
  };
}

const PM_FIELDS = ["paymaster", "paymasterData", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit"];
const GAS_FIELDS = ["callGasLimit", "verificationGasLimit", "preVerificationGas", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit"];

// Envoie des appels [{ to, data }] depuis le compte de jeu de `owner` (ethers.Wallet).
// Renvoie un objet { hash, wait() } comme une transaction ethers.
async function sendUserOp(provider, owner, calls) {
  const ep = new ethers.Contract(APP_CONFIG.entryPoint, ENTRYPOINT_ABI, provider);
  const sender = await gameAccountAddress(provider, owner.address);
  const acct = new ethers.Interface(SIMPLE_ACCOUNT_ABI);
  const factoryIface = new ethers.Interface(ACCOUNT_FACTORY_ABI);
  const [code, nonce, fee] = await Promise.all([provider.getCode(sender), ep.getNonce(sender, 0), provider.getFeeData()]);
  const callData = calls.length === 1
    ? acct.encodeFunctionData("execute", [calls[0].to, 0, calls[0].data])
    : acct.encodeFunctionData("executeBatch", [calls.map((c) => c.to), calls.map(() => 0), calls.map((c) => c.data)]);
  const priority = fee.maxPriorityFeePerGas ?? 1_000_000n;
  const op = {
    sender,
    nonce: hex(nonce),
    callData,
    maxFeePerGas: hex(((fee.maxFeePerGas ?? fee.gasPrice ?? 0n) * 3n) / 2n + priority),
    maxPriorityFeePerGas: hex(priority),
    callGasLimit: "0x0", verificationGasLimit: "0x0", preVerificationGas: "0x0",
    signature: DUMMY_SIG,
  };
  if (code === "0x") {
    op.factory = APP_CONFIG.accountFactory;
    op.factoryData = factoryIface.encodeFunctionData("createAccount", [owner.address, 0]);
  }
  const chain = hex(APP_CONFIG.chainId);
  const stub = await bundlerCall("pm_getPaymasterStubData", [op, APP_CONFIG.entryPoint, chain, {}]);
  for (const k of PM_FIELDS) if (stub[k] !== undefined) op[k] = stub[k];
  const est = await bundlerCall("eth_estimateUserOperationGas", [op, APP_CONFIG.entryPoint]);
  for (const k of GAS_FIELDS) if (est[k] !== undefined) op[k] = hex((BigInt(est[k]) * 12n) / 10n); // marge 20 %
  if (!stub.isFinal) {
    const data = await bundlerCall("pm_getPaymasterData", [op, APP_CONFIG.entryPoint, chain, {}]);
    for (const k of PM_FIELDS) if (data[k] !== undefined) op[k] = data[k];
  }
  const userOpHash = await ep.getUserOpHash(packOp(op));
  op.signature = await owner.signMessage(ethers.getBytes(userOpHash));
  const sent = await bundlerCall("eth_sendUserOperation", [op, APP_CONFIG.entryPoint]);
  const result = { hash: null, userOpHash: sent };
  result.wait = async () => {
    for (let i = 0; i < 90; i++) {
      const r = await bundlerCall("eth_getUserOperationReceipt", [sent]).catch(() => null);
      if (r) {
        result.hash = r.receipt?.transactionHash || null;
        if (!r.success) throw new Error(`Action refusée par le contrat${r.reason ? " : " + r.reason : ""}.`);
        return r;
      }
      await new Promise((ok) => setTimeout(ok, 1000));
    }
    throw new Error("Pas de confirmation après 90 s.");
  };
  return result;
}
