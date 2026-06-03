require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');
const crypto = require('crypto');
const db = require('./database');
const { sendLTC, sendSOL } = require('./transactions');
 
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
  partials: ['CHANNEL', 'MESSAGE'],
});
 
// ─── COINS ────────────────────────────────────────────────────────────────────
const COINS = {
  ltc: {
    name: 'Litecoin', symbol: 'LTC', emoji: '🔘', color: '#A8A9AD',
    logo: 'https://cryptologos.cc/logos/litecoin-ltc-logo.png',
    explorer: 'https://blockchair.com/litecoin/transaction/',
    addrExplorer: 'https://blockchair.com/litecoin/address/',
    geckoId: 'litecoin', fee: 0.0001, minTip: 0.001, minWithdraw: 0.001,
  },
  sol: {
    name: 'Solana', symbol: 'SOL', emoji: '🟣', color: '#9945FF',
    logo: 'https://cryptologos.cc/logos/solana-sol-logo.png',
    explorer: 'https://solscan.io/tx/',
    addrExplorer: 'https://solscan.io/account/',
    geckoId: 'solana', fee: 0.000005, minTip: 0.001, minWithdraw: 0.001,
  },
};
 
// ─── ADDRESS GENERATION ───────────────────────────────────────────────────────
function generateLTCAddress() {
  try {
    const bs58check = require('bs58check');
    const secp256k1 = require('secp256k1');
    const privateKeyBytes = crypto.randomBytes(32);
    const wifPayload = Buffer.concat([Buffer.from([0xB0]), privateKeyBytes, Buffer.from([0x01])]);
    const wif = bs58check.encode(wifPayload);
    const pubKey = secp256k1.publicKeyCreate(privateKeyBytes, true);
    const sha256 = crypto.createHash('sha256').update(pubKey).digest();
    const ripemd160 = crypto.createHash('ripemd160').update(sha256).digest();
    const address = bs58check.encode(Buffer.concat([Buffer.from([0x30]), ripemd160]));
    return { address, privateKey: wif };
  } catch (err) { console.error('LTC gen error:', err.message); return null; }
}
 
function generateSOLAddress() {
  try {
    const { Keypair } = require('@solana/web3.js');
    const keypair = Keypair.generate();
    return { address: keypair.publicKey.toBase58(), privateKey: Buffer.from(keypair.secretKey).toString('hex') };
  } catch (err) { console.error('SOL gen error:', err.message); return null; }
}
 
// ─── PRICE & BALANCE ──────────────────────────────────────────────────────────
async function getPrice(geckoId) {
  try {
    const res = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${geckoId}&vs_currencies=usd&include_24hr_change=true`, { timeout: 5000 });
    return res.data[geckoId];
  } catch { return null; }
}
 
async function checkLTCBalance(address) {
  try {
    const res = await axios.get(`https://api.blockcypher.com/v1/ltc/main/addrs/${address}/balance`, { timeout: 5000 });
    return res.data.balance / 1e8;
  } catch { return 0; }
}
 
async function checkSOLBalance(address) {
  try {
    const { Connection, PublicKey, clusterApiUrl } = require('@solana/web3.js');
    const connection = new Connection(clusterApiUrl('mainnet-beta'));
    const balance = await connection.getBalance(new PublicKey(address));
    return balance / 1e9;
  } catch { return 0; }
}
 
// ─── HELPERS ──────────────────────────────────────────────────────────────────
function fmt(amount, coin) {
  return coin === 'ltc' ? parseFloat(amount || 0).toFixed(8) : parseFloat(amount || 0).toFixed(6);
}
 
async function toUSD(amount, geckoId) {
  const p = await getPrice(geckoId);
  return p ? (amount * p.usd).toFixed(2) : '?';
}
 
// Parse amount: "1$", "$1", "1" → { amount: 1, isUSD: true/false }
function parseAmount(str) {
  if (!str) return { amount: NaN, isUSD: false };
  const s = str.toString().trim();
  const isUSD = s.includes('$');
  return { amount: parseFloat(s.replace(/\$/g, '').trim()), isUSD };
}
 
async function usdToCoin(usdAmount, geckoId) {
  const p = await getPrice(geckoId);
  return p ? usdAmount / p.usd : null;
}
 
// Parse coin from args: "ltc" or "sol"
function parseCoin(args, startIdx = 0) {
  for (let i = startIdx; i < args.length; i++) {
    const a = args[i].toLowerCase().replace(/\$/g, '');
    if (a === 'ltc' || a === 'sol') return a;
  }
  return null;
}
 
// ─── ACTIVE MAPS ──────────────────────────────────────────────────────────────
const activeAirdrops = new Map();
const activeRedPackets = new Map();
 
// ─── COIN SELECT UI ───────────────────────────────────────────────────────────
function coinSelectRow(action) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${action}__ltc`).setLabel('🔘 Litecoin (LTC)').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${action}__sol`).setLabel('🟣 Solana (SOL)').setStyle(ButtonStyle.Primary),
  );
}
 
