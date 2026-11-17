// FAUX bundler + paymaster ERC-4337 pour les essais LOCAUX (remplace Coinbase CDP).
// Usage : node scripts/mock-bundler.js  (après `npm run node` et `npm run deploy:local`)
// Il accepte les UserOperations du site et les exécute via EntryPoint.handleOps.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const src = fs.readFileSync(path.join(__dirname, "..", "frontend", "config.js"), "utf8");
const cfg = JSON.parse(src.slice(src.indexOf("{"), src.lastIndexOf("}") + 1))["31337"];
const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
const EP_ABI = [
  "function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops, address beneficiary)",
  "function getUserOpHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) op) view returns (bytes32)",
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
  "event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)",
];
const pad16 = (v) => ethers.zeroPadValue(ethers.toBeHex(BigInt(v || 0)), 16);
const pack = (op) => ({
  sender: op.sender, nonce: op.nonce,
  initCode: op.factory ? ethers.concat([op.factory, op.factoryData]) : "0x",
  callData: op.callData,
  accountGasLimits: ethers.concat([pad16(op.verificationGasLimit), pad16(op.callGasLimit)]),
  preVerificationGas: op.preVerificationGas,
  gasFees: ethers.concat([pad16(op.maxPriorityFeePerGas), pad16(op.maxFeePerGas)]),
  paymasterAndData: op.paymaster ? ethers.concat([op.paymaster, pad16(op.paymasterVerificationGasLimit), pad16(op.paymasterPostOpGasLimit), op.paymasterData || "0x"]) : "0x",
  signature: op.signature,
});
const receipts = {};

async function handle(method, params) {
  const pm = { paymaster: cfg.localPaymaster, paymasterData: "0x", paymasterVerificationGasLimit: "0x30000", paymasterPostOpGasLimit: "0x0" };
  switch (method) {
    case "pm_getPaymasterStubData": return { ...pm, isFinal: false };
    case "pm_getPaymasterData": return pm;
    case "eth_estimateUserOperationGas":
      return { callGasLimit: "0x100000", verificationGasLimit: params[0].factory ? "0x80000" : "0x30000", preVerificationGas: "0xc350", paymasterVerificationGasLimit: "0x30000", paymasterPostOpGasLimit: "0x0" };
    case "eth_sendUserOperation": {
      const signer = await provider.getSigner(9);
      const ep = new ethers.Contract(cfg.entryPoint, EP_ABI, signer);
      const packed = pack(params[0]);
      const hash = await ep.getUserOpHash(packed);
      if (process.env.DEBUG) fs.writeFileSync("/tmp/last-op.json", JSON.stringify(packed, (k, v) => (typeof v === "bigint" ? v.toString() : v), 1));
      const tx = await ep.handleOps([packed], await signer.getAddress(), { gasLimit: 15_000_000 });
      const rc = await tx.wait();
      const evs = rc.logs.map((l) => { try { return ep.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
      const ev = evs.find((e) => e.name === "UserOperationEvent");
      const why = evs.find((e) => e.name === "UserOperationRevertReason");
      receipts[hash] = { success: ev.args.success, reason: why ? why.args.revertReason : undefined, receipt: { transactionHash: tx.hash } };
      return hash;
    }
    case "eth_getUserOperationReceipt": return receipts[params[0]] || null;
    default: throw new Error("méthode non gérée : " + method);
  }
}

http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") return res.end();
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const { id, method, params } = JSON.parse(body);
    try {
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: await handle(method, params) }));
    } catch (e) {
      console.error(method, e.shortMessage || e.message);
      res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: e.shortMessage || e.message } }));
    }
  });
}).listen(8547, () => console.log("Faux bundler/paymaster sur http://127.0.0.1:8547"));
