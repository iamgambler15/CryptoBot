require('dotenv').config();
const axios = require('axios');
 
// ─── LTC REAL TRANSACTION via BlockCypher ─────────────────────────────────────
async function sendLTC(fromAddress, fromPrivateKeyWIF, toAddress, amountLTC) {
  try {
    const TOKEN = process.env.BLOCKCYPHER_TOKEN;
    const BASE = 'https://api.blockcypher.com/v1/ltc/main';
    const amountSatoshis = Math.round(amountLTC * 1e8);
 
    // ── Step 1: Get TX skeleton ───────────────────────────────────────────────
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
 
    // ── Step 2: Decode WIF private key ────────────────────────────────────────
    const bs58check = require('bs58check');
    const ecc = require('tiny-secp256k1');
 
    const decoded = bs58check.decode(fromPrivateKeyWIF);
    const privKeyBytes = Uint8Array.from(decoded.slice(1, 33));
    const pubKeyBytes = ecc.pointFromScalar(privKeyBytes, true); // compressed
    const pubKeyHex = Buffer.from(pubKeyBytes).toString('hex');
 
    // ── Step 3: Sign each hash in DER format ─────────────────────────────────
    function toDER(signature) {
      const r = signature.slice(0, 32);
      const s = signature.slice(32, 64);
 
      // Pad r and s if needed
      const rPad = r[0] & 0x80 ? Buffer.concat([Buffer.from([0x00]), Buffer.from(r)]) : Buffer.from(r);
      const sPad = s[0] & 0x80 ? Buffer.concat([Buffer.from([0x00]), Buffer.from(s)]) : Buffer.from(s);
 
      const rLen = rPad.length;
      const sLen = sPad.length;
      const totalLen = 2 + rLen + 2 + sLen;
 
      return Buffer.concat([
        Buffer.from([0x30, totalLen]),
        Buffer.from([0x02, rLen]), rPad,
        Buffer.from([0x02, sLen]), sPad,
      ]).toString('hex');
    }
 
    const signatures = tmx.tosign.map(hashHex => {
      const hashBytes = Uint8Array.from(Buffer.from(hashHex, 'hex'));
      const sigBytes = ecc.sign(hashBytes, privKeyBytes);
      return toDER(sigBytes);
    });
 
    // ── Step 4: Send signed TX ────────────────────────────────────────────────
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
 
    return sendRes.data.tx.hash;
 
  } catch (err) {
    const errMsg = err.response?.data?.error || err.response?.data?.errors?.[0]?.error || err.message;
    console.error('LTC send error:', errMsg);
    throw new Error(errMsg);
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
 
