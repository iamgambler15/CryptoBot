require('dotenv').config();
const axios = require('axios');

// ─── LTC REAL TRANSACTION via NOWNodes ───────────────────────────────────────
async function sendLTC(fromAddress, fromPrivateKeyWIF, toAddress, amountLTC) {
  try {
    const bitcore = require('bitcore-lib');

    const NOWNODES_KEY = process.env.NOWNODES_KEY;
    const BASE = `https://ltc.nownodes.io/${NOWNODES_KEY}`;

    const FEE_SATOSHIS = 10000; // 0.0001 LTC
    const amountSatoshis = Math.round(amountLTC * 1e8);

    // ── Step 1: Get UTXOs ──────────────────────────────────────────────────
    const utxoRes = await axios.post(BASE, {
      jsonrpc: '2.0', id: 1,
      method: 'listunspent',
      params: [1, 9999999, [fromAddress]],
    }, { timeout: 15000 });

    const utxos = utxoRes.data.result || [];

    // If no UTXOs from listunspent, try scantxoutset
    if (utxos.length === 0) {
      const scanRes = await axios.post(BASE, {
        jsonrpc: '2.0', id: 2,
        method: 'scantxoutset',
        params: ['start', [`addr(${fromAddress})`]],
      }, { timeout: 20000 });

      const unspents = scanRes.data.result?.unspents || [];
      if (unspents.length === 0) throw new Error('No unspent outputs found for this address');

      unspents.forEach(u => utxos.push({
        txid: u.txid,
        vout: u.vout,
        scriptPubKey: u.scriptPubKey,
        amount: u.amount,
      }));
    }

    // ── Step 2: Calculate totals ───────────────────────────────────────────
    const totalAvailable = utxos.reduce((sum, u) => sum + Math.round(u.amount * 1e8), 0);
    const totalNeeded = amountSatoshis + FEE_SATOSHIS;
    if (totalAvailable < totalNeeded) {
      throw new Error(`Insufficient on-chain funds. Available: ${totalAvailable / 1e8} LTC, Needed: ${totalNeeded / 1e8} LTC`);
    }

    // ── Step 3: Build & Sign Transaction ──────────────────────────────────
    const privateKey = new bitcore.PrivateKey(fromPrivateKeyWIF);

    const utxoObjects = utxos.map(u => new bitcore.Transaction.UnspentOutput({
      txId: u.txid,
      outputIndex: u.vout,
      address: fromAddress,
      script: u.scriptPubKey,
      satoshis: Math.round(u.amount * 1e8),
    }));

    const tx = new bitcore.Transaction()
      .from(utxoObjects)
      .to(toAddress, amountSatoshis)
      .fee(FEE_SATOSHIS)
      .change(fromAddress)
      .sign(privateKey);

    const rawTx = tx.serialize();

    // ── Step 4: Broadcast ─────────────────────────────────────────────────
    const broadcastRes = await axios.post(BASE, {
      jsonrpc: '2.0', id: 3,
      method: 'sendrawtransaction',
      params: [rawTx],
    }, { timeout: 15000 });

    if (broadcastRes.data.error) {
      throw new Error(broadcastRes.data.error.message);
    }

    return broadcastRes.data.result; // txHash

  } catch (err) {
    console.error('LTC send error:', err.message);
    throw err;
  }
}

// ─── TRX REAL TRANSACTION via TronWeb ────────────────────────────────────────
async function sendTRX(fromAddress, fromPrivateKey, toAddress, amountTRX) {
  try {
    const TronWeb = require('tronweb');

    const tronWeb = new TronWeb({
      fullHost: 'https://api.trongrid.io',
      headers: { 'TRON-PRO-API-KEY': process.env.TRONGRID_TOKEN },
      privateKey: fromPrivateKey,
    });

    // Validate address
    if (!tronWeb.isAddress(toAddress)) {
      throw new Error('Invalid TRX address');
    }

    const amountSun = Math.round(amountTRX * 1e6); // TRX to SUN

    // ── Send Transaction ───────────────────────────────────────────────────
    const tx = await tronWeb.trx.sendTransaction(toAddress, amountSun, fromPrivateKey);

    if (!tx.result) {
      throw new Error(tx.message || 'TRX transaction failed');
    }

    return tx.txid;

  } catch (err) {
    console.error('TRX send error:', err.message);
    throw err;
  }
}

module.exports = { sendLTC, sendTRX };
