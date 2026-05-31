const axios = require('axios');
 
const JSONBIN_KEY = process.env.JSONBIN_KEY;
const JSONBIN_ID = process.env.JSONBIN_ID;
const BASE_URL = `https://api.jsonbin.io/v3/b/${JSONBIN_ID}`;
 
const HEADERS = {
  'X-Master-Key': JSONBIN_KEY,
  'Content-Type': 'application/json',
};
 
// ─── LOAD ALL DATA ────────────────────────────────────────────────────────────
async function load() {
  try {
    const res = await axios.get(`${BASE_URL}/latest`, { headers: HEADERS });
    return res.data.record || {};
  } catch (err) {
    console.error('JSONBin load error:', err.message);
    return {};
  }
}
 
// ─── SAVE ALL DATA ────────────────────────────────────────────────────────────
async function save(data) {
  try {
    await axios.put(BASE_URL, data, { headers: HEADERS });
  } catch (err) {
    console.error('JSONBin save error:', err.message);
  }
}
 
// ─── ENSURE USER EXISTS ───────────────────────────────────────────────────────
function ensureUser(db, userId) {
  if (!db[userId]) {
    db[userId] = {
      ltcBalance: 0, ltcAddress: null, ltcPrivateKey: null, ltcOnChain: 0,
      solBalance: 0, solAddress: null, solPrivateKey: null, solOnChain: 0,
      transactions: [],
    };
  }
  return db[userId];
}
 
// ─── GET USER ─────────────────────────────────────────────────────────────────
async function getUser(userId) {
  const db = await load();
  ensureUser(db, userId);
  await save(db);
  return db[userId];
}
 
// ─── SET ADDRESS ──────────────────────────────────────────────────────────────
async function setAddress(userId, coin, address, privateKey) {
  const db = await load();
  ensureUser(db, userId);
  db[userId][`${coin}Address`] = address;
  db[userId][`${coin}PrivateKey`] = privateKey;
  await save(db);
}
 
// ─── ADD BALANCE ──────────────────────────────────────────────────────────────
async function addBalance(userId, coin, amount) {
  const db = await load();
  ensureUser(db, userId);
  db[userId][`${coin}Balance`] = (db[userId][`${coin}Balance`] || 0) + amount;
  db[userId].transactions.push({ type: 'deposit', coin, amount, ts: Date.now() });
  await save(db);
}
 
// ─── DEDUCT BALANCE ───────────────────────────────────────────────────────────
async function deduct(userId, coin, amount) {
  const db = await load();
  if (!db[userId] || (db[userId][`${coin}Balance`] || 0) < amount) return false;
  db[userId][`${coin}Balance`] -= amount;
  db[userId].transactions.push({ type: 'withdraw', coin, amount, ts: Date.now() });
  await save(db);
  return true;
}
 
// ─── TRANSFER ─────────────────────────────────────────────────────────────────
async function transfer(fromId, toId, coin, amount) {
  const db = await load();
  const bk = `${coin}Balance`;
  if (!db[fromId] || (db[fromId][bk] || 0) < amount) return false;
  ensureUser(db, toId);
  db[fromId][bk] -= amount;
  db[toId][bk] = (db[toId][bk] || 0) + amount;
  const ts = Date.now();
  db[fromId].transactions.push({ type: 'tip_sent', coin, to: toId, amount, ts });
  db[toId].transactions.push({ type: 'tip_received', coin, from: fromId, amount, ts });
  await save(db);
  return true;
}
 
// ─── SET ON CHAIN ─────────────────────────────────────────────────────────────
async function setOnChain(userId, coin, amount) {
  const db = await load();
  if (!db[userId]) return;
  db[userId][`${coin}OnChain`] = amount;
  await save(db);
}
 
// ─── GET ALL USERS ────────────────────────────────────────────────────────────
async function getAllUsers() {
  return await load();
}
 
module.exports = { getUser, setAddress, addBalance, deduct, transfer, setOnChain, getAllUsers };
 
