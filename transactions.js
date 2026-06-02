require('dotenv').config();
const axios = require('axios');
 
// ─── LTC REAL TRANSACTION via BlockCypher ─────────────────────────────────────
async function sendLTC(fromAddress, fromPrivateKeyWIF, toAddress, amountLTC) {
  try {
    const TOKEN = process.env.BLOCKCYPHER_TOKEN;
    const BASE = 'https://api.blockcypher.com/v1/ltc/main';
    const amountSatoshis = Math.round(amountLTC * 1e8);
 
    // ── Step 1: Create transaction skeleton ───────────────────────────────────
    const newTx = {
      inputs: [{ addresses: [fromAddress] }],
      outputs: [{ addresses: [toAddress], value: amountSatoshis }],
    };
 
    const skeletonRes = await axios.post(
      `${BASE}/txs/new?token=${TOKEN}`,
      newTx,
      { timeout: 15000 }
    );
 
    if (skeletonRes.data.errors) {
      throw new Error(skeletonRes.data.errors[0].error);
    }
 
    const skeleton = skeletonRes.data;
 
    // ── Step 2: Sign each input ───────────────────────────────────────────────
    const bitcoin = require('bitcoinjs-lib');
    const bs58check = require('bs58check');
    const crypto = require('crypto');
 
    // Decode WIF private key
    function wifToPrivateKey(wif) {
      const decoded = bs58check.decode(wif);
      // Remove version byte (1 byte) and compression flag (1 byte if present)
      return decoded.slice(1, 33);
    }
 
    const privateKeyBytes = wifToPrivateKey(fromPrivateKeyWIF);
    const { ECPairFactory } = require('ecpair');
    const ecc = require('tiny-secp256k1');
    const ECPair = ECPairFactory(ecc);
    const keyPair = ECPair.fromPrivateKey(privateKeyBytes);
 
    // Sign each hash
    const signatures = skeleton.tosign.map(hashHex => {
      const hash = Buffer.from(hashHex, 'hex');
      const sig = keyPair.sign(hash);
      return Buffer.from(sig).toString('hex');
    });
 
    const pubkeys = skeleton.tosign.map(() =>
      keyPair.publicKey.toString('hex')
    );
 
    skeleton.signatures = signatures;
    skeleton.pubkeys = pubkeys;
 
    // ── Step 3: Send signed transaction ──────────────────────────────────────
    const sendRes = await axios.post(
      `${BASE}/txs/send?token=${TOKEN}`,
      skeleton,
      { timeout: 15000 }
    );
 
    if (sendRes.data.errors) throw new Error(sendRes.data.errors[0].error);
    return sendRes.data.tx.hash;
 
  } catch (err) {
    console.error('LTC send error:', err.message);
    throw err;
  }
}
 
// ─── SOL REAL TRANSACTION ─────────────────────────────────────────────────────
async function sendSOL(fromAddress, fromPrivateKeyHex, toAddress, amountSOL) {
  try {
    const {
      Connection, PublicKey, Keypair, Transaction,
      SystemProgram, sendAndConfirmTransaction,
      clusterApiUrl, LAMPORTS_PER_SOL
    } = require('@solana/web3.js');
 
    const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');
    const secretKey = Buffer.from(fromPrivateKeyHex, 'hex');
    const fromKeypair = Keypair.fromSecretKey(secretKey);
    const toPubkey = new PublicKey(toAddress);
    const lamports = Math.round(amountSOL * LAMPORTS_PER_SOL);
 
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: fromKeypair.publicKey,
        toPubkey,
        lamports,
      })
    );
 
    const txHash = await sendAndConfirmTransaction(connection, transaction, [fromKeypair]);
    return txHash;
 
  } catch (err) {
    console.error('SOL send error:', err.message);
    throw err;
  }
}
 
module.exports = { sendLTC, sendSOL };
 
