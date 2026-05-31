require('dotenv').config();
 
const {
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');
const axios = require('axios');
const crypto = require('crypto');
const db = require('./database');
const config = require('./config');
const { sendLTC, sendTRX } = require('./transactions');
 
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: ['CHANNEL', 'MESSAGE'],
});
 
const COINS = {
  ltc: {
    name: 'Litecoin', symbol: 'LTC', emoji: '🔘', color: '#A8A9AD',
    logo: 'https://cryptologos.cc/logos/litecoin-ltc-logo.png',
    explorer: 'https://blockchair.com/litecoin/transaction/',
    addrExplorer: 'https://blockchair.com/litecoin/address/',
    geckoId: 'litecoin', fee: 0.0001, minTip: 0.001, minWithdraw: 0.001,
  },
  trx: {
    name: 'TRON', symbol: 'TRX', emoji: '🔴', color: '#FF060A',
    logo: 'https://cryptologos.cc/logos/tron-trx-logo.png',
    explorer: 'https://tronscan.org/#/transaction/',
    addrExplorer: 'https://tronscan.org/#/address/',
    geckoId: 'tron', fee: 0, minTip: 1, minWithdraw: 1,
  },
};
 
// ─── ADDRESS GENERATION ───────────────────────────────────────────────────────
function generateLTCAddress() {
  try {
    const bs58check = require('bs58check');
    const secp256k1 = require('secp256k1');
    const privateKeyBytes = crypto.randomBytes(32);
    const wifPrefix = Buffer.from([0xB0]);
    const wifPayload = Buffer.concat([wifPrefix, privateKeyBytes, Buffer.from([0x01])]);
    const wif = bs58check.encode(wifPayload);
    const pubKey = secp256k1.publicKeyCreate(privateKeyBytes, true);
    const sha256 = crypto.createHash('sha256').update(pubKey).digest();
    const ripemd160 = crypto.createHash('ripemd160').update(sha256).digest();
    const addressPayload = Buffer.concat([Buffer.from([0x30]), ripemd160]);
    const address = bs58check.encode(addressPayload);
    return { address, privateKey: wif };
  } catch (err) {
    console.error('LTC gen error:', err.message);
    return null;
  }
}
 
function generateTRXAddress() {
  try {
    const bs58check = require('bs58check');
    const secp256k1 = require('secp256k1');
    const { keccak256 } = require('ethereum-cryptography/keccak');
    const privateKeyBytes = crypto.randomBytes(32);
    const privateKeyHex = privateKeyBytes.toString('hex');
    const pubKey = secp256k1.publicKeyCreate(privateKeyBytes, false);
    const pubKeySliced = pubKey.slice(1);
    const hashed = keccak256(pubKeySliced);
    const addressBytes = hashed.slice(12);
    const tronPayload = Buffer.concat([Buffer.from([0x41]), addressBytes]);
    const address = bs58check.encode(tronPayload);
    return { address, privateKey: privateKeyHex };
  } catch (err) {
    console.error('TRX gen error:', err.message);
    return null;
  }
}
 
// ─── PRICE ────────────────────────────────────────────────────────────────────
async function getPrice(geckoId) {
  try {
    const res = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${geckoId}&vs_currencies=usd&include_24hr_change=true`,
      { timeout: 5000 }
    );
    return res.data[geckoId];
  } catch { return null; }
}
 
async function checkLTCBalance(address) {
  try {
    const res = await axios.get(`https://api.blockcypher.com/v1/ltc/main/addrs/${address}/balance`, { timeout: 5000 });
    return res.data.balance / 1e8;
  } catch { return 0; }
}
 
async function checkTRXBalance(address) {
  try {
    const res = await axios.get(`https://api.trongrid.io/v1/accounts/${address}`, { timeout: 5000 });
    const data = res.data.data?.[0];
    return data ? data.balance / 1e6 : 0;
  } catch { return 0; }
}
 
function fmt(amount, coin) {
  return coin === 'ltc' ? parseFloat(amount || 0).toFixed(8) : parseFloat(amount || 0).toFixed(2);
}
 
async function toUSD(amount, geckoId) {
  const p = await getPrice(geckoId);
  return p ? (amount * p.usd).toFixed(2) : '?';
}
 
const pending = new Map();
 
