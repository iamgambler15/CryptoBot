require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
 
// ─── LTC REAL TRANSACTION via BlockCypher ─────────────────────────────────────
async function sendLTC(fromAddress, fromPrivateKeyWIF, toAddress, amountLTC) {
  try {
    const TOKEN = process.env.BLOCKCYPHER_TOKEN;
    const BASE = 'https://api.blockcypher.com/v1/ltc/main';
    const amountSatoshis = Math.round(amountLTC * 1e8);
 
    // ── Step 1: New TX skeleton ───────────────────────────────────────────────
    const skeletonRes = await axios.post(
      `${BASE}/txs/new?token=${TOKEN}`,
      {
        inputs: [{ addresses: [fromAddress] }],
        outputs: [{ addresses: [toAddress], value: amountSatoshis }],
      },
      { timeout: 15000 }
    );
 
    if (skeletonRes.data.errors) {
      throw new Error(skeletonRes.data.errors.map(e => e.error).join(', '));
    }
 
    const tmx = skeletonRes.data;
    console.log('Skeleton received, tosign count:', tmx.tosign.length);
 
    // ── Step 2: Sign using tiny-secp256k1 directly ───────────────────────────
    const ecc = require('tiny-secp256k1');
    const bs58check = require('bs58check');
 
    // Decode WIF to raw private key bytes
    const decoded = bs58check.decode(fromPrivateKeyWIF);
    // WIF: 1 byte version + 32 bytes key + optional 1 byte compression flag
    const privKeyBytes = Uint8Array.from(decoded.slice(1, 33));
 
    // Get compressed public key
    const pubKeyBytes = ecc.pointFromScalar(privKeyBytes, true);
    const pubKeyHex = Buffer.from(pubKeyBytes).toString('hex');
 
    // Sign each hash
    const signatures = tmx.tosign.map(hashHex => {
      const hashBytes = Uint8Array.from(Buffer.from(hashHex, 'hex'));
      const sigBytes = ecc.sign(hashBytes, privKeyBytes);
      return Buffer.from(sigBytes).toString('hex');
    });
 
    console.log('Signed hashes:', signatures.length);
 
    // ── Step 3: Send signed TX ────────────────────────────────────────────────
    tmx.signatures = signatures;
    tmx.pubkeys = tmx.tosign.map(() => pubKeyHex);
 
    const sendRes = await axios.post(
      `${BASE}/txs/send?token=${TOKEN}`,
      tmx,
      { timeout: 15000 }
    );
 
    if (sendRes.data.errors) {
      throw new Error(sendRes.data.errors.map(e => e.error).join(', '));
    }
 
    console.log('LTC TX sent:', sendRes.data.tx.hash);
    return sendRes.data.tx.hash;
 
  } catch (err) {
    console.error('LTC send error:', err.response?.data || err.message);
    throw new Error(err.response?.data?.error || err.message);
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
 
