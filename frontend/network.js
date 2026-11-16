/* global ethers */
// Passe MetaMask sur le bon réseau, en l'ajoutant si MetaMask ne le connaît pas encore.
async function switchNetwork(cfg) {
  const hex = "0x" + Number(cfg.chainId).toString(16);
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    if (e.code !== 4902 && e?.data?.originalError?.code !== 4902) throw e;
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: hex,
        chainName: cfg.name,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: [cfg.rpc],
        blockExplorerUrls: cfg.explorer ? [cfg.explorer] : [],
      }],
    });
  }
}