// ─── PARSE AMOUNT ────────────────────────────────────────────────────────────
// Returns { amount, isUSD }
// $1 or 1$ = USD mode, 0.5 = coin mode
function parseAmount(str) {
  if (!str) return { amount: NaN, isUSD: false };
  const s = str.toString().trim();
  const isUSD = s.includes('$');
  const amount = parseFloat(s.replace(/\$/g, '').trim());
  return { amount, isUSD };
}
 
// Convert USD to coin amount using live price
async function usdToCoin(usdAmount, geckoId) {
  const price = await getPrice(geckoId);
  if (!price || !price.usd) return null;
  return usdAmount / price.usd;
}
 
// ─── EMBEDS ───────────────────────────────────────────────────────────────────
function selectEmbed(action) {
  const label = { deposit: '💳 Deposit', withdraw: '📤 Withdraw', tip: '🎁 Tip', price: '💹 Price', airdrop: '🪂 Airdrop' }[action] || '⚡ Select';
  return new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle(`${label} — Select Your Coin`)
    .setDescription('Choose which coin you want to use:')
    .addFields(
      { name: '🔘 Litecoin (LTC)', value: '`Fee: 0.0001 LTC • Reliable Network`', inline: true },
      { name: '🔴 TRON (TRX)', value: '`Fee: ZERO ✅ • Ultra Fast`', inline: true },
    )
    .setFooter({ text: 'LTC & TRX Tip Bot ⚡' })
    .setTimestamp();
}
 
function selectRow(action) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${action}__ltc`).setLabel('🔘 Litecoin (LTC)').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${action}__trx`).setLabel('🔴 TRON (TRX)').setStyle(ButtonStyle.Danger),
  );
}
 
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
 
function withdrawEmbed(user, coin, toAddr, amount, usdVal, txHash) {
  const c = COINS[coin];
  return new EmbedBuilder()
    .setColor('#4ADE80')
    .setAuthor({ name: `⚡ ${c.name} Tip Bot`, iconURL: c.logo })
    .setTitle('✅ Withdrawal Confirmed!')
    .setThumbnail(c.logo)
    .addFields(
      { name: '📤 Amount Sent', value: `**${fmt(amount, coin)} ${c.symbol}** ≈ **$${usdVal} USD**`, inline: true },
      { name: '💸 Network Fee', value: c.fee === 0 ? '**FREE ✅**' : `**${c.fee} ${c.symbol}**`, inline: true },
      { name: '📬 Recipient Address', value: `\`${toAddr}\``, inline: false },
      { name: '🔗 Transaction', value: txHash ? `[\`${txHash.slice(0,20)}...\`](${c.explorer}${txHash})` : '`Processing...`', inline: false },
      { name: '📡 Explorer', value: `[View on Explorer ↗](${c.addrExplorer}${toAddr})`, inline: true },
      { name: '⏱️ Status', value: '`Broadcasted to Network ✅`', inline: true },
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
      { name: '💸 Network Fee', value: c.fee === 0 ? '**FREE ✅**' : `**${c.fee} ${c.symbol}**`, inline: true },
    )
    .setFooter({ text: `${c.name} Tip Bot ⚡ • Low & Zero Fees` })
    .setTimestamp();
}
 