function coinSelectEmbed(action) {
  const labels = { deposit: '💳 Deposit', withdraw: '📤 Withdraw' };
  return new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle(`${labels[action] || '⚡ Select'} — Choose Your Coin`)
    .setDescription('Which coin do you want to use?')
    .addFields(
      { name: '🔘 Litecoin (LTC)', value: '`Fee: 0.0001 LTC`', inline: true },
      { name: '🟣 Solana (SOL)', value: '`Fee: ~$0.00025`', inline: true },
    )
    .setFooter({ text: 'LTC & SOL Tip Bot ⚡' })
    .setTimestamp();
}
 
// Withdraw amount select embed
function withdrawAmountEmbed(coin) {
  const c = COINS[coin];
  return new EmbedBuilder()
    .setColor(c.color)
    .setAuthor({ name: `⚡ ${c.name} Tip Bot`, iconURL: c.logo })
    .setTitle(`📤 Withdraw ${c.symbol} — Select Amount`)
    .setThumbnail(c.logo)
    .setDescription('Choose how much you want to withdraw:')
    .addFields(
      { name: '💡 Quick Amounts', value: 'Click a button below or type custom amount', inline: false },
    )
    .setFooter({ text: `${c.name} Tip Bot ⚡` })
    .setTimestamp();
}
 
function withdrawAmountRow(coin) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wamt__${coin}__1`).setLabel('$1').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`wamt__${coin}__5`).setLabel('$5').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`wamt__${coin}__10`).setLabel('$10').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`wamt__${coin}__25`).setLabel('$25').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`wamt__${coin}__all`).setLabel('All 💰').setStyle(ButtonStyle.Danger),
  );
}
 
// ─── EMBEDS ───────────────────────────────────────────────────────────────────
function depositEmbed(user, coin, address, balance, usdVal) {
  const c = COINS[coin];
  return new EmbedBuilder()
    .setColor(c.color)
    .setAuthor({ name: `⚡ ${c.name} Tip Bot`, iconURL: c.logo })
    .setTitle(`💳 Your ${c.symbol} Deposit Address`)
    .setThumbnail(c.logo)
    .addFields(
      { name: `${c.emoji} ${c.symbol} Address`, value: `\`\`\`${address}\`\`\``, inline: false },
      { name: '💰 Current Balance', value: `**${fmt(balance, coin)} ${c.symbol}** ≈ **$${usdVal} USD**`, inline: true },
      { name: '📌 Network', value: `\`${c.name} Mainnet\``, inline: true },
      { name: '⚠️ Important', value: `> Only send **${c.symbol}** to this address\n> Minimum deposit: **${c.minTip} ${c.symbol}**\n> Required confirmations: **3**`, inline: false },
    )
    .setImage(`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${address}`)
    .setFooter({ text: `${user.tag} • ${c.name} Tip Bot`, iconURL: user.displayAvatarURL() })
    .setTimestamp();
}
 
function withdrawConfirmEmbed(user, coin, toAddr, amount, usdVal, txHash) {
  const c = COINS[coin];
  return new EmbedBuilder()
    .setColor('#4ADE80')
    .setAuthor({ name: `⚡ ${c.name} Tip Bot`, iconURL: c.logo })
    .setTitle('✅ Withdrawal Confirmed!')
    .setThumbnail(c.logo)
    .addFields(
      { name: '📤 Amount Sent', value: `**${fmt(amount, coin)} ${c.symbol}** ≈ **$${usdVal} USD**`, inline: true },
      { name: '💸 Network Fee', value: `**${c.fee} ${c.symbol}**`, inline: true },
      { name: '📬 Recipient Address', value: `\`${toAddr}\``, inline: false },
      { name: '🔗 Transaction', value: txHash ? `[\`${txHash.slice(0,20)}...\`](${c.explorer}${txHash})` : '`Processing...`', inline: false },
      { name: '📡 Explorer', value: `[View on Explorer ↗](${c.addrExplorer}${toAddr})`, inline: true },
      { name: '⏱️ Status', value: '`Broadcasted ✅`', inline: true },
    )
    .setFooter({ text: `${user.tag} • ${c.name} Tip Bot`, iconURL: user.displayAvatarURL() })
    .setTimestamp();
}
 
function tipEmbed(sender, receiver, coin, amount, usdVal) {
  const c = COINS[coin];
  return new EmbedBuilder()
    .setColor('#FCD34D')
    .setAuthor({ name: `⚡ ${c.name} Tip Bot`, iconURL: c.logo })
    .setTitle('🎉 Tip Sent Successfully!')
    .setThumbnail(c.logo)
    .addFields(
      { name: '👤 From', value: `<@${sender.id}>`, inline: true },
      { name: '🎯 To', value: `<@${receiver.id}>`, inline: true },
      { name: `${c.emoji} Amount`, value: `**${fmt(amount, coin)} ${c.symbol}** ≈ **$${usdVal} USD**`, inline: false },
      { name: '💸 Network Fee', value: '`Internal Transfer — No Fee`', inline: true },
    )
    .setFooter({ text: `${c.name} Tip Bot ⚡ • Fast & Low Fees` })
    .setTimestamp();
}
 
