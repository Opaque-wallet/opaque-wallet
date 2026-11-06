// Runs in the page's isolated world, where an extension's script can ask the
// browser for its own address, and leaves the approval window's URL on the page
// for inject.js (world MAIN, which cannot ask). Dapps open that window, and its
// notes are the ones in this extension's wallet.
document.documentElement.dataset.opaqueWallet = chrome.runtime.getURL('testnet/xrpl-connect.html');
document.documentElement.dataset.opaqueEthWallet = chrome.runtime.getURL('sepolia/eth-connect.html');