function balEmbed(user, ltcBal, ltcUsd, trxBal, trxUsd) {
  return new EmbedBuilder()
    .setColor('#38BDF8')
    .setAuthor({ name: '⚡ Tip Bot', iconURL: COINS.ltc.logo })
    .setTitle('👛 Your Wallet Balance')
    .setThumbnail(COINS.ltc.logo)
    .addFields(
      { name: '🔘 Litecoin (LTC)', value: `**${fmt(ltcBal, 'ltc')} LTC**\n≈ **$${ltcUsd} USD**`, inline: true },
      { name: '🔴 TRON (TRX)', value: `**${fmt(trxBal, 'trx')} TRX**\n≈ **$${trxUsd} USD**`, inline: true },
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
 
function helpEmbed() {
  return new EmbedBuilder()
    .setColor('#A78BFA')
    .setAuthor({ name: '⚡ LTC & TRX Tip Bot', iconURL: COINS.ltc.logo })
    .setTitle('📖 Bot Commands')
    .setDescription('> Select your coin using the buttons after each command!')
    .addFields(
      { name: '💳 `$deposit`', value: 'Get your deposit address via DM', inline: false },
      { name: '📤 `$withdraw <address> <amount>`', value: 'Example: `$withdraw TAddr... 100`', inline: false },
      { name: '🎁 `$tip @user <amount>`', value: 'Example: `$tip @John 0.5`', inline: false },
      { name: '👛 `$bal` / `$bals`', value: 'Check your LTC & TRX balance', inline: false },
      { name: '💹 `$price`', value: 'Check live LTC or TRX price', inline: false },
      { name: '🪂 `$airdrop <amount> <seconds>`', value: 'Example: `$airdrop 1 30` — Drop coins to joiners!', inline: false },
      { name: '❓ `$help`', value: 'Show this help menu', inline: false },
      { name: '💡 Network Fees', value: '🔘 LTC: `0.0001 LTC` | 🔴 TRX: `FREE ✅`', inline: false },
    )
    .setFooter({ text: 'LTC & TRX Tip Bot ⚡ • Fast & Low Fees' })
    .setTimestamp();
}
 
 
// ─── ACTIVE AIRDROPS ─────────────────────────────────────────────────────────
const activeAirdrops = new Map();
 
function airdropEmbed(hostId, coin, amount, secondsLeft, participants, usdVal, ended = false) {
  const c = COINS[coin];
  const count = participants.size;
  const perPerson = count > 0
    ? (amount / count).toFixed(coin === 'ltc' ? 8 : 2)
    : fmt(amount, coin);
  return new EmbedBuilder()
    .setColor(ended ? '#4ADE80' : c.color)
    .setAuthor({ name: `⚡ ${c.name} Tip Bot`, iconURL: c.logo })
    .setTitle(ended ? '✅ Airdrop Ended!' : '🪂 Airdrop Is Live!')
    .setThumbnail(c.logo)
    .addFields(
      { name: '👤 Host', value: `<@${hostId}>`, inline: true },
      { name: `${c.emoji} Total`, value: `**${fmt(amount, coin)} ${c.symbol}** ≈ **$${usdVal} USD**`, inline: true },
      { name: '⏱️ Time Left', value: ended ? '`Ended`' : `**${secondsLeft}s**`, inline: true },
      { name: '👥 Participants', value: count > 0
        ? `**${count} joined** — Each gets **${perPerson} ${c.symbol}**`
        : '`Be the first to join!`', inline: false },
      { name: ended ? '🎉 Winners' : '📌 How to Join',
        value: ended
          ? (count > 0 ? [...participants].map(id => `<@${id}>`).join(' ') : '`Nobody joined!`')
          : '> Press **✅ Join Airdrop** below!',
        inline: false },
    )
    .setFooter({ text: ended ? `${c.name} Tip Bot • Airdrop Done!` : `${c.name} Tip Bot • Hurry up! ⚡` })
    .setTimestamp();
}
 
// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const args = message.content.trim().split(/\s+/);
  const cmd = args[0].toLowerCase();
  const isDM = message.channel.type === 1;
 
  if (cmd === '$help') return message.reply({ embeds: [helpEmbed()] });
 
  if (cmd === '$bal' || cmd === '$bals' || cmd === '$balance') {
    const u = message.author;
    const ud = await db.getUser(u.id);
    const [ltcUsd, trxUsd] = await Promise.all([
      toUSD(ud.ltcBalance || 0, 'litecoin'),
      toUSD(ud.trxBalance || 0, 'tron'),
    ]);
    const embed = balEmbed(u, ud.ltcBalance || 0, ltcUsd, ud.trxBalance || 0, trxUsd);
    return message.reply({ embeds: [embed] });
  }
 
  if (cmd === '$deposit') {
    pending.set(message.author.id, { action: 'deposit', args: [] });
    return message.reply({ embeds: [selectEmbed('deposit')], components: [selectRow('deposit')] });
  }
 
  if (cmd === '$price') {
    pending.set(message.author.id, { action: 'price', args: [] });
    return message.reply({ embeds: [selectEmbed('price')], components: [selectRow('price')] });
  }
 
  if (cmd === '$tip') {
    if (isDM) return message.reply('❌ Please use `$tip` in a server channel.');
    const mention = message.mentions.users.first();
    const parsed = parseAmount(args[2]);
    if (!mention || isNaN(parsed.amount) || parsed.amount <= 0)
      return message.reply('❌ Usage: `$tip @user <amount>`\nExample: `$tip @John $1` or `$tip @John 0.5`');
    if (mention.id === message.author.id) return message.reply('❌ You cannot tip yourself!');
    if (mention.bot) return message.reply('❌ You cannot tip a bot!');
    pending.set(message.author.id, { action: 'tip', args: [mention.id, parsed.amount, parsed.isUSD] });
    return message.reply({ embeds: [selectEmbed('tip')], components: [selectRow('tip')] });
  }
 
  if (cmd === '$withdraw') {
    const toAddr = args[1];
    const parsed = parseAmount(args[2]);
    if (!toAddr || isNaN(parsed.amount) || parsed.amount <= 0)
      return message.reply('❌ Usage: `$withdraw <address> <amount>`\nExample: `$withdraw LAddr... $1` or `$withdraw LAddr... 0.5`');
    pending.set(message.author.id, { action: 'withdraw', args: [toAddr, parsed.amount, parsed.isUSD] });
    return message.reply({ embeds: [selectEmbed('withdraw')], components: [selectRow('withdraw')] });
  }
 
  // $airdrop <amount> <seconds> — e.g. $airdrop 1 30
  if (cmd === '$airdrop') {
    if (isDM) return message.reply('❌ Use `$airdrop` in a server channel.');
    const parsed = parseAmount(args[1]);
    const seconds = parseInt(args[2]?.replace(/\$/g, ''));
 
    if (isNaN(parsed.amount) || parsed.amount <= 0)
      return message.reply('❌ Usage: `$airdrop <amount> <seconds>`\nExample: `$airdrop $1 30` or `$airdrop 0.5 30`');
    if (isNaN(seconds) || seconds < 5 || seconds > 300)
      return message.reply('❌ Time must be between **5** and **300** seconds.');
 
    pending.set(message.author.id, { action: 'airdrop', args: [parsed.amount, seconds, parsed.isUSD] });
    return message.reply({ embeds: [selectEmbed('airdrop')], components: [selectRow('airdrop')] });
  }
 
});
 
