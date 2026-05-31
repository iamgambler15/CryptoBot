require('dotenv').config();
const axios = require('axios');

// ─── LTC REAL TRANSACTION via BlockCypher (Free Forever) ─────────────────────
async function sendLTC(fromAddress, fromPrivateKeyWIF, toAddress, amountLTC) {
  try {
    const bitcore = require('bitcore-lib');
    const TOKEN = process.env.BLOCKCYPHER_TOKEN;
    const BASE = `https://api.blockcypher.com/v1/ltc/main`;

    const FEE_SATOSHIS = 10000; // 0.0001 LTC
    const amountSatoshis = Math.round(amountLTC * 1e8);

    // ── Step 1: Get UTXOs ──────────────────────────────────────────────────
    const utxoRes = await axios.get(
      `${BASE}/addrs/${fromAddress}?unspentOnly=true&includeScript=true&token=${TOKEN}`,
      { timeout: 15000 }
    );

    const utxos = utxoRes.data.txrefs || [];
    if (utxos.length === 0) throw new Error('No unspent outputs. Please deposit LTC first.');

    // ── Step 2: Check Balance ──────────────────────────────────────────────
    const totalAvailable = utxos.reduce((sum, u) => sum + u.value, 0);
    const totalNeeded = amountSatoshis + FEE_SATOSHIS;
    if (totalAvailable < totalNeeded) {
      throw new Error(`Insufficient on-chain funds.\nAvailable: ${(totalAvailable/1e8).toFixed(8)} LTC\nNeeded: ${(totalNeeded/1e8).toFixed(8)} LTC`);
    }

    // ── Step 3: Build & Sign Transaction ──────────────────────────────────
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

    const rawTx = tx.serialize();

    // ── Step 4: Broadcast via BlockCypher ─────────────────────────────────
    const broadcastRes = await axios.post(
      `${BASE}/txs/push?token=${TOKEN}`,
      { tx: rawTx },
      { timeout: 15000 }
    );

    if (broadcastRes.data.error) throw new Error(broadcastRes.data.error);

    return broadcastRes.data.tx.hash;

  } catch (err) {
    console.error('LTC send error:', err.message);
    throw err;
  }
}

// ─── TRX REAL TRANSACTION via TronWeb (Free Forever) ─────────────────────────
async function sendTRX(fromAddress, fromPrivateKey, toAddress, amountTRX) {
  try {
    const TronWeb = require('tronweb');

    const tronWeb = new TronWeb({
      fullHost: 'https://api.trongrid.io',
      headers: { 'TRON-PRO-API-KEY': process.env.TRONGRID_TOKEN },
      privateKey: fromPrivateKey,
    });

    // Validate TRX address
    if (!tronWeb.isAddress(toAddress)) {
      throw new Error('Invalid TRX address format');
    }

    const amountSun = Math.round(amountTRX * 1e6);

    // ── Send Transaction ───────────────────────────────────────────────────
    const tx = await tronWeb.trx.sendTransaction(toAddress, amountSun, fromPrivateKey);

    if (!tx.result) throw new Error(tx.message || 'TRX transaction failed');

    return tx.txid;

  } catch (err) {
    console.error('TRX send error:', err.message);
    throw err;
  }
}

module.exports = { sendLTC, sendTRX };
