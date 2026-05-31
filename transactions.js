require('dotenv').config();
const axios = require('axios');

// ─── LTC REAL TRANSACTION ─────────────────────────────────────────────────────
async function sendLTC(fromAddress, fromPrivateKeyWIF, toAddress, amountLTC) {
  try {
    const bitcore = require('bitcore-lib');

    // Network fee in satoshis
    const FEE_SATOSHIS = 10000; // 0.0001 LTC
    const amountSatoshis = Math.round(amountLTC * 1e8);

    // Get UTXOs from BlockCypher
    const utxoRes = await axios.get(
      `https://api.blockcypher.com/v1/ltc/main/addrs/${fromAddress}?unspentOnly=true&includeScript=true`,
      { timeout: 10000 }
    );

    const utxos = utxoRes.data.txrefs || [];
    if (utxos.length === 0) throw new Error('No UTXOs found');

    // Calculate total available
    const totalAvailable = utxos.reduce((sum, u) => sum + u.value, 0);
    const totalNeeded = amountSatoshis + FEE_SATOSHIS;
    if (totalAvailable < totalNeeded) throw new Error('Insufficient funds');

    // Build transaction with bitcore-lib
    const privateKey = new bitcore.PrivateKey(fromPrivateKeyWIF, bitcore.Networks.livenet);

    const utxoObjects = utxos.map(u => ({
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

    // Broadcast transaction
    const broadcastRes = await axios.post(
      'https://api.blockcypher.com/v1/ltc/main/txs/push',
      { tx: tx.serialize() },
      { timeout: 15000 }
    );

    return broadcastRes.data.tx.hash;
  } catch (err) {
    console.error('LTC send error:', err.message);
    throw err;
  }
}

// ─── TRX REAL TRANSACTION ─────────────────────────────────────────────────────
async function sendTRX(fromAddress, fromPrivateKey, toAddress, amountTRX) {
  try {
    const TronWeb = require('tronweb');

    const tronWeb = new TronWeb({
      fullHost: 'https://api.trongrid.io',
      headers: { 'TRON-PRO-API-KEY': process.env.TRONGRID_TOKEN },
      privateKey: fromPrivateKey,
    });

    const amountSun = Math.round(amountTRX * 1e6); // Convert TRX to SUN

    // Send TRX transaction
    const tx = await tronWeb.trx.sendTransaction(toAddress, amountSun, fromPrivateKey);

    if (!tx.result) throw new Error('Transaction failed');
    return tx.txid;
  } catch (err) {
    console.error('TRX send error:', err.message);
    throw err;
  }
}

module.exports = { sendLTC, sendTRX };