// ─── BUTTON HANDLER ───────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  const parts = interaction.customId.split('__');
  const action = parts[0];
  const coin = parts[1];
  const c = COINS[coin];
  const user = interaction.user;
 
  if (!c) return interaction.reply({ content: '❌ Invalid coin selected.', ephemeral: true });
 
  const pend = pending.get(user.id);
  if (!pend || pend.action !== action)
    return interaction.reply({ content: '❌ Please run the command again.', ephemeral: true });
 
  pending.delete(user.id);
  try { await interaction.message.delete(); } catch {}
  await interaction.deferReply({ ephemeral: false });
 
 
  // ── AIRDROP ────────────────────────────────────────────────────────────────
  if (action === 'airdrop') {
    const [rawAmount, seconds, isUSD] = pend.args;
    const balKey = `${coin}Balance`;
    const c = COINS[coin];
 
    // Convert USD to coin if needed
    let amount = rawAmount;
    if (isUSD) {
      const converted = await usdToCoin(rawAmount, c.geckoId);
      if (!converted) return interaction.editReply('❌ Could not fetch price. Try again.');
      amount = converted;
    }
 
    // Check balance
    const ud = await db.getUser(user.id);
    if ((ud[balKey] || 0) < amount)
      return interaction.editReply(`❌ Insufficient balance!\nYour ${c.symbol}: **${fmt(ud[balKey] || 0, coin)}**\n${isUSD ? `($${rawAmount} = ${fmt(amount, coin)} ${c.symbol})` : ''}`);
 
    // Deduct from host
    await db.deduct(user.id, coin, amount);
    const usdVal = await toUSD(amount, c.geckoId);
 
    const participants = new Set();
    let secondsLeft = seconds;
 
    // Join button
    const joinRow = () => new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`airdropjoin__${airdropMsgId}`)
        .setLabel(`✅ Join Airdrop (${participants.size} joined)`)
        .setStyle(ButtonStyle.Success)
    );
 
    // Send airdrop message
    const airdropMsg = await interaction.editReply({
      embeds: [airdropEmbed(user.id, coin, amount, secondsLeft, participants, usdVal)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`airdropjoin__PLACEHOLDER`)
          .setLabel(`✅ Join Airdrop (0 joined)`)
          .setStyle(ButtonStyle.Success)
      )],
    });
 
    // Get the real message
    const realMsg = await interaction.fetchReply();
    const airdropMsgId = realMsg.id;
 
    // Store in active airdrops
    activeAirdrops.set(airdropMsgId, {
      hostId: user.id, coin, amount, secondsLeft, participants,
    });
 
    // Update button with real ID
    await realMsg.edit({
      embeds: [airdropEmbed(user.id, coin, amount, secondsLeft, participants, usdVal)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`airdropjoin__${airdropMsgId}`)
          .setLabel(`✅ Join Airdrop (0 joined)`)
          .setStyle(ButtonStyle.Success)
      )],
    });
 
    // Countdown timer
    const timer = setInterval(async () => {
      secondsLeft -= 5;
      const airdropData = activeAirdrops.get(airdropMsgId);
      if (!airdropData) { clearInterval(timer); return; }
      airdropData.secondsLeft = secondsLeft;
 
      if (secondsLeft <= 0) {
        clearInterval(timer);
        activeAirdrops.delete(airdropMsgId);
 
        // Distribute to participants
        const count = participants.size;
        if (count > 0) {
          const perPerson = amount / count;
          for (const pid of participants) {
            await db.addBalance(pid, coin, perPerson);
          }
        } else {
          // No one joined — refund host
          await db.addBalance(user.id, coin, amount);
        }
 
        const finalUsd = await toUSD(amount, c.geckoId);
        // End embed — disable button
        await realMsg.edit({
          embeds: [airdropEmbed(user.id, coin, amount, 0, participants, finalUsd, true)],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`airdropjoin__ended`)
              .setLabel(`🔒 Airdrop Ended`)
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(true)
          )],
        });
 
        // DM winners
        if (count > 0) {
          const perPerson = amount / count;
          for (const pid of participants) {
            const winner = await client.users.fetch(pid).catch(() => null);
            if (!winner) continue;
            const winEmbed = new EmbedBuilder()
              .setColor('#4ADE80')
              .setTitle('🎉 You Won an Airdrop!')
              .setThumbnail(c.logo)
              .addFields(
                { name: `${c.emoji} You Received`, value: `**${fmt(perPerson, coin)} ${c.symbol}** ≈ **$${(perPerson * (await getPrice(c.geckoId))?.usd || 0).toFixed(2)} USD**`, inline: true },
                { name: '👥 Total Winners', value: `**${count}**`, inline: true },
              )
              .setFooter({ text: `${c.name} Tip Bot ⚡ • Airdrop Won!` })
              .setTimestamp();
            await winner.send({ embeds: [winEmbed] }).catch(() => {});
          }
        }
        return;
      }
 
      // Update countdown every 5 seconds
      try {
        await realMsg.edit({
          embeds: [airdropEmbed(user.id, coin, amount, secondsLeft, participants, usdVal)],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`airdropjoin__${airdropMsgId}`)
              .setLabel(`✅ Join Airdrop (${participants.size} joined)`)
              .setStyle(ButtonStyle.Success)
          )],
        });
      } catch {}
    }, 5000);
  }
 
  // DEPOSIT
  if (action === 'deposit') {
    let ud = await db.getUser(user.id);
    const addrKey = `${coin}Address`;
    if (!ud[addrKey]) {
      const wallet = coin === 'ltc' ? generateLTCAddress() : generateTRXAddress();
      if (!wallet) return interaction.editReply('❌ Failed to generate wallet. Please try again.');
      await db.setAddress(user.id, coin, wallet.address, wallet.privateKey);
      ud = await db.getUser(user.id);
    }
    const bal = ud[`${coin}Balance`] || 0;
    const usdVal = await toUSD(bal, c.geckoId);
    const embed = depositEmbed(user, coin, ud[addrKey], bal, usdVal);
    try {
      await user.send({ embeds: [embed] });
      await interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(c.color)
          .setDescription(`✅ <@${user.id}> Your **${c.symbol}** deposit address has been sent to your DMs!`)
          .setThumbnail(c.logo)
          .setFooter({ text: `${c.name} Tip Bot ⚡` })
        ]
      });
    } catch {
      await interaction.editReply({ embeds: [embed] });
    }
  }
 
  // PRICE
  else if (action === 'price') {
    const price = await getPrice(c.geckoId);
    if (!price) return interaction.editReply('❌ Could not fetch price. Please try again later.');
    await interaction.editReply({ embeds: [priceEmbed(coin, price)] });
  }
 
  // TIP
  else if (action === 'tip') {
    const [receiverId, rawAmount, isUSD] = pend.args;
    const balKey = `${coin}Balance`;
 
    // Convert USD to coin if needed
    let amount = rawAmount;
    if (isUSD) {
      const converted = await usdToCoin(rawAmount, c.geckoId);
      if (!converted) return interaction.editReply('❌ Could not fetch price. Try again.');
      amount = converted;
    }
 
    if (amount < c.minTip) return interaction.editReply(`❌ Minimum tip is **${c.minTip} ${c.symbol}** ≈ **$${(c.minTip * ((await getPrice(c.geckoId))?.usd||0)).toFixed(2)}**`);
    const ud = await db.getUser(user.id);
    if ((ud[balKey] || 0) < amount)
      return interaction.editReply(`❌ Insufficient balance!\nYour ${c.symbol}: **${fmt(ud[balKey] || 0, coin)}**\n${isUSD ? `($${rawAmount} = ${fmt(amount, coin)} ${c.symbol})` : ''}`);
    await db.transfer(user.id, receiverId, coin, amount);
    const usdVal = isUSD ? rawAmount.toFixed(2) : await toUSD(amount, c.geckoId);
    const receiver = await client.users.fetch(receiverId).catch(() => null);
    await interaction.editReply({ embeds: [tipEmbed(user, receiver || { id: receiverId }, coin, amount, usdVal)] });
    if (receiver) {
      const dmEmbed = new EmbedBuilder()
        .setColor('#FCD34D')
        .setTitle('🎉 You Received a Tip!')
        .setThumbnail(c.logo)
        .addFields(
          { name: '👤 From', value: `**${user.tag}**`, inline: true },
          { name: `${c.emoji} Amount`, value: `**${fmt(amount, coin)} ${c.symbol}** ≈ **$${usdVal} USD**`, inline: true },
          { name: '💡 Tip', value: 'Type `$bal` to check your balance!', inline: false },
        )
        .setFooter({ text: `${c.name} Tip Bot ⚡` })
        .setTimestamp();
      await receiver.send({ embeds: [dmEmbed] }).catch(() => {});
    }
  }
 
  // WITHDRAW — REAL ON-CHAIN TRANSACTION
  else if (action === 'withdraw') {
    const [toAddr, rawAmount, isUSD] = pend.args;
    const balKey = `${coin}Balance`;
    const privKey = `${coin}PrivateKey`;
    const addrKey = `${coin}Address`;
 
    // Convert USD to coin if needed
    let amount = rawAmount;
    if (isUSD) {
      const converted = await usdToCoin(rawAmount, c.geckoId);
      if (!converted) return interaction.editReply('❌ Could not fetch price. Try again.');
      amount = converted;
    }
 
    const total = amount + c.fee;
 
    if (amount < c.minWithdraw)
      return interaction.editReply(`❌ Minimum withdrawal is **${c.minWithdraw} ${c.symbol}**${isUSD ? ` ≈ **$${(c.minWithdraw * ((await getPrice(c.geckoId))?.usd||0)).toFixed(2)}**` : ''}`);
 
    const ud = await db.getUser(user.id);
 
    if ((ud[balKey] || 0) < total)
      return interaction.editReply(
        `❌ Insufficient balance!\nRequired: **${fmt(total, coin)} ${c.symbol}**\nYour balance: **${fmt(ud[balKey] || 0, coin)} ${c.symbol}**`
      );
 
    if (!ud[addrKey] || !ud[privKey])
      return interaction.editReply('❌ No wallet found. Please use `$deposit` first.');
 
    // Show processing message
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor('#FCD34D')
        .setDescription(`⏳ Processing your **${c.symbol}** withdrawal... Please wait.`)
        .setFooter({ text: `${c.name} Tip Bot ⚡` })
      ]
    });
 
    try {
      // Deduct balance first
      await db.deduct(user.id, coin, total);
 
      // Send real on-chain transaction
      let txHash;
      if (coin === 'ltc') {
        txHash = await sendLTC(ud[addrKey], ud[privKey], toAddr, amount);
      } else {
        txHash = await sendTRX(ud[addrKey], ud[privKey], toAddr, amount);
      }
 
      const usdVal = await toUSD(amount, c.geckoId);
      const embed = withdrawEmbed(user, coin, toAddr, amount, usdVal, txHash);
 
      // DM user confirmation
      try {
        await user.send({ embeds: [embed] });
        await interaction.editReply({
          embeds: [new EmbedBuilder()
            .setColor('#4ADE80')
            .setDescription(`✅ <@${user.id}> **${fmt(amount, coin)} ${c.symbol}** sent successfully! Check your DMs for details.`)
            .setThumbnail(c.logo)
            .setFooter({ text: `${c.name} Tip Bot ⚡` })
          ]
        });
      } catch {
        await interaction.editReply({ embeds: [embed] });
      }
 
    } catch (err) {
      // Refund if transaction failed
      await db.addBalance(user.id, coin, total);
      console.error(`Withdraw error [${coin}]:`, err.message);
      await interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor('#F87171')
          .setTitle('❌ Withdrawal Failed!')
          .setDescription('Transaction could not be sent. Your balance has been refunded.')
          .addFields({ name: '📋 Error', value: `\`${err.message}\``, inline: false })
          .setFooter({ text: `${c.name} Tip Bot ⚡` })
        ]
      });
    }
  }
});
 