function balEmbed(user, ltcBal, ltcUsd, solBal, solUsd) {
  return new EmbedBuilder()
    .setColor('#38BDF8')
    .setAuthor({ name: '⚡ Tip Bot', iconURL: COINS.ltc.logo })
    .setTitle('👛 Your Wallet Balance')
    .setThumbnail(COINS.ltc.logo)
    .addFields(
      { name: '🔘 Litecoin (LTC)', value: `**${fmt(ltcBal, 'ltc')} LTC**\n≈ **$${ltcUsd} USD**`, inline: true },
      { name: '🟣 Solana (SOL)', value: `**${fmt(solBal, 'sol')} SOL**\n≈ **$${solUsd} USD**`, inline: true },
    )
    .setFooter({ text: `${user.tag} • Tip Bot`, iconURL: user.displayAvatarURL() })
    .setTimestamp();
}
 
function priceEmbed(coin, price) {
  const c = COINS[coin];
  const ch = price.usd_24h_change || 0;
  return new EmbedBuilder()
    .setColor(ch >= 0 ? '#4ADE80' : '#F87171')
    .setAuthor({ name: `⚡ ${c.name} Tip Bot`, iconURL: c.logo })
    .setTitle(`${ch >= 0 ? '📈' : '📉'} ${c.name} (${c.symbol}) Live Price`)
    .setThumbnail(c.logo)
    .addFields(
      { name: '💵 Price (USD)', value: `**$${price.usd.toFixed(4)}**`, inline: true },
      { name: '📊 24h Change', value: `**${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%**`, inline: true },
    )
    .setFooter({ text: 'Data by CoinGecko • Tip Bot ⚡' })
    .setTimestamp();
}
 
function airdropEmbed(hostId, coin, amount, secondsLeft, participants, usdVal, ended = false) {
  const c = COINS[coin];
  const count = participants.size;
  const perPerson = count > 0 ? (amount / count).toFixed(coin === 'ltc' ? 8 : 6) : fmt(amount, coin);
  return new EmbedBuilder()
    .setColor(ended ? '#4ADE80' : c.color)
    .setAuthor({ name: `⚡ ${c.name} Tip Bot`, iconURL: c.logo })
    .setTitle(ended ? '✅ Airdrop Ended!' : '🪂 Airdrop Is Live!')
    .setThumbnail(c.logo)
    .addFields(
      { name: '👤 Host', value: `<@${hostId}>`, inline: true },
      { name: `${c.emoji} Total`, value: `**${fmt(amount, coin)} ${c.symbol}** ≈ **$${usdVal} USD**`, inline: true },
      { name: '⏱️ Time Left', value: ended ? '`Ended`' : `**${secondsLeft}s**`, inline: true },
      { name: '👥 Participants', value: count > 0 ? `**${count} joined** — Each gets **${perPerson} ${c.symbol}**` : '`Be the first to join!`', inline: false },
      { name: ended ? '🎉 Winners' : '📌 How to Join',
        value: ended ? (count > 0 ? [...participants].map(id => `<@${id}>`).join(' ') : '`Nobody joined!`') : '> Press **✅ Join Airdrop** below!',
        inline: false },
    )
    .setFooter({ text: ended ? `${c.name} Tip Bot • Airdrop Done!` : `${c.name} Tip Bot • Hurry up! ⚡` })
    .setTimestamp();
}
 
function redPacketEmbed(hostId, coin, amount, secondsLeft, winnerId, usdVal, ended = false) {
  const c = COINS[coin];
  return new EmbedBuilder()
    .setColor(ended ? (winnerId ? '#4ADE80' : '#6B7280') : '#FF0000')
    .setAuthor({ name: `⚡ ${c.name} Tip Bot`, iconURL: c.logo })
    .setTitle(ended ? (winnerId ? '🧧 Red Packet Claimed!' : '⌛ Red Packet Expired!') : '🧧 Red Packet!')
    .setThumbnail(c.logo)
    .addFields(
      { name: '👤 Sent By', value: `<@${hostId}>`, inline: true },
      { name: `${c.emoji} Amount`, value: `**${fmt(amount, coin)} ${c.symbol}** ≈ **$${usdVal} USD**`, inline: true },
      { name: '⏱️ Time Left', value: ended ? '`Expired`' : `**${secondsLeft}s**`, inline: true },
      { name: '🏆 Winner', value: ended ? (winnerId ? `<@${winnerId}> won it all! 🎉` : '`Nobody claimed it — Refunded!`') : '`First click wins EVERYTHING! ⚡`', inline: false },
    )
    .setFooter({ text: ended ? `${c.name} Tip Bot • Red Packet Done!` : `${c.name} Tip Bot • Be Fast! ⚡` })
    .setTimestamp();
}
 
