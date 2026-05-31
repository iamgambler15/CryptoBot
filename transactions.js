require('dotenv').config();
const axios = require('axios');
 
// ─── LTC REAL TRANSACTION via BlockCypher ─────────────────────────────────────
async function sendLTC(fromAddress, fromPrivateKeyWIF, toAddress, amountLTC) {
  try {
    const bitcore = require('bitcore-lib');
    const TOKEN = process.env.BLOCKCYPHER_TOKEN;
    const BASE = `https://api.blockcypher.com/v1/ltc/main`;
    const FEE_SATOSHIS = 10000;
    const amountSatoshis = Math.round(amountLTC * 1e8);
 
    const utxoRes = await axios.get(
      `${BASE}/addrs/${fromAddress}?unspentOnly=true&includeScript=true&token=${TOKEN}`,
      { timeout: 15000 }
    );
 
    const utxos = utxoRes.data.txrefs || [];
    if (utxos.length === 0) throw new Error('No unspent outputs. Please deposit LTC first.');
 
    const totalAvailable = utxos.reduce((sum, u) => sum + u.value, 0);
    const totalNeeded = amountSatoshis + FEE_SATOSHIS;
    if (totalAvailable < totalNeeded)
      throw new Error(`Insufficient funds. Available: ${(totalAvailable/1e8).toFixed(8)} LTC`);
 
    const privateKey = new bitcore.PrivateKey(fromPrivateKeyWIF);
    const utxoObjects = utxos.map(u => new bitcore.Transaction.UnspentOutput({
      txId: u.tx_hash,
      outputIndex: u.tx_output_n,
      address: fromAddress,
      script: u.script,
      satoshis: u.value,
    }));
 
    const tx = new bitcore.Transaction()
      .from(utxoObjects)
      .to(toAddress, amountSatoshis)
      .fee(FEE_SATOSHIS)
      .change(fromAddress)
      .sign(privateKey);
 
    const broadcastRes = await axios.post(
      `${BASE}/txs/push?token=${TOKEN}`,
      { tx: tx.serialize() },
      { timeout: 15000 }
    );
 
    if (broadcastRes.data.error) throw new Error(broadcastRes.data.error);
    return broadcastRes.data.tx.hash;
 
  } catch (err) {
    console.error('LTC send error:', err.message);
    throw err;
  }
}
 
// ─── SOL REAL TRANSACTION via Solana Web3 ─────────────────────────────────────
async function sendSOL(fromAddress, fromPrivateKeyHex, toAddress, amountSOL) {
  try {
    const {
      Connection, PublicKey, Keypair,
      Transaction, SystemProgram,
      sendAndConfirmTransaction, clusterApiUrl, LAMPORTS_PER_SOL
    } = require('@solana/web3.js');
 
    const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');
 
    // Restore keypair from hex private key
    const secretKey = Buffer.from(fromPrivateKeyHex, 'hex');
    const fromKeypair = Keypair.fromSecretKey(secretKey);
 
    const toPubkey = new PublicKey(toAddress);
    const lamports = Math.round(amountSOL * LAMPORTS_PER_SOL);
 
    // Build transaction
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: fromKeypair.publicKey,
        toPubkey,
        lamports,
      })
    );
 
    // Send and confirm
    const txHash = await sendAndConfirmTransaction(connection, transaction, [fromKeypair]);
    return txHash;
 
  } catch (err) {
    console.error('SOL send error:', err.message);
    throw err;
  }
}
 
module.exports = { sendLTC, sendSOL };
 