// ─── DEPOSIT MONITOR ──────────────────────────────────────────────────────────
setInterval(async () => {
  const all = await db.getAllUsers();
  for (const [uid, ud] of Object.entries(all)) {
    for (const coin of ['ltc', 'trx']) {
      if (!ud[`${coin}Address`]) continue;
      try {
        const onChain = coin === 'ltc'
          ? await checkLTCBalance(ud[`${coin}Address`])
          : await checkTRXBalance(ud[`${coin}Address`]);
        const recorded = ud[`${coin}OnChain`] || 0;
        if (onChain > recorded) {
          const newDep = onChain - recorded;
          await db.addBalance(uid, coin, newDep);
          await db.setOnChain(uid, coin, onChain);
          const user = await client.users.fetch(uid).catch(() => null);
          if (!user) continue;
          const c = COINS[coin];
          const usdVal = await toUSD(newDep, c.geckoId);
          const freshUd = await db.getUser(uid);
          const newBal = freshUd[`${coin}Balance`] || 0;
          const embed = new EmbedBuilder()
            .setColor('#4ADE80')
            .setAuthor({ name: `⚡ ${c.name} Tip Bot`, iconURL: c.logo })
            .setTitle('✅ Deposit Confirmed!')
            .setThumbnail(c.logo)
            .addFields(
              { name: `${c.emoji} Amount Received`, value: `**${fmt(newDep, coin)} ${c.symbol}** ≈ **$${usdVal} USD**`, inline: true },
              { name: '📊 New Balance', value: `**${fmt(newBal, coin)} ${c.symbol}**`, inline: true },
              { name: '✅ Status', value: `\`Confirmed on ${c.name} Network\``, inline: false },
              { name: '📡 Explorer', value: `[View Address ↗](${c.addrExplorer}${ud[`${coin}Address`]})`, inline: false },
            )
            .setFooter({ text: `${c.name} Tip Bot • Deposit Confirmed ✅` })
            .setTimestamp();
          await user.send({ embeds: [embed] }).catch(() => {});
        }
      } catch {}
    }
  }
}, 10 * 60 * 1000);
 