function helpEmbed() {
  return new EmbedBuilder()
    .setColor('#A78BFA')
    .setAuthor({ name: '⚡ LTC & SOL Tip Bot', iconURL: COINS.ltc.logo })
    .setTitle('📖 Bot Commands')
    .setDescription('> Use coin name at the end of commands!')
    .addFields(
      { name: '💳 `$deposit`', value: 'Get your deposit address via DM\nExample: `$deposit`', inline: false },
      { name: '📤 `$withdraw <address>`', value: 'Example: `$withdraw LAddr... ltc`\nThen select amount from buttons!', inline: false },
      { name: '🎁 `$tip @user <amount> <coin>`', value: 'Example: `$tip @John $1 ltc` or `$tip @John 0.5 sol`', inline: false },
      { name: '💹 `$price <coin>`', value: 'Example: `$price ltc` or `$price sol`', inline: false },
      { name: '🪂 `$airdrop <amount> <seconds> <coin>`', value: 'Example: `$airdrop $1 30 ltc` or `$airdrop 0.5 60 sol`', inline: false },
      { name: '🧧 `$redpacket <amount> <seconds> <coin>`', value: 'Example: `$redpacket $1 30 ltc` — First click wins all!', inline: false },
      { name: '👛 `$bal` / `$bals`', value: 'Check your LTC & SOL balance', inline: false },
      { name: '❓ `$help`', value: 'Show this help menu', inline: false },
      { name: '💡 Fees', value: '🔘 LTC: `0.0001 LTC` | 🟣 SOL: `~$0.00025`', inline: false },
    )
    .setFooter({ text: 'LTC & SOL Tip Bot ⚡ • Fast & Low Fees' })
    .setTimestamp();
}
 
// ─── PENDING MAP ──────────────────────────────────────────────────────────────
const pending = new Map();
 
// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const args = message.content.trim().split(/\s+/);
  const cmd = args[0].toLowerCase();
  const isDM = message.channel.type === 1;
 
  // $help
  if (cmd === '$help') return message.reply({ embeds: [helpEmbed()] });
 
  // $bal / $bals
  if (cmd === '$bal' || cmd === '$bals' || cmd === '$balance') {
    const u = message.author;
    const ud = await db.getUser(u.id);
    const [ltcUsd, solUsd] = await Promise.all([
      toUSD(ud.ltcBalance || 0, 'litecoin'),
      toUSD(ud.solBalance || 0, 'solana'),
    ]);
    return message.reply({ embeds: [balEmbed(u, ud.ltcBalance || 0, ltcUsd, ud.solBalance || 0, solUsd)] });
  }
 
  // $deposit — show coin select buttons
  if (cmd === '$deposit') {
    return message.reply({ embeds: [coinSelectEmbed('deposit')], components: [coinSelectRow('deposit')] });
  }
 
  // $price ltc or $price sol
  if (cmd === '$price') {
    const coin = parseCoin(args, 1);
    if (!coin) return message.reply('❌ Usage: `$price ltc` or `$price sol`');
    const price = await getPrice(COINS[coin].geckoId);
    if (!price) return message.reply('❌ Could not fetch price. Try again.');
    return message.reply({ embeds: [priceEmbed(coin, price)] });
  }
 
  // $tip @user $1 ltc or $tip @user 0.5 sol
  if (cmd === '$tip') {
    if (isDM) return message.reply('❌ Use `$tip` in a server channel.');
    const mention = message.mentions.users.first();
    const parsed = parseAmount(args[2]);
    const coin = parseCoin(args, 3);
 
    if (!mention || isNaN(parsed.amount) || parsed.amount <= 0 || !coin)
      return message.reply('❌ Usage: `$tip @user <amount> <coin>`\nExamples:\n`$tip @John $1 ltc`\n`$tip @John 0.5 sol`');
    if (mention.id === message.author.id) return message.reply('❌ You cannot tip yourself!');
    if (mention.bot) return message.reply('❌ You cannot tip a bot!');
 
    const c = COINS[coin];
    let amount = parsed.amount;
    if (parsed.isUSD) {
      const converted = await usdToCoin(parsed.amount, c.geckoId);
      if (!converted) return message.reply('❌ Could not fetch price. Try again.');
      amount = converted;
    }
 
    if (amount < c.minTip) return message.reply(`❌ Minimum tip: **${c.minTip} ${c.symbol}**`);
    const ud = await db.getUser(message.author.id);
    if ((ud[`${coin}Balance`] || 0) < amount)
      return message.reply(`❌ Insufficient balance!\nYour ${c.symbol}: **${fmt(ud[`${coin}Balance`] || 0, coin)}**`);
 
    await db.transfer(message.author.id, mention.id, coin, amount);
    const usdVal = parsed.isUSD ? parsed.amount.toFixed(2) : await toUSD(amount, c.geckoId);
    const embed = tipEmbed(message.author, mention, coin, amount, usdVal);
    message.reply({ embeds: [embed] });
 
    // DM receiver
    try {
      const dmEmbed = new EmbedBuilder()
        .setColor('#FCD34D').setTitle('🎉 You Received a Tip!').setThumbnail(c.logo)
        .addFields(
          { name: '👤 From', value: `**${message.author.tag}**`, inline: true },
          { name: `${c.emoji} Amount`, value: `**${fmt(amount, coin)} ${c.symbol}** ≈ **$${usdVal} USD**`, inline: true },
          { name: '💡', value: 'Type `$bal` to check your balance!', inline: false },
        ).setFooter({ text: `${c.name} Tip Bot ⚡` }).setTimestamp();
      await mention.send({ embeds: [dmEmbed] });
    } catch {}
    return;
  }
 
  // $withdraw <address> ltc or sol — show amount buttons
  if (cmd === '$withdraw') {
    const toAddr = args[1];
    const coin = parseCoin(args, 2);
    if (!toAddr || !coin)
      return message.reply('❌ Usage: `$withdraw <address> <coin>`\nExamples:\n`$withdraw LAddr... ltc`\n`$withdraw SolAddr... sol`');
    pending.set(message.author.id, { action: 'withdraw', args: [toAddr, coin] });
    return message.reply({
      embeds: [withdrawAmountEmbed(coin)],
      components: [withdrawAmountRow(coin)],
    });
  }
 
  // $airdrop $1 30 ltc or $airdrop 0.5 60 sol
  if (cmd === '$airdrop') {
    if (isDM) return message.reply('❌ Use `$airdrop` in a server channel.');
    const parsed = parseAmount(args[1]);
    const seconds = parseInt(args[2]);
    const coin = parseCoin(args, 3);
 
    if (isNaN(parsed.amount) || parsed.amount <= 0 || isNaN(seconds) || !coin)
      return message.reply('❌ Usage: `$airdrop <amount> <seconds> <coin>`\nExamples:\n`$airdrop $1 30 ltc`\n`$airdrop 0.5 60 sol`');
    if (seconds < 5 || seconds > 300) return message.reply('❌ Time must be **5–300** seconds.');
 
    const c = COINS[coin];
    let amount = parsed.amount;
    if (parsed.isUSD) {
      const converted = await usdToCoin(parsed.amount, c.geckoId);
      if (!converted) return message.reply('❌ Could not fetch price. Try again.');
      amount = converted;
    }
 
    const ud = await db.getUser(message.author.id);
    if ((ud[`${coin}Balance`] || 0) < amount)
      return message.reply(`❌ Insufficient balance!\nYour ${c.symbol}: **${fmt(ud[`${coin}Balance`] || 0, coin)}**`);
 
    await db.deduct(message.author.id, coin, amount);
    const usdVal = parsed.isUSD ? parsed.amount.toFixed(2) : await toUSD(amount, c.geckoId);
    const participants = new Set();
    let secondsLeft = seconds;
 
    const sentMsg = await message.channel.send({
      embeds: [airdropEmbed(message.author.id, coin, amount, secondsLeft, participants, usdVal)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`airdropjoin__TEMP`).setLabel('✅ Join Airdrop (0 joined)').setStyle(ButtonStyle.Success)
      )],
    });
 
    activeAirdrops.set(sentMsg.id, { hostId: message.author.id, coin, amount, secondsLeft, participants });
 
    // Update with real message ID
    await sentMsg.edit({
      embeds: [airdropEmbed(message.author.id, coin, amount, secondsLeft, participants, usdVal)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`airdropjoin__${sentMsg.id}`).setLabel('✅ Join Airdrop (0 joined)').setStyle(ButtonStyle.Success)
      )],
    });
 
    const timer = setInterval(async () => {
      secondsLeft -= 5;
      const data = activeAirdrops.get(sentMsg.id);
      if (!data) { clearInterval(timer); return; }
      data.secondsLeft = secondsLeft;
 
      if (secondsLeft <= 0) {
        clearInterval(timer);
        activeAirdrops.delete(sentMsg.id);
        const count = participants.size;
        if (count > 0) {
          const perPerson = amount / count;
          for (const pid of participants) await db.addBalance(pid, coin, perPerson);
        } else {
          await db.addBalance(message.author.id, coin, amount);
        }
        const finalUsd = await toUSD(amount, c.geckoId);
        await sentMsg.edit({
          embeds: [airdropEmbed(message.author.id, coin, amount, 0, participants, finalUsd, true)],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`ended`).setLabel('🔒 Airdrop Ended').setStyle(ButtonStyle.Secondary).setDisabled(true)
          )],
        });
        if (count > 0) {
          const perPerson = amount / count;
          for (const pid of participants) {
            const winner = await client.users.fetch(pid).catch(() => null);
            if (!winner) continue;
            const p = await getPrice(c.geckoId);
            const winEmbed = new EmbedBuilder()
              .setColor('#4ADE80').setTitle('🎉 You Won an Airdrop!').setThumbnail(c.logo)
              .addFields(
                { name: `${c.emoji} You Received`, value: `**${fmt(perPerson, coin)} ${c.symbol}** ≈ **$${p ? (perPerson*p.usd).toFixed(2) : '?'} USD**`, inline: true },
                { name: '👥 Total Winners', value: `**${count}**`, inline: true },
              ).setFooter({ text: `${c.name} Tip Bot ⚡` }).setTimestamp();
            await winner.send({ embeds: [winEmbed] }).catch(() => {});
          }
        }
        return;
      }
      try {
        await sentMsg.edit({
          embeds: [airdropEmbed(message.author.id, coin, amount, secondsLeft, participants, usdVal)],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`airdropjoin__${sentMsg.id}`).setLabel(`✅ Join Airdrop (${participants.size} joined)`).setStyle(ButtonStyle.Success)
          )],
        });
      } catch {}
    }, 5000);
    return;
  }
 
  // $redpacket $1 30 ltc or $redpacket 0.5 30 sol
  if (cmd === '$redpacket') {
    if (isDM) return message.reply('❌ Use `$redpacket` in a server channel.');
    const parsed = parseAmount(args[1]);
    const seconds = parseInt(args[2]);
    const coin = parseCoin(args, 3);
 
    if (isNaN(parsed.amount) || parsed.amount <= 0 || isNaN(seconds) || !coin)
      return message.reply('❌ Usage: `$redpacket <amount> <seconds> <coin>`\nExamples:\n`$redpacket $1 30 ltc`\n`$redpacket 0.5 30 sol`');
    if (seconds < 5 || seconds > 300) return message.reply('❌ Time must be **5–300** seconds.');
 
    const c = COINS[coin];
    let amount = parsed.amount;
    if (parsed.isUSD) {
      const converted = await usdToCoin(parsed.amount, c.geckoId);
      if (!converted) return message.reply('❌ Could not fetch price. Try again.');
      amount = converted;
    }
 
    const ud = await db.getUser(message.author.id);
    if ((ud[`${coin}Balance`] || 0) < amount)
      return message.reply(`❌ Insufficient balance!\nYour ${c.symbol}: **${fmt(ud[`${coin}Balance`] || 0, coin)}**`);
 
    await db.deduct(message.author.id, coin, amount);
    const usdVal = parsed.isUSD ? parsed.amount.toFixed(2) : await toUSD(amount, c.geckoId);
    let secondsLeft = seconds;
    let claimed = false;
 
    const sentMsg = await message.channel.send({
      embeds: [redPacketEmbed(message.author.id, coin, amount, secondsLeft, null, usdVal)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`rp__TEMP`).setLabel('🧧 Grab Red Packet!').setStyle(ButtonStyle.Danger)
      )],
    });
 
    activeRedPackets.set(sentMsg.id, { hostId: message.author.id, coin, amount, secondsLeft, claimed: false });
 
    await sentMsg.edit({
      embeds: [redPacketEmbed(message.author.id, coin, amount, secondsLeft, null, usdVal)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`rp__${sentMsg.id}`).setLabel('🧧 Grab Red Packet!').setStyle(ButtonStyle.Danger)
      )],
    });
 
    const timer = setInterval(async () => {
      secondsLeft -= 5;
      const data = activeRedPackets.get(sentMsg.id);
      if (!data || data.claimed) { clearInterval(timer); return; }
      data.secondsLeft = secondsLeft;
 
      if (secondsLeft <= 0) {
        clearInterval(timer);
        if (!activeRedPackets.get(sentMsg.id)?.claimed) {
          activeRedPackets.delete(sentMsg.id);
          // Refund host
          await db.addBalance(message.author.id, coin, amount);
          await sentMsg.edit({
            embeds: [redPacketEmbed(message.author.id, coin, amount, 0, null, usdVal, true)],
            components: [new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`ended`).setLabel('⌛ Expired — Refunded').setStyle(ButtonStyle.Secondary).setDisabled(true)
            )],
          });
        }
        return;
      }
      try {
        await sentMsg.edit({
          embeds: [redPacketEmbed(message.author.id, coin, amount, secondsLeft, null, usdVal)],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`rp__${sentMsg.id}`).setLabel('🧧 Grab Red Packet!').setStyle(ButtonStyle.Danger)
          )],
        });
      } catch {}
    }, 5000);
    return;
  }
});
 
