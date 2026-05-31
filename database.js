const fs = require('fs');
const path = require('path');
const DB_PATH = path.join(__dirname, 'data', 'users.json');

if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

function load() {
  if (!fs.existsSync(DB_PATH)) { fs.writeFileSync(DB_PATH, '{}'); return {}; }
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch { return {}; }
}

function save(data) { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2)); }

function ensureUser(db, userId) {
  if (!db[userId]) {
    db[userId] = {
      ltcBalance: 0, ltcAddress: null, ltcPrivateKey: null, ltcOnChain: 0,
      trxBalance: 0, trxAddress: null, trxPrivateKey: null, trxOnChain: 0,
      transactions: [],
    };
  }
  return db[userId];
}

function getUser(userId) {
  const db = load();
  ensureUser(db, userId);
  save(db);
  return db[userId];
}

function setAddress(userId, coin, address, privateKey) {
  const db = load();
  ensureUser(db, userId);
  db[userId][`${coin}Address`] = address;
  db[userId][`${coin}PrivateKey`] = privateKey;
  save(db);
}

function addBalance(userId, coin, amount) {
  const db = load();
  ensureUser(db, userId);
  db[userId][`${coin}Balance`] = (db[userId][`${coin}Balance`] || 0) + amount;
  db[userId].transactions.push({ type: 'deposit', coin, amount, ts: Date.now() });
  save(db);
}

function deduct(userId, coin, amount) {
  const db = load();
  if (!db[userId] || (db[userId][`${coin}Balance`] || 0) < amount) return false;
  db[userId][`${coin}Balance`] -= amount;
  db[userId].transactions.push({ type: 'withdraw', coin, amount, ts: Date.now() });
  save(db);
  return true;
}

function transfer(fromId, toId, coin, amount) {
  const db = load();
  const bk = `${coin}Balance`;
  if (!db[fromId] || (db[fromId][bk] || 0) < amount) return false;
  ensureUser(db, toId);
  db[fromId][bk] -= amount;
  db[toId][bk] = (db[toId][bk] || 0) + amount;
  const ts = Date.now();
  db[fromId].transactions.push({ type: 'tip_sent', coin, to: toId, amount, ts });
  db[toId].transactions.push({ type: 'tip_received', coin, from: fromId, amount, ts });
  save(db);
  return true;
}

function setOnChain(userId, coin, amount) {
  const db = load();
  if (!db[userId]) return;
  db[userId][`${coin}OnChain`] = amount;
  save(db);
}

function getAllUsers() { return load(); }

module.exports = { getUser, setAddress, addBalance, deduct, transfer, setOnChain, getAllUsers };