client.once('ready', () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
  console.log('🔘 LTC Ready | 🔴 TRX Ready');
  console.log('☁️ JSONBin Database Connected!');
});
 
client.login(config.DISCORD_TOKEN);
 
// ─── AIRDROP JOIN BUTTON HANDLER ─────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('airdropjoin__')) return;
 
  const messageId = interaction.customId.replace('airdropjoin__', '');
  const airdrop = activeAirdrops.get(messageId);
 
  if (!airdrop) return interaction.reply({ content: '❌ Airdrop has ended!', ephemeral: true });
 
  const user = interaction.user;
  if (user.id === airdrop.hostId) return interaction.reply({ content: '❌ You cannot join your own airdrop!', ephemeral: true });
  if (airdrop.participants.has(user.id)) return interaction.reply({ content: '✅ You already joined!', ephemeral: true });
 
  airdrop.participants.add(user.id);
  const c = COINS[airdrop.coin];
  const usdVal = await toUSD(airdrop.amount, c.geckoId);
 
  await interaction.update({
    embeds: [airdropEmbed(airdrop.hostId, airdrop.coin, airdrop.amount, airdrop.secondsLeft, airdrop.participants, usdVal)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`airdropjoin__${messageId}`)
        .setLabel(`✅ Join Airdrop (${airdrop.participants.size} joined)`)
        .setStyle(ButtonStyle.Success)
    )],
  });
});
 