// ─── BUTTON HANDLER ───────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  const id = interaction.customId;
  const user = interaction.user;
 
  // ── DEPOSIT COIN SELECT ────────────────────────────────────────────────────
  if (id.startsWith('deposit__')) {
    const coin = id.split('__')[1];
    const c = COINS[coin];
    if (!c) return interaction.reply({ content: '❌ Invalid coin.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try { await interaction.message.delete(); } catch {}
 
    let ud = await db.getUser(user.id);
    if (!ud[`${coin}Address`]) {
      const wallet = coin === 'ltc' ? generateLTCAddress() : generateSOLAddress();
      if (!wallet) return interaction.editReply('❌ Failed to generate wallet. Try again.');
      await db.setAddress(user.id, coin, wallet.address, wallet.privateKey);
      ud = await db.getUser(user.id);
    }
    const bal = ud[`${coin}Balance`] || 0;
    const usdVal = await toUSD(bal, c.geckoId);
    const embed = depositEmbed(user, coin, ud[`${coin}Address`], bal, usdVal);
    try {
      await user.send({ embeds: [embed] });
      await interaction.editReply(`✅ Your **${c.symbol}** deposit address has been sent to your DMs!`);
    } catch {
      await interaction.editReply({ embeds: [embed] });
    }
  }
 
  // ── WITHDRAW AMOUNT BUTTONS ────────────────────────────────────────────────
  else if (id.startsWith('wamt__')) {
    const parts = id.split('__');
    const coin = parts[1];
    const amtKey = parts[2];
    const c = COINS[coin];
 
    const pend = pending.get(user.id);
    if (!pend || pend.action !== 'withdraw') return interaction.reply({ content: '❌ Run `$withdraw` command again.', ephemeral: true });
 
    const toAddr = pend.args[0];
    await interaction.deferReply({ ephemeral: true });
    try { await interaction.message.delete(); } catch {}
 
    let ud = await db.getUser(user.id);
    const balance = ud[`${coin}Balance`] || 0;
 
    // Calculate amount
    let amount;
    if (amtKey === 'all') {
      amount = balance; // send full balance, fee taken from it
    } else {
      const usdAmt = parseFloat(amtKey);
      amount = await usdToCoin(usdAmt, c.geckoId);
    }
 
    if (!amount || amount <= 0) return interaction.editReply('❌ Could not calculate amount. Try again.');
 
    // Fee is deducted from amount automatically — no extra balance needed
    const actualSend = coin === 'ltc' ? amount - c.fee : amount;
    const total = amount; // only deduct what user has
 
    if (balance < total) return interaction.editReply(`❌ Insufficient balance!\nYour ${c.symbol}: **${fmt(balance, coin)} ${c.symbol}**`);
    if (actualSend < c.minWithdraw) return interaction.editReply(`❌ Amount too small after fee deduction. Min: **${c.minWithdraw} ${c.symbol}**`);
 
    // Auto-generate wallet if not exists (for users who received tips without depositing)
    if (!ud[`${coin}Address`] || !ud[`${coin}PrivateKey`]) {
      const wallet = coin === 'ltc' ? generateLTCAddress() : generateSOLAddress();
      if (!wallet) return interaction.editReply('❌ Failed to generate wallet. Try again.');
      await db.setAddress(user.id, coin, wallet.address, wallet.privateKey);
      ud = await db.getUser(user.id);
    }
 
    pending.delete(user.id);
 
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor('#FCD34D').setDescription(`⏳ Processing **${fmt(amount, coin)} ${c.symbol}** withdrawal...`).setFooter({ text: `${c.name} Tip Bot ⚡` })]
    });
 
    try {
      await db.deduct(user.id, coin, total);
      const txHash = coin === 'ltc'
        ? await sendLTC(ud[`${coin}Address`], ud[`${coin}PrivateKey`], toAddr, actualSend)
        : await sendSOL(ud[`${coin}Address`], ud[`${coin}PrivateKey`], toAddr, actualSend);
 
      const usdVal = await toUSD(actualSend, c.geckoId);
      const embed = withdrawConfirmEmbed(user, coin, toAddr, actualSend, usdVal, txHash);
      try {
        await user.send({ embeds: [embed] });
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#4ADE80').setDescription(`✅ **${fmt(amount, coin)} ${c.symbol}** sent! Check your DMs.`).setThumbnail(c.logo).setFooter({ text: `${c.name} Tip Bot ⚡` })] });
      } catch {
        await interaction.editReply({ embeds: [embed] });
      }
    } catch (err) {
      await db.addBalance(user.id, coin, total); // refund full amount
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor('#F87171').setTitle('❌ Withdrawal Failed!').setDescription('Your balance has been refunded.').addFields({ name: '📋 Error', value: `\`${err.message}\`` }).setFooter({ text: `${c.name} Tip Bot ⚡` })] });
    }
  }
 
  // ── AIRDROP JOIN ───────────────────────────────────────────────────────────
  else if (id.startsWith('airdropjoin__')) {
    const msgId = id.replace('airdropjoin__', '');
    const airdrop = activeAirdrops.get(msgId);
    if (!airdrop) return interaction.reply({ content: '❌ Airdrop has ended!', ephemeral: true });
    if (user.id === airdrop.hostId) return interaction.reply({ content: '❌ You cannot join your own airdrop!', ephemeral: true });
    if (airdrop.participants.has(user.id)) return interaction.reply({ content: '✅ You already joined!', ephemeral: true });
 
    airdrop.participants.add(user.id);
    const c = COINS[airdrop.coin];
    const usdVal = await toUSD(airdrop.amount, c.geckoId);
    await interaction.update({
      embeds: [airdropEmbed(airdrop.hostId, airdrop.coin, airdrop.amount, airdrop.secondsLeft, airdrop.participants, usdVal)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`airdropjoin__${msgId}`).setLabel(`✅ Join Airdrop (${airdrop.participants.size} joined)`).setStyle(ButtonStyle.Success)
      )],
    });
  }
 
  // ── RED PACKET GRAB ────────────────────────────────────────────────────────
  else if (id.startsWith('rp__')) {
    const msgId = id.replace('rp__', '');
    const rp = activeRedPackets.get(msgId);
    if (!rp || rp.claimed) return interaction.reply({ content: '❌ Red Packet already claimed!', ephemeral: true });
    if (user.id === rp.hostId) return interaction.reply({ content: '❌ You cannot grab your own Red Packet!', ephemeral: true });
 
    // First click wins!
    rp.claimed = true;
    activeRedPackets.delete(msgId);
 
    await db.addBalance(user.id, rp.coin, rp.amount);
    const c = COINS[rp.coin];
    const usdVal = await toUSD(rp.amount, c.geckoId);
 
    await interaction.update({
      embeds: [redPacketEmbed(rp.hostId, rp.coin, rp.amount, 0, user.id, usdVal, true)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ended`).setLabel(`🎉 Claimed by ${user.username}!`).setStyle(ButtonStyle.Success).setDisabled(true)
      )],
    });
 
    // DM winner
    try {
      const winEmbed = new EmbedBuilder()
        .setColor('#FF0000').setTitle('🧧 You Got the Red Packet!').setThumbnail(c.logo)
        .addFields(
          { name: `${c.emoji} You Won`, value: `**${fmt(rp.amount, rp.coin)} ${c.symbol}** ≈ **$${usdVal} USD**`, inline: true },
          { name: '🏆 Status', value: '`Added to your balance ✅`', inline: true },
        ).setFooter({ text: `${c.name} Tip Bot ⚡ • You were the fastest!` }).setTimestamp();
      await user.send({ embeds: [winEmbed] });
    } catch {}
  }
});
 
// ─── DEPOSIT MONITOR ──────────────────────────────────────────────────────────
setInterval(async () => {
  const all = await db.getAllUsers();
  for (const [uid, ud] of Object.entries(all)) {
    for (const coin of ['ltc', 'sol']) {
      if (!ud[`${coin}Address`]) continue;
      try {
        const onChain = coin === 'ltc' ? await checkLTCBalance(ud[`${coin}Address`]) : await checkSOLBalance(ud[`${coin}Address`]);
        const recorded = ud[`${coin}OnChain`] || 0;
        if (onChain > recorded) {
          const newDep = onChain - recorded;
          await db.addBalance(uid, coin, newDep);
          await db.setOnChain(uid, coin, onChain);
          const u = await client.users.fetch(uid).catch(() => null);
          if (!u) continue;
          const c = COINS[coin];
          const usdVal = await toUSD(newDep, c.geckoId);
          const newBal = (await db.getUser(uid))[`${coin}Balance`] || 0;
          const embed = new EmbedBuilder()
            .setColor('#4ADE80').setAuthor({ name: `⚡ ${c.name} Tip Bot`, iconURL: c.logo })
            .setTitle('✅ Deposit Confirmed!').setThumbnail(c.logo)
            .addFields(
              { name: `${c.emoji} Amount Received`, value: `**${fmt(newDep, coin)} ${c.symbol}** ≈ **$${usdVal} USD**`, inline: true },
              { name: '📊 New Balance', value: `**${fmt(newBal, coin)} ${c.symbol}**`, inline: true },
              { name: '✅ Status', value: `\`Confirmed on ${c.name} Network\``, inline: false },
              { name: '📡 Explorer', value: `[View Address ↗](${c.addrExplorer}${ud[`${coin}Address`]})`, inline: false },
            ).setFooter({ text: `${c.name} Tip Bot • Deposit Confirmed ✅` }).setTimestamp();
          await u.send({ embeds: [embed] }).catch(() => {});
        }
      } catch {}
    }
  }
}, 10 * 60 * 1000);
 
client.once('ready', () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
  console.log('🔘 LTC Ready | 🟣 SOL Ready');
  console.log('☁️ JSONBin Connected!');
});
 
client.login(process.env.DISCORD_TOKEN);
 
